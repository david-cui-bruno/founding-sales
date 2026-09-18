import { useEffect, useState } from 'react';
import type { DailySnapshot } from '../../../shared/contracts/dailyContract';
import { researchSetupStatusSchema, type ResearchSetupApi, type ResearchSetupStatus } from '../../../shared/contracts/researchSetupContract';
import { DEFAULT_NEW_CALL_SLOTS_COPY } from './todayCopy';

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

/** "just now", "2 min ago", "3 h ago", "2 d ago". Relative to `now`, never a future word. */
export function describeAgo(instant: string, now: number): string {
  const at = Date.parse(instant);
  if (!Number.isFinite(at)) return 'at an unknown time';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** The latest stored transport attempt for this workspace, as the daily read persists it. Not current connectivity. */
export function describeSync(snapshot: Pick<DailySnapshot, 'workspaceId' | 'transport'>, now: number): string {
  if (snapshot.workspaceId === null || snapshot.transport.length === 0) return 'Local snapshot · remote freshness unknown';
  const latest = [...snapshot.transport].sort((a, b) => b.revision - a.revision)[0]!;
  if (latest.state === 'complete' && latest.completedAt) return `Synced ${describeAgo(latest.completedAt, now)}`;
  if (latest.state === 'pending') return `Sync in progress (started ${describeAgo(latest.startedAt, now)})`;
  return `Sync failed (attempted ${describeAgo(latest.startedAt, now)}) · showing local records`;
}

/** `lastTickAt` arrives with the worker-visibility lane; until then, and whenever it is absent or malformed, the honest word is unknown. */
export function describeWorkerTick(status: ResearchSetupStatus | null, now: number): string {
  const tick = (status?.remote as { lastTickAt?: unknown } | null | undefined)?.lastTickAt;
  return typeof tick === 'string' && INSTANT.test(tick) ? `worker last ran ${describeAgo(tick, now)}` : 'worker last ran unknown';
}

export function describeDiscoverySpend(status: ResearchSetupStatus | null): string {
  const ledger = status?.remote?.discoveryLedger;
  if (!ledger) return 'discovery spend unknown';
  const usd = (micros: number) => (micros / 1_000_000).toFixed(2);
  return `discovery USD ${usd(ledger.reservedOrSpentMicros)} of ${usd(ledger.limitMicros)}`;
}

/**
 * The one footer line: "Synced 2 min ago · worker last ran 3 min ago · discovery USD 0.35 of 5.00".
 * Sync freshness comes from the stored transport record in the daily snapshot; the worker tick and the
 * spend come from the research setup status, read once per completed sync so the footer never polls.
 */
export function TodayFooter({ snapshot, readError, researchSetup, now = () => Date.now() }: {
  snapshot: DailySnapshot; readError: boolean; researchSetup?: Pick<ResearchSetupApi, 'status'>; now?: () => number;
}) {
  const [status, setStatus] = useState<ResearchSetupStatus | null>(null);
  const latestSync = [...snapshot.transport].sort((a, b) => b.revision - a.revision)[0];
  const syncKey = latestSync ? `${latestSync.revision}:${latestSync.state}:${latestSync.completedAt ?? ''}` : '';
  const paired = snapshot.workspaceId !== null;
  useEffect(() => {
    if (!researchSetup || !paired || readError) { setStatus(null); return; }
    let alive = true;
    void Promise.resolve().then(() => researchSetup.status()).then(raw => {
      if (alive) setStatus(researchSetupStatusSchema.parse(raw));
    }).catch(() => { if (alive) setStatus(null); });
    return () => { alive = false; };
    // Re-read after each stored sync attempt changes; a refresh of the same snapshot does not re-read.
  }, [researchSetup, paired, readError, syncKey]);
  const at = now();
  const line = readError
    ? 'Refresh unavailable. Your current view and edits are retained.'
    : paired
      ? `${describeSync(snapshot, at)} · ${describeWorkerTick(status, at)} · ${describeDiscoverySpend(status)}`
      : describeSync(snapshot, at);
  return <footer className="native-desk__footer">
    <span role="status">{line}</span>
    <details>
      <summary>Queue capacity and operational details</summary>
      <p>
        New-call slots:{' '}
        {snapshot.callSettings.newCallSlots ?? 'unconfigured'}{snapshot.callSettings.source === 'default' ? ` (${DEFAULT_NEW_CALL_SLOTS_COPY})` : ''} · total call
        capacity:{' '}
        {snapshot.callSettings.totalCallCapacity ?? 'unconfigured'}.
        Allocation is not completed-call progress.
      </p>
      {snapshot.calls.workloadConflict && (
        <p>Workload conflict needs review.</p>
      )}
      {snapshot.issues.map((i) => (
        <p key={i.code}>
          {i.code.replaceAll('_', ' ')}: {i.count}
        </p>
      ))}
    </details>
  </footer>;
}
