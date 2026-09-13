import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import type { CalliePreloadApi } from '../../shared/preload';
import {
  localDelegationStatusSchema,
  redeemedLocalPairingSchema,
  redeemLocalPairingSchema,
} from '../../shared/contracts/ownerCommandContract';

type Api = Pick<CalliePreloadApi['delegation'], 'status' | 'pair'>;
type Status = z.infer<typeof localDelegationStatusSchema>;
type Receipt = z.infer<typeof redeemedLocalPairingSchema>;
type Request = z.infer<typeof redeemLocalPairingSchema>;
type Lifetime = { api: Api; generation: number; busy: boolean; status: Status | null };
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
};
const labels: Record<Status['state'], string> = {
  unconfigured: 'Unconfigured', paused: 'Paused', active: 'Active', locked: 'Locked',
};
const emptyView = (owner: Lifetime | null): View => ({
  owner, status: null, receipt: null, busy: false, statusError: false,
  pairError: null, endpoint: '', expectedWorkspaceId: '', code: '',
});

/** Local observations and explicit pairing only. Neither establishes execution authority. */
export function WorkerSetupSection({ api }: { api?: Api }) {
  const generation = useRef(0);
  const owner = useRef<Lifetime | null>(null);
  const [view, setView] = useState<View>(() => emptyView(null));
  const current = useCallback((lifetime: Lifetime) =>
    owner.current === lifetime && generation.current === lifetime.generation, []);

  const read = useCallback(async (lifetime: Lifetime) => {
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
  }, [current]);

  const run = useCallback(async (lifetime: Lifetime, fields?: Request) => {
    if (!current(lifetime) || lifetime.busy) return;
    if (fields !== undefined && (lifetime.status === null || lifetime.status.state === 'locked')) return;
    // Own the entire operation, including the successful pair's one status read.
    lifetime.busy = true;
    setView(previous => ({ ...previous, busy: true }));
    try {
      if (fields === undefined) {
        await read(lifetime);
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

  useLayoutEffect(() => {
    const lifetime: Lifetime | null = api
      ? { api, generation: ++generation.current, busy: false, status: null }
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
      {visible.receipt && (
        <div>
          <h3>Worker paired</h3>
          <p>The pairing exchange succeeded for workspace {visible.receipt.workspaceId}. This receipt is separate from the current local status.</p>
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
          if (lifetime) void run(lifetime);
        }}>Refresh worker status</button>
      </div>
    </section>
  );
}
