import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import type { CalliePreloadApi } from '../../shared/preload';
import {
  localDelegationStatusSchema,
  redeemedLocalPairingSchema,
  redeemLocalPairingSchema,
  rotateLocalPairingSchema,
  rotatedLocalPairingSchema,
  storedPairingSummarySchema,
} from '../../shared/contracts/ownerCommandContract';
import { researchSetupStatusSchema, WORKER_STALE_AFTER_MS, type ResearchSetupApi } from '../../shared/contracts/researchSetupContract';
import { remoteGoogleGrantStatusSchema } from '../../shared/contracts/remoteGoogleGrantContract';
import type { RemoteGoogleConnectionsApi } from '../../shared/contracts/remoteGoogleConnectionsContract';
import type { SenderCapStatus } from '../../shared/contracts/workerPolicyContract';

/** The worker's last scheduled tick travels on the cloud research status and today's sender cap on the
 * cloud grant status; the section reads each one when that namespace is present. */
type Api = Pick<CalliePreloadApi['delegation'], 'status' | 'pair'> & { researchSetup?: Pick<ResearchSetupApi, 'status'>;
  googleConnections?: Pick<RemoteGoogleConnectionsApi, 'status'> } & Partial<Pick<CalliePreloadApi['delegation'], 'pairing' | 'rotatePairing'>>;
type Status = z.infer<typeof localDelegationStatusSchema>;
type Receipt = z.infer<typeof redeemedLocalPairingSchema>;
type Request = z.infer<typeof redeemLocalPairingSchema>;
type Summary = z.infer<typeof storedPairingSummarySchema>;
type Rotated = z.infer<typeof rotatedLocalPairingSchema>;
type Lifetime = { api: Api; generation: number; busy: boolean; status: Status | null; summary: Summary | null };
/** `unread` before any read or when the cloud status could not be read; `null` when the worker has never recorded a tick. */
type LastTick = { state: 'unread' } | { state: 'read'; at: string | null };
/** `unread` before any read or when the cloud grant status could not be read; `null` when the worker
 * records no cap policy for the granted mailbox. Never a fabricated default. */
type SenderCap = { state: 'unread' } | { state: 'read'; cap: SenderCapStatus | null };
/** The stored pairing's identity, generation and scopes as the main process read them from disk on the last local
 * read: `unread` when that read failed or the bridge has no pairing read; `null` when no pairing is stored. */
type Stored = { state: 'unread' } | { state: 'read'; summary: Summary | null };
type View = {
  owner: Lifetime | null;
  status: Status | null;
  receipt: Receipt | null;
  busy: boolean;
  statusError: boolean;
  pairError: string | null;
  endpoint: string;
  expectedWorkspaceId: string;
  code: string;
  lastTick: LastTick;
  senderCap: SenderCap;
  stored: Stored;
  rotationCode: string;
  rotationConfirmed: boolean;
  rotated: Rotated | null;
  rotationError: string | null;
};
const labels: Record<Status['state'], string> = {
  unconfigured: 'Unconfigured', paused: 'Paused', active: 'Active', locked: 'Locked',
};
const emptyView = (owner: Lifetime | null): View => ({
  owner, status: null, receipt: null, busy: false, statusError: false,
  pairError: null, endpoint: '', expectedWorkspaceId: '', code: '', lastTick: { state: 'unread' }, senderCap: { state: 'unread' },
  stored: { state: 'unread' }, rotationCode: '', rotationConfirmed: false, rotated: null, rotationError: null,
});
/** The first four characters of the pairing id are how the operator command and the docs name it too. */
export const shortPairingId = (pairingId: string): string => `${pairingId.slice(0, 4)}…`;
/** The one sentence David confirms before a rotation. Exactly this text, so tests and docs quote one source. */
export const rotationConfirmation = (pairingId: string): string =>
  `This replaces the credential this Mac uses for pairing ${shortPairingId(pairingId)} and keeps every record. The previous credential stops working.`;
