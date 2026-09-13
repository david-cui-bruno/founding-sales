import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import type { CalliePreloadApi } from '../../shared/preload';
import {
  configureLocalDelegationSchema, delegationSyncReportSchema,
  localDelegationConfigurationRecordSchema, localDelegationStatusSchema,
} from '../../shared/contracts/ownerCommandContract';

type Api = Pick<CalliePreloadApi['delegation'], 'status' | 'configure' | 'sync'>;
type Status = z.infer<typeof localDelegationStatusSchema>;
type Report = z.infer<typeof delegationSyncReportSchema>;
type Lifetime = { api: Api; busy: boolean; status: Status | null; acknowledged: Status | null };
type View = { owner: Lifetime | null; status: Status | null; busy: boolean; acknowledged: boolean; message: string; failed: boolean; report: Report | null };
const empty = (owner: Lifetime | null): View => ({ owner, status: null, busy: false, acknowledged: false, message: '', failed: false, report: null });
const equal = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>; const right = b as Record<string, unknown>;
  return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => Object.hasOwn(right, key) && equal(left[key], right[key]));
};
function parseStatus(raw: Status): Status {
  const status = localDelegationStatusSchema.parse(raw);
  // Research schemas can trim audience strings. A state-only toggle must never do that.
  if (!equal(raw.configuration, status.configuration)) throw Error('Configuration requires exact preservation');
  return status;
}
const paired = (status: Status | null) => !!status?.workspaceId && !!status.endpoint && status.state !== 'locked' && status.state !== 'unconfigured';
// The public schema permits contradictory outer/inner states. Do not choose one as authority.
const configurable = (status: Status | null) => paired(status) && !!status &&
  (!status.configuration || status.state === status.configuration.configuration.state) &&
  (!status.configuration?.configuration.research || status.configuration.configuration.research.workspaceId === status.workspaceId) &&
  (status.configuration?.revision ?? 0) < Number.MAX_SAFE_INTEGER;
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

