import { setDailySessionScope } from './dailySessionScope';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { CalliePreloadApi } from '../../../shared/preload';
import {
  dailySnapshotSchema,
  type DailySnapshot,
} from '../../../shared/contracts/dailyContract';
import { DailyAnswers, DailyAnswerDetail, answerKey } from './DailyAnswers';
import {
  UpcomingMeetings,
  MeetingDetail,
  meetingKey,
} from './UpcomingMeetings';
import { CampaignReview } from '../campaigns/CampaignReview';
import './nativeDesk.css';
export type NativeDeskApi = Pick<
  CalliePreloadApi,
  'daily' | 'delegation' | 'linkedin'
>;
type Config = Awaited<ReturnType<NativeDeskApi['delegation']['status']>>;
type Surface = 'today' | 'accounts' | 'campaigns';
export type NativeDeskRouteProps = {
  api: NativeDeskApi;
  onOpenLead(personId: string): void;
  surface?: Surface;
  legacy?: ReactNode;
};
/** Local-only composition. Failed refresh preserves the editor and its DOM. */
export function NativeDeskRoute({
  api,
  onOpenLead,
  surface = 'today',
  legacy,
}: NativeDeskRouteProps) {
  const [state, setState] = useState<{
    api: NativeDeskApi;
    snapshot: DailySnapshot | null;
    config: Config | null;
    error: boolean;
  }>({ api, snapshot: null, config: null, error: false });
  const sequence = useRef(0);
  const load = useCallback(() => {
    const request = ++sequence.current;
    const daily = Promise.resolve().then(() => api.daily.get());
    const config = Promise.resolve()
      .then(() => api.delegation.status())
      .catch((): Config | null => null);
    void Promise.all([daily, config])
      .then(([raw, local]) => {
        if (request !== sequence.current) return;
        const snapshot = dailySnapshotSchema.parse(raw);
        const scope =
          snapshot.workflowMode === 'meeting_first'
            ? snapshot.workspaceId
            : null;
        setDailySessionScope(api.delegation, scope);
        setDailySessionScope(api.linkedin, scope);
        setState({
          api,
          snapshot,
          config:
            local?.workspaceId === snapshot.workspaceId &&
            snapshot.workspaceId !== null
              ? local
              : null,
          error: false,
        });
      })
      .catch(() => {
        if (request === sequence.current) {
          setDailySessionScope(api.delegation, null);
          setDailySessionScope(api.linkedin, null);
          setState((previous) =>
            previous.api === api
              ? { ...previous, error: true, config: null }
              : { api, snapshot: null, config: null, error: true },
          );
        }
      });
  }, [api]);
  useEffect(() => {
    load();
    window.addEventListener('focus', load);
    window.addEventListener('callie:outcome-logged', load);
    window.addEventListener('callie:email-sent', load);
    return () => {
      sequence.current++;
      setDailySessionScope(api.delegation, null);
      setDailySessionScope(api.linkedin, null);
      window.removeEventListener('focus', load);
      window.removeEventListener('callie:outcome-logged', load);
      window.removeEventListener('callie:email-sent', load);
    };
  }, [load]);
  const current = state.api === api ? state : null,
    snapshot = current?.snapshot;
  if (!snapshot)
    return (
      <section className="native-desk">
        <h1>
          {surface === 'today'
            ? 'Today'
            : surface === 'accounts'
              ? 'Accounts'
              : 'Campaigns'}
        </h1>
        <p role="status">
          {current?.error
            ? 'Daily workspace unavailable. Retry the local read.'
            : 'Loading daily workspace…'}
        </p>
        <button onClick={load}>Refresh</button>
      </section>
    );
  if (surface === 'today' && snapshot.workflowMode === 'legacy')
    return (
      <>{legacy ?? <p>Legacy Today is available from the main workspace.</p>}</>
    );
  if (snapshot.workflowMode === 'unknown')
    return (
      <section className="native-desk">
        <h1>Today</h1>
        <p>
          Workflow mode unavailable. Check workspace configuration in Settings.
        </p>
        <button onClick={load}>Refresh</button>
      </section>
    );
  return (
    <NativeDesk
      key={`${snapshot.workspaceId}:${surface}`}
      snapshot={snapshot}
      api={api}
      config={current.config}
      readError={current.error}
      onRefresh={load}
      onOpenLead={onOpenLead}
      surface={surface}
    />
  );
}
const selections = new WeakMap<
  NativeDeskApi['daily'],
  Map<string, string | null>