const rotationUncertain = 'Rotation outcome could not be verified. The stored credential may or may not have changed. Refresh worker status and review the credential generation before a fresh explicit attempt.';
const rotationRefused = 'Enter the rotation code from the operator\'s private output and confirm the sentence before a fresh explicit attempt.';
/** Whole units only; the worker ticks every five minutes so seconds carry no information. */
export function describeAge(from: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(from)) / 60_000));
  if (minutes < 1) return 'less than a minute ago';
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} days ago`;
}

/** One sentence over recorded arithmetic. A cap is a ceiling the worker holds sends at, never a permission. */
export function describeSenderCap(cap: SenderCap): string {
  if (cap.state === 'unread') return 'Sender cap: not available (the cloud grant status could not be read).';
  if (cap.cap === null) return 'Sender cap: no cap policy recorded for this mailbox, so the worker holds every send.';
  const { today, position } = cap.cap;
  if (position === null) return `Sender cap today: ${today} a day, with no warm-up ramp configured.`;
  return `Sender cap today: ${today} of ${position.maxPerDay} (day ${position.day} of ramp).`;
}

/** Local observations and explicit pairing only. Neither establishes execution authority. */
export function WorkerSetupSection({ api }: { api?: Api }) {
  const generation = useRef(0);
  const owner = useRef<Lifetime | null>(null);
  const [view, setView] = useState<View>(() => emptyView(null));
  const current = useCallback((lifetime: Lifetime) =>
    owner.current === lifetime && generation.current === lifetime.generation, []);

  /** `remote` is true only for the explicit Refresh click: the mount and the post-pair read stay local so opening Settings never calls the worker. */
  const read = useCallback(async (lifetime: Lifetime, remote = false) => {
    if (!current(lifetime)) return;
    lifetime.status = null;
    setView(previous => ({ ...previous, status: null, statusError: false }));
    try {
      // Wrap invocation so synchronous throws also settle across an async boundary.
      const raw = await (async () => lifetime.api.status())();
      if (!current(lifetime)) return;
      const status = localDelegationStatusSchema.parse(raw);
      lifetime.status = status;
      setView(previous => ({
        ...previous, status, statusError: false,
        code: status.state === 'locked' ? '' : previous.code,
      }));
    } catch {
      if (!current(lifetime)) return;
      setView(previous => ({ ...previous, status: null, statusError: true, code: '' }));
    }
    // The stored pairing's identity, generation and scopes are a second local fact (a disk read in the main process,
    // never a worker call). Its failure is stated as such and never disturbs the status above.
    const pairing = lifetime.api.pairing;
    if (pairing) {
      let stored: Stored = { state: 'unread' };
      try {
        const raw = await (async () => pairing())();
        stored = { state: 'read', summary: raw === null ? null : storedPairingSummarySchema.parse(raw) };
      } catch { stored = { state: 'unread' }; }
      if (!current(lifetime)) return;
      lifetime.summary = stored.state === 'read' ? stored.summary : null;
      setView(previous => ({ ...previous, stored, ...(lifetime.summary ? {} : { rotationCode: '', rotationConfirmed: false }) }));
    }
    if (!remote) return;
    // The last scheduled tick is a second, independent observation; its failure never disturbs the local facts above.
    const researchSetup = lifetime.api.researchSetup;
    if (researchSetup) {
      let lastTick: LastTick = { state: 'unread' };
      try {
        const research = researchSetupStatusSchema.parse(await (async () => researchSetup.status())());
        if (research.remote) lastTick = { state: 'read', at: research.remote.lastTickAt ?? null };
      } catch { lastTick = { state: 'unread' }; }
      if (!current(lifetime)) return;
      setView(previous => ({ ...previous, lastTick }));
    }
    // Today's sender cap is a third independent observation of the cloud grant. Its failure
    // never disturbs the local facts or the tick above, and it starts no consent or send.
    const googleConnections = lifetime.api.googleConnections;
    if (!googleConnections) return;
    let senderCap: SenderCap = { state: 'unread' };
    try {
      const grant = remoteGoogleGrantStatusSchema.parse(await (async () => googleConnections.status({ purpose: 'permitted_correspondence' }))());
      senderCap = { state: 'read', cap: grant.senderCap ?? null };
    } catch { senderCap = { state: 'unread' }; }
    if (!current(lifetime)) return;
    setView(previous => ({ ...previous, senderCap }));
  }, [current]);

  const run = useCallback(async (lifetime: Lifetime, fields?: Request, remote = false) => {
    if (!current(lifetime) || lifetime.busy) return;
    if (fields !== undefined && (lifetime.status === null || lifetime.status.state === 'locked')) return;
    // Own the entire operation, including the successful pair's one status read.
    lifetime.busy = true;
    setView(previous => ({ ...previous, busy: true }));
    try {
      if (fields === undefined) {
        await read(lifetime, remote);
        return;
      }
      let paired = false;
      let submitted = false;
      setView(previous => ({ ...previous, pairError: null }));
      try {
        const receipt = await (async () => {
          // Public schema only. Preserve all entered bytes and snapshot before awaiting.
          const request = Object.freeze(redeemLocalPairingSchema.parse(fields));
          submitted = true;
          const raw = await lifetime.api.pair(request);
          if (!current(lifetime)) return null;
          const result = redeemedLocalPairingSchema.parse(raw);
          if (result.workspaceId !== request.expectedWorkspaceId) return null;
          return result;
        })();
        if (!current(lifetime)) return;
        if (receipt === null) {
          setView(previous => ({ ...previous, pairError: 'Pairing outcome could not be verified. Storage may have changed. Review worker status before a fresh explicit attempt.' }));
        } else {
          paired = true;
          setView(previous => ({ ...previous, receipt, pairError: null }));
        }
      } catch {
        if (!current(lifetime)) return;
        setView(previous => ({
          ...previous,
          pairError: submitted
            ? 'Pairing outcome could not be verified. Storage may have changed. Review worker status before a fresh explicit attempt.'
            : 'Check the endpoint, expected workspace ID and pairing code before a fresh explicit attempt.',
        }));
      } finally {
        // Release this operation's input reference without touching another owner.
        fields = undefined;
        // Clear before the follow-up read, even when that read never settles.
        if (current(lifetime)) setView(previous => ({ ...previous, code: '' }));
      }
      if (paired && current(lifetime)) await read(lifetime);
    } finally {
      // Revoked lifetimes cannot publish, clear a replacement's code, or unlock it.
      if (current(lifetime)) {
        lifetime.busy = false;
        setView(previous => ({ ...previous, busy: false }));
      }
    }
  }, [current, read]);

  /** Rotate the stored credential in place. The request names exactly the pairing and generation this screen read, so a
   * stale screen can never rotate a pairing it did not show; endpoint and workspace never leave the main process. */
  const rotate = useCallback(async (lifetime: Lifetime, code: string) => {
    if (!current(lifetime) || lifetime.busy || !lifetime.summary || !lifetime.api.rotatePairing) return;
    const summary = lifetime.summary;
    lifetime.busy = true;
    setView(previous => ({ ...previous, busy: true, rotationError: null, rotated: null }));
    let rotated: Rotated | null = null;
    let submitted = false;
    try {
      try {
        rotated = await (async () => {
          const request = Object.freeze(rotateLocalPairingSchema.parse({ pairingId: summary.pairingId, expectedGeneration: summary.generation, code }));
          submitted = true;
          const raw = await lifetime.api.rotatePairing!(request);
          if (!current(lifetime)) return null;
          const result = rotatedLocalPairingSchema.parse(raw);
          if (result.pairingId !== summary.pairingId || result.workspaceId !== summary.workspaceId || result.generation !== summary.generation + 1) return null;
          return result;
        })();
        if (!current(lifetime)) return;
        setView(previous => ({ ...previous, rotated, rotationError: rotated ? null : rotationUncertain }));
      } catch {
        if (!current(lifetime)) return;
        setView(previous => ({ ...previous, rotationError: submitted ? rotationUncertain : rotationRefused }));
      } finally {
        // The code and the confirmation are single-use whatever happened; a fresh attempt needs fresh explicit input.
        if (current(lifetime)) setView(previous => ({ ...previous, rotationCode: '', rotationConfirmed: false }));
      }
      // Re-read the local facts so the generation and scopes shown are the stored ones, not the receipt's.
      if (current(lifetime)) await read(lifetime);
    } finally {
      if (current(lifetime)) {
        lifetime.busy = false;
        setView(previous => ({ ...previous, busy: false }));
      }
    }
  }, [current, read]);

  useLayoutEffect(() => {
    const lifetime: Lifetime | null = api
      ? { api, generation: ++generation.current, busy: false, status: null, summary: null }
      : null;
    owner.current = lifetime;
    setView(emptyView(lifetime));
    if (lifetime) void run(lifetime);
    return () => {
      ++generation.current;
      owner.current = null;
      // Discard component-owned secret state. In-flight transport is not cancelled.
      setView(emptyView(null));
    };
  }, [api, run]);

  const lifetime = owner.current;
  const isCurrent = lifetime !== null && lifetime.api === api && view.owner === lifetime;
  const visible = isCurrent ? view : emptyView(null);
  const busy = !isCurrent || visible.busy;
  const pairable = !busy && visible.status !== null && visible.status.state !== 'locked';
  const change = (key: 'endpoint' | 'expectedWorkspaceId' | 'code', value: string) => {
    if (lifetime && current(lifetime) && !lifetime.busy && pairable) {
      setView(previous => ({ ...previous, [key]: value }));
    }
  };
  // Rotation needs the bridge's pairing read and rotation, and a pairing actually stored on this Mac.
  const stored = visible.stored.state === 'read' ? visible.stored.summary : null;
  const rotatable = !busy && stored !== null && typeof api?.rotatePairing === 'function';
  const changeRotation = (patch: Partial<Pick<View, 'rotationCode' | 'rotationConfirmed'>>) => {
    if (lifetime && current(lifetime) && !lifetime.busy && rotatable) setView(previous => ({ ...previous, ...patch }));
  };

  return (
    <section className="settings__section" aria-label="Worker connection">
      <h2 className="settings__section-title">Worker connection</h2>
      <p>Last explicit local status read. These facts may predate changes in Workspace access. Use Refresh worker status to update them.</p>
      <p role="status">{visible.status ? labels[visible.status.state] : visible.busy ? 'Checking worker status…' : 'Unavailable'}</p>
      {visible.status && (
        <dl className="settings__counters">
          <div><dt>Observed workspace</dt><dd>{visible.status.workspaceId ?? 'Not established'}</dd></div>
          <div><dt>Observed endpoint</dt><dd>{visible.status.endpoint ?? 'Not established'}</dd></div>
          {visible.status.configuration ? (
            <>
              <div><dt>Configuration state</dt><dd>{visible.status.configuration.configuration.state}</dd></div>
              <div><dt>Configuration revision</dt><dd>{visible.status.configuration.revision}</dd></div>
              <div><dt>Configuration updated at</dt><dd><time dateTime={visible.status.configuration.updatedAt}>{visible.status.configuration.updatedAt}</time></dd></div>
            </>
          ) : <div><dt>Configuration</dt><dd>Not established by this read</dd></div>}
        </dl>
      )}
      <p>Remote owner and mailbox/calendar grants are not established by this local read.</p>
      {api?.pairing && (visible.stored.state === 'unread'
        ? <p>Stored pairing credential: not available (the stored pairing could not be read).</p>
        : visible.stored.summary === null
          ? <p>Stored pairing credential: none. Pair worker below stores one.</p>
          : <dl className="settings__counters" aria-label="Stored pairing credential">
            <div><dt>Pairing id</dt><dd>{visible.stored.summary.pairingId}</dd></div>
            <div><dt>Credential generation</dt><dd>{visible.stored.summary.generation}</dd></div>
            <div><dt>Credential scopes</dt><dd>{visible.stored.summary.scopes.join(', ')}</dd></div>
          </dl>)}
      {api?.researchSetup && visible.status && (() => {
        const now = Date.now();
        if (visible.lastTick.state === 'unread') return <p>Worker last run: not available (the cloud research status could not be read).</p>;
        if (visible.lastTick.at === null) return <p>Worker last run: not recorded yet. The worker writes its first record on its first scheduled tick.</p>;
        const stale = now - Date.parse(visible.lastTick.at) > WORKER_STALE_AFTER_MS;
        return <>
          <p>Worker last ran <time dateTime={visible.lastTick.at}>{describeAge(visible.lastTick.at, now)}</time>.</p>
          {stale && <p role="alert">The worker has not run for more than 20 minutes. The schedule may be off or the worker may be failing; check the CloudWatch alarms before relying on the morning list.</p>}
        </>;
      })()}
      {api?.googleConnections && visible.status && <p>{describeSenderCap(visible.senderCap)}</p>}
      {visible.receipt && (
        <div>
          <h3>Worker paired</h3>
          <p>The pairing exchange succeeded for workspace {visible.receipt.workspaceId}. This receipt is separate from the current local status.</p>
          {stored && stored.pairingId === visible.receipt.pairingId && <p>Stored credential: generation {stored.generation}, scopes {stored.scopes.join(', ')}.</p>}
          <p>The running application may retain its startup connection. If the connection is not established above, restart the application normally, then explicitly refresh and review worker status. Pairing does not activate the worker.</p>
        </div>
      )}
      {visible.statusError && <p role="alert">Worker status could not be read. Refresh to review the current local status.</p>}
      {visible.pairError && <p role="alert">{visible.pairError}</p>}
      <p>Pair worker explicitly exchanges the supplied credential. The main process makes the final admission decision. No configuration, activation or synchronization is requested here.</p>
      <label className="settings__row">Endpoint
        <input type="text" value={visible.endpoint} disabled={!pairable} onChange={event => change('endpoint', event.target.value)} />
      </label>
      <label className="settings__row">Expected workspace ID
        <input type="text" value={visible.expectedWorkspaceId} disabled={!pairable} onChange={event => change('expectedWorkspaceId', event.target.value)} />
      </label>
      <label className="settings__row">Pairing code
        <input type="password" autoComplete="off" spellCheck={false} value={visible.code} disabled={!pairable} onChange={event => change('code', event.target.value)} />
      </label>
      <div className="settings__row-actions">
        <button type="button" className="settings__action" disabled={!pairable} onClick={() => {
          if (lifetime && pairable) void run(lifetime, {
            endpoint: visible.endpoint, expectedWorkspaceId: visible.expectedWorkspaceId, code: visible.code,
          });
        }}>Pair worker</button>
        <button type="button" className="settings__action" disabled={busy} onClick={() => {
          if (lifetime) void run(lifetime, undefined, true);
        }}>Refresh worker status</button>
      </div>
      {api?.pairing && api.rotatePairing && stored && (
        <div role="group" aria-label="Rotate pairing credential">
          <h3>Rotate pairing credential</h3>
          <p>Replaces the credential this Mac uses for the stored pairing with the one a rotation code from the operator carries, at the next generation and with the scopes the code names. The pairing id does not change, so every saved record stays. The previous credential stops working at the worker the moment the rotation is accepted.</p>
          <label className="settings__row">Rotation endpoint (locked)
            <input type="text" value={stored.endpoint} disabled readOnly />
          </label>
          <label className="settings__row">Rotation workspace ID (locked)
            <input type="text" value={stored.workspaceId} disabled readOnly />
          </label>
          <label className="settings__row">Rotation code
            <input type="password" autoComplete="off" spellCheck={false} value={visible.rotationCode} disabled={!rotatable} onChange={event => changeRotation({ rotationCode: event.target.value })} />
          </label>
          <label className="settings__row"><input type="checkbox" checked={visible.rotationConfirmed} disabled={!rotatable} onChange={event => changeRotation({ rotationConfirmed: event.target.checked })} />
            {rotationConfirmation(stored.pairingId)}</label>
          {visible.rotated && (
            <p role="status">Pairing credential rotated: pairing {visible.rotated.pairingId} is now at generation {visible.rotated.generation} with scopes {visible.rotated.scopes.join(', ')}. The previous credential no longer works. Restart the application normally so the running connection uses the new credential, then refresh worker status.</p>
          )}
          {visible.rotationError && <p role="alert">{visible.rotationError}</p>}
          <div className="settings__row-actions">
            <button type="button" className="settings__action" disabled={!rotatable || !visible.rotationConfirmed || visible.rotationCode.length === 0} onClick={() => {
              if (lifetime && rotatable && visible.rotationConfirmed) void rotate(lifetime, visible.rotationCode);
            }}>Rotate pairing credential</button>
          </div>
        </div>
      )}
    </section>
  );
}