/** Local configuration is not remote worker authority. All transport work is explicit and serialized. */
export function WorkspaceAccessSection({ api, onChanged }: { api?: Api; onChanged?: () => void | Promise<void> }) {
  const changed = useRef(onChanged);
  useLayoutEffect(() => { changed.current = onChanged; });
  const owner = useRef<Lifetime | null>(null);
  const [view, setView] = useState<View>(() => empty(null));
  const current = useCallback((lifetime: Lifetime) => owner.current === lifetime, []);
  const notifyChanged = useCallback((lifetime: Lifetime) => {
    if (!current(lifetime)) return;
    // Presentation refresh failure cannot turn a verified transport result into an unknown write.
    void (async () => { try { await changed.current?.(); } catch { /* No retry or command. */ } })();
  }, [current]);
  const publishStatus = useCallback((lifetime: Lifetime, status: Status | null) => {
    lifetime.status = status;
    lifetime.acknowledged = null;
    setView(previous => ({ ...previous, status, acknowledged: false }));
  }, []);
  const read = useCallback(async (lifetime: Lifetime) => {
    publishStatus(lifetime, null);
    try {
      const raw = await (async () => lifetime.api.status())();
      if (!current(lifetime)) return;
      publishStatus(lifetime, parseStatus(raw));
      return true;
    } catch {
      if (current(lifetime)) setView(previous => ({ ...previous, failed: true, message: 'Setup status could not be read. Refresh setup status before another action.' }));
    }
  }, [current, publishStatus]);
  const run = useCallback(async (lifetime: Lifetime, action: 'refresh' | 'configure' | 'sync') => {
    if (!current(lifetime) || lifetime.busy) return;
    const acknowledged = lifetime.acknowledged;
    if (action === 'configure' && (!acknowledged || !configurable(lifetime.status) || !equal(acknowledged, lifetime.status))) return;
    if (action === 'sync' && !paired(lifetime.status)) return;
    lifetime.busy = true;
    lifetime.acknowledged = null;
    setView(previous => ({ ...previous, busy: true, acknowledged: false, message: '', failed: false, report: null }));
    try {
      if (action === 'refresh') { await read(lifetime); return; }
      if (action === 'sync') {
        const raw = await (async () => lifetime.api.sync())();
        if (!current(lifetime)) return;
        const report = delegationSyncReportSchema.parse(raw);
        setView(previous => ({ ...previous, report }));
        notifyChanged(lifetime);
        return;
      }
      const raw = await (async () => lifetime.api.status())();
      if (!current(lifetime)) return;
      const fresh = parseStatus(raw);
      publishStatus(lifetime, fresh);
      if (!equal(fresh, acknowledged) || !configurable(fresh)) {
        setView(previous => ({ ...previous, failed: true, message: 'Setup changed since your acknowledgement. Review the current state and acknowledge again. No configuration was submitted.' }));
        return;
      }
      const request = freeze(configureLocalDelegationSchema.parse({
        expectedRevision: fresh.configuration?.revision ?? 0,
        configuration: {
          version: 1,
          state: fresh.configuration?.configuration.state === 'active' ? 'paused' : 'active',
          research: fresh.configuration?.configuration.research ?? null,
        },
      }));
      const result = await (async () => lifetime.api.configure(request))();
      if (!current(lifetime)) return;
      const receipt = localDelegationConfigurationRecordSchema.parse(result);
      if (!equal(result, receipt) || receipt.revision !== request.expectedRevision + 1 || !equal(receipt.configuration, request.configuration)) throw Error('Unverified receipt');
      setView(previous => ({ ...previous, message: 'Local configuration saved. Reading current setup status. This does not establish remote worker authority.' }));
      if (await read(lifetime)) notifyChanged(lifetime);
    } catch {
      if (!current(lifetime)) return;
      publishStatus(lifetime, null);
      setView(previous => ({ ...previous, failed: true, message: action === 'sync'
        ? 'Sync outcome unknown. Previously queued approved commands may have been submitted. Refresh setup status before a fresh explicit attempt.'
        : 'Configuration outcome could not be verified. Local storage may have changed. Refresh setup status before a fresh acknowledgement and explicit attempt.' }));
    } finally {
      if (current(lifetime)) {
        lifetime.busy = false;
        setView(previous => ({ ...previous, busy: false }));
      }
    }
  }, [current, notifyChanged, publishStatus, read]);
  useLayoutEffect(() => {
    const lifetime: Lifetime | null = api ? { api, busy: false, status: null, acknowledged: null } : null;
    owner.current = lifetime;
    setView(empty(lifetime));
    if (lifetime) void run(lifetime, 'refresh');
    return () => { owner.current = null; };
  }, [api, run]);

  const lifetime = owner.current;
  const visible = lifetime && lifetime.api === api && view.owner === lifetime ? view : empty(null);
  const busy = !visible.owner || visible.busy;
  const canConfigure = !busy && configurable(visible.status);
  const configuration = visible.status?.configuration;
  return <section className="settings__section workspace-access" aria-label="Workspace access">
    <h2 className="settings__section-title">Workspace access</h2>
    <p role="status">{visible.status ? `Local setup: ${visible.status.state}` : visible.busy ? 'Checking setup status…' : 'Setup status unavailable'}</p>
    {visible.status && <dl className="settings__counters">
      <div className="settings__counter"><dt>Workspace</dt><dd>{visible.status.workspaceId ?? 'Not connected'}</dd></div>
      <div className="settings__counter"><dt>Endpoint</dt><dd>{visible.status.endpoint ?? 'Not connected'}</dd></div>
      <div className="settings__counter"><dt>Local configuration</dt><dd>{configuration ? `${configuration.configuration.state}, revision ${configuration.revision}` : 'Not configured'}</dd></div>
    </dl>}
    <p>These controls change local configuration only. They do not deploy or activate a remote worker, or revoke its authority. Cloud work may continue when this Mac is locally paused.</p>
    <p>No new approval, owner authority, budget or send permissions are granted. Existing research policy is preserved exactly, not created or reset.</p>
    {visible.status && !paired(visible.status) && <p>Finish the worker connection before continuing. If you just paired, restart the application normally, then refresh setup status. A locked connection must be resolved first.</p>}
    {paired(visible.status) && !configurable(visible.status) && <p>Setup facts do not safely agree for a configuration change. Refresh and resolve the current setup before continuing.</p>}
    <label className="settings__row"><input type="checkbox" checked={visible.acknowledged} disabled={!canConfigure} onChange={event => {
      if (!lifetime || !current(lifetime) || lifetime.busy || !configurable(lifetime.status)) return;
      lifetime.acknowledged = event.target.checked ? lifetime.status : null;
      setView(previous => ({ ...previous, acknowledged: event.target.checked }));
    }} />I understand this changes only this Mac's local configuration, not remote worker authority.</label>
    <div className="settings__row-actions">
      {configurable(visible.status) && <button type="button" className="settings__action" disabled={!canConfigure || !visible.acknowledged} onClick={() => { if (lifetime) void run(lifetime, 'configure'); }}>
        {configuration?.configuration.state === 'active' ? 'Pause cloud work on this Mac' : 'Enable this Mac for cloud work'}
      </button>}
      <button type="button" className="settings__action" disabled={busy} onClick={() => { if (lifetime) void run(lifetime, 'refresh'); }}>Refresh setup status</button>
    </div>
    <p>Sync saved cloud work is not read-only. It may submit or reconcile previously queued approved commands. It does not create new approvals or permissions.</p>
    <button type="button" className="settings__action" disabled={busy || !paired(visible.status)} onClick={() => { if (lifetime) void run(lifetime, 'sync'); }}>Sync saved cloud work</button>
    {visible.report && <p role={visible.report.ownerFresh && visible.report.gaps === 0 ? 'status' : 'alert'}>{visible.report.ownerFresh && visible.report.gaps === 0 ? 'Last sync report: owner events fresh.' : 'Saved cloud work sync is incomplete.'} Applied: {visible.report.applied}. Gaps: {visible.report.gaps}. Owner fresh: {visible.report.ownerFresh ? 'yes' : 'no'}. Queued commands may remain unresolved even when owner events are fresh. This is a report from the last explicit sync, not ongoing health or confirmation that all saved cloud work completed.</p>}
    {visible.message && <p role={visible.failed ? 'alert' : 'status'}>{visible.message}</p>}
  </section>;
}