>();
function viewSelection(api: NativeDeskApi['daily']) {
  let map = selections.get(api);
  if (!map) {
    map = new Map();
    selections.set(api, map);
  }
  return map;
}
function AccountContext({
  account,
}: {
  account: DailySnapshot['accounts'][number];
}) {
  return (
    <section className="native-desk__account">
      <h2>{account.account.name}</h2>
      <p>{account.account.domain ?? 'Company domain not recorded'}</p>
      {account.portfolio.map((p, i) => (
        <p key={i}>
          {p.count} {p.scope} {p.measure}
        </p>
      ))}
      {account.portfolio.length === 0 && <p>Portfolio not recorded.</p>}
      <details>
        <summary>Company context and evidence</summary>
        {account.claims.map((c, i) => (
          <div key={i}>
            <p>
              {c.kind === 'hypothesis'
                ? 'Hypothesis'
                : c.kind === 'prospect_stated_problem'
                  ? 'Prospect stated'
                  : 'Fact'}
              :{' '}
              {typeof c.value === 'string'
                ? c.value
                : `${c.value.count} ${c.value.scope} ${c.value.measure}`}
            </p>
            <small>Evidence: {c.evidenceIds.join(', ') || 'Unverified'}</small>
          </div>
        ))}
        {account.unknowns.map((u, i) => (
          <p key={`u${i}`}>Unknown: {u}</p>
        ))}
        {account.conflicts.map((c, i) => (
          <p key={`c${i}`}>Conflict: {c}</p>
        ))}
        {account.routes.map((r) => (
          <p key={r.id}>
            {r.channel}: {r.value} · {r.purpose} · {r.verification} · v
            {r.version}
            <br />
            <small>Evidence: {r.evidenceIds.join(', ')}</small>
          </p>
        ))}
      </details>
    </section>
  );
}
export function NativeDesk({
  snapshot,
  api,
  config,
  readError = false,
  onRefresh,
  onOpenLead,
  surface = 'today',
}: {
  snapshot: DailySnapshot;
  api: NativeDeskApi;
  config: Config | null;
  readError?: boolean;
  onRefresh(): void;
  onOpenLead(personId: string): void;
  surface?: Surface;
}) {
  const scopeKey = JSON.stringify([snapshot.workspaceId, surface]);
  const cache = viewSelection(api.daily);
  const [selected, setSelected] = useState<string | null>(
    () => cache.get(scopeKey) ?? null,
  );
  const root = useRef<HTMLElement>(null);
  const select = (key: string | null) => {
    cache.set(scopeKey, key);
    setSelected(key);
  };
  const name = (id: string) =>
    snapshot.accounts.find((a) => a.account.id === id)?.account.name ?? id;
  const answer = snapshot.answers.find((a) => answerKey(a) === selected),
    meeting = snapshot.meetings.find((m) => meetingKey(m) === selected),
    campaign = snapshot.campaigns.find(
      (c) => `campaign:${c.version.id}` === selected,
    );
  const accountId =
    answer?.accountId ??
    meeting?.accountId ??
    (selected?.startsWith('call:')
      ? selected.slice(5)
      : selected?.startsWith('account:')
        ? selected.slice(8)
        : null);
  const account = snapshot.accounts.find((a) => a.account.id === accountId);
  const owner = snapshot.ownerStatus.find((o) => o.accountId === accountId);
  const configuration =
    config?.workspaceId === snapshot.workspaceId ? config : null;
  const configLabel = !configuration
    ? 'Local configuration unavailable'
    : configuration.state === 'locked'
      ? 'Workspace locked'
      : configuration.state === 'unconfigured'
        ? 'Not configured'
        : !configuration.configuration
          ? 'Pairing present · configuration unknown'
          : `Configured ${configuration.state}`;
  const actionHold =
    answer?.kind === 'requested_followup' &&
    answer.draft.accountVersion !== account?.account.version
      ? 'Account context changed. Refresh the saved draft with the owner before approval.'
      : readError
        ? 'Refresh unavailable. Actions held until the local workspace can be checked.'
        : !configuration ||
            configuration.state !== 'active' ||
            !configuration.configuration
          ? 'Actions held. Review local pairing and configuration in Settings.'
          : !owner?.authority ||
              owner.authority.owner !== 'worker' ||
              owner.authority.state !== 'active'
            ? 'Owner authority unavailable. Review this account’s delegation before continuing.'
            : owner.pendingCommands.length
              ? 'Owner command pending. Wait for its applied receipt before continuing.'
              : undefined;
  const keys =
    surface === 'today'
      ? [
          ...snapshot.calls.accountIds.map((id) => `call:${id}`),
          ...snapshot.answers.map(answerKey),
          ...snapshot.meetings.map(meetingKey),
        ]
      : surface === 'accounts'
        ? snapshot.accounts.map((a) => `account:${a.account.id}`)
        : snapshot.campaigns.map((c) => `campaign:${c.version.id}`);
  const keyboard = (e: KeyboardEvent<HTMLElement>) => {
    if (
      e.altKey ||
      e.ctrlKey ||
      e.metaKey ||
      e.shiftKey ||
      e.nativeEvent.isComposing
    )
      return;
    const target = e.target as HTMLElement;
    if (e.key === 'Escape') {
      if (selected) {
        e.preventDefault();
        const old = selected;
        select(null);
        root.current
          ?.querySelectorAll<HTMLButtonElement>('[data-row-key]')
          .forEach((el) => {
            if (el.dataset.rowKey === old) el.focus();
          });
      }
      return;
    }
    if (target.closest('input,textarea,select,[contenteditable="true"]'))
      return;
    const row = target.closest<HTMLElement>('[data-row-key]');
    if (!row) return;
    const key = row.dataset.rowKey ?? '',
      index = keys.indexOf(key);
    if (['j', 'k', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
      e.preventDefault();
      const direction = e.key === 'j' || e.key === 'ArrowDown' ? 1 : -1;
      const next =
        keys[Math.max(0, Math.min(keys.length - 1, index + direction))];
      root.current
        ?.querySelectorAll<HTMLButtonElement>('[data-row-key]')
        .forEach((el) => {
          if (el.dataset.rowKey === next) el.focus();
        });
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      select(key);
    }
  };
  const title =
    surface === 'today'
      ? 'Today'
      : surface === 'accounts'
        ? 'Accounts'
        : 'Campaigns';
  return (
    <section
      className="native-desk"
      ref={root}
      onKeyDown={keyboard}
      data-testid="native-desk"
      data-workflow-mode={snapshot.workflowMode}
    >
      <header className="native-desk__header">
        <div>
          <p className="native-desk__eyebrow">
            {new Date(snapshot.freshness.generatedAt).toLocaleDateString(
              undefined,
              { weekday: 'long', month: 'long', day: 'numeric' },
            )}
          </p>
          <h1>{title}</h1>
          <p>
            {surface === 'today'
              ? 'Calls, replies and the next conversation.'
              : surface === 'accounts'
                ? 'Company context, from stored evidence.'
                : 'Review the exact frozen plan.'}
          </p>
        </div>
        <div>
          <button onClick={onRefresh}>Refresh</button>
          <details className="native-desk__connection">
            <summary>{configLabel}</summary>
            <p>Remote freshness unknown. This is a local snapshot.</p>
            <p>Snapshot: {snapshot.freshness.generatedAt}</p>
            <a href="#/settings">Review Settings</a>
            {snapshot.ownerStatus.map((o) => (
              <p key={o.accountId}>
                {name(o.accountId)}: {o.status.replaceAll('_', ' ')}
                {o.pendingCommands.length
                  ? ` · ${o.pendingCommands.length} pending command(s)`
                  : ''}
              </p>
            ))}
            {snapshot.transport.map((t) => (
              <p key={`${t.pairingId}:${t.revision}`}>
                Stored transport: {t.state}. Not current connectivity.
              </p>
            ))}
          </details>
        </div>
      </header>
      <div className="native-desk__layout">
        <nav className="native-desk__queue" aria-label={`${title} queue`}>
          <p className="native-desk__hint">j / k to move · Enter to review</p>
          {surface === 'today' ? (
            <>
              <section className="native-desk__lane">
                <h2>
                  Calls <span>{snapshot.calls.accountIds.length}</span>
                </h2>
                {!snapshot.calls.accountIds.length ? (
                  <p className="native-desk__empty">No calls allocated.</p>
                ) : (
                  snapshot.calls.accountIds.map((id) => (
                    <button
                      className="native-desk__row"
                      key={id}
                      data-row-key={`call:${id}`}
                      aria-current={
                        selected === `call:${id}` ? 'true' : undefined
                      }
                      aria-label={`Call · ${name(id)}`}
                      onClick={() => select(`call:${id}`)}
                    >
                      <strong>{name(id)}</strong>
                      <small>Call</small>
                      <span>Review company and route</span>
                    </button>
                  ))
                )}
              </section>
              <DailyAnswers
                items={snapshot.answers}
                selected={selected}
                name={name}
                onSelect={select}
              />
              <UpcomingMeetings
                items={snapshot.meetings}
                selected={selected}
                name={name}
                onSelect={select}
              />
            </>
          ) : surface === 'accounts' ? (
            <section className="native-desk__lane">
              <h2>
                Accounts <span>{snapshot.accounts.length}</span>
              </h2>
              {snapshot.accounts.map((a) => (
                <button
                  className="native-desk__row"
                  key={a.account.id}
                  data-row-key={`account:${a.account.id}`}
                  aria-current={
                    selected === `account:${a.account.id}` ? 'true' : undefined
                  }
                  onClick={() => select(`account:${a.account.id}`)}
                >
                  <strong>{a.account.name}</strong>
                  <span>{a.account.domain ?? 'Domain unknown'}</span>
                </button>
              ))}
              {!snapshot.accounts.length && <p>No stored accounts.</p>}
            </section>
          ) : (
            <section className="native-desk__lane">
              <h2>
                Campaigns <span>{snapshot.campaigns.length}</span>
              </h2>
              {snapshot.campaigns.map((c) => (
                <button
                  className="native-desk__row"
                  key={c.version.id}
                  data-row-key={`campaign:${c.version.id}`}
                  aria-current={
                    selected === `campaign:${c.version.id}` ? 'true' : undefined
                  }
                  onClick={() => select(`campaign:${c.version.id}`)}
                >
                  <strong>{c.version.campaignId}</strong>
                  <span>
                    Version {c.version.version} ·{' '}
                    {c.version.approvedAt
                      ? 'approval recorded'
                      : 'review required'}
                  </span>
                </button>
              ))}
              {!snapshot.campaigns.length && <p>No frozen campaigns.</p>}
            </section>
          )}
        </nav>
        <div className="native-desk__detail">
          {selected && (
            <div className="native-desk__detail-bar">
              <span>
                {answer
                  ? 'Needs your approval'
                  : meeting
                    ? 'Upcoming meeting'
                    : campaign
                      ? 'Campaign review'
                      : 'Company context'}
              </span>
              <button aria-label="Close details" onClick={() => select(null)}>
                Close
              </button>
            </div>
          )}
          {account && <AccountContext account={account} />}{' '}
          {answer && snapshot.workspaceId && (
            <DailyAnswerDetail
              item={answer}
              workspaceId={snapshot.workspaceId}
              api={api.delegation}
              linkedin={api.linkedin}
              actionHold={actionHold}
            />
          )}{' '}
          {meeting && <MeetingDetail item={meeting} />}{' '}
          {campaign && (
            <CampaignReview
              campaign={campaign}
              accounts={snapshot.accounts}
              answers={snapshot.answers}
            />
          )}
          {account && selected?.startsWith('call:') && (
            <section className="native-desk__call">
              <h3>Phone route</h3>
              {account.routes
                .filter((r) => r.channel === 'phone')
                .map((r) => (
                  <div key={r.id}>
                    <p>
                      {r.value} · {r.purpose} · {r.verification}
                    </p>
                    {r.personId ? (
                      <button
                        className="native-desk__primary"
                        onClick={() => onOpenLead(r.personId!)}
                      >
                        Open contact workspace
                      </button>
                    ) : null}
                  </div>
                ))}
              <p className="native-desk__hold">
                Call handoff unavailable in this account view.{' '}
                {account.routes.some((r) => r.channel === 'phone' && r.personId)
                  ? 'Open the linked contact workspace to review the existing call confirmation.'
                  : 'Review and link a real contact route before using the existing call workspace.'}{' '}
                Selection alone never places a call.
              </p>
            </section>
          )}
          {!account && !campaign && !meeting && !answer && (
            <div className="native-desk__welcome">
              <h2>
                {selected
                  ? 'This item is no longer in the local queue.'
                  : 'Make room for a good conversation.'}
              </h2>
              <p>
                Select an item to review its company context and exact saved
                work.
              </p>
            </div>
          )}
        </div>
      </div>
      <footer className="native-desk__footer">
        <span role="status">
          {readError
            ? 'Refresh unavailable. Your current view and edits are retained.'
            : 'Local snapshot · remote freshness unknown'}
        </span>
        <details>
          <summary>Queue capacity and operational details</summary>
          <p>
            New-call slots:{' '}
            {snapshot.callSettings.newCallSlots ?? 'unconfigured'} · total call
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
      </footer>
    </section>
  );
}
