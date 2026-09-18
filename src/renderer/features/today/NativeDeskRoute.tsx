import { partitionFirstUseAnswers } from './firstUseCapabilities';
import { CompanyPhoneCall } from './CompanyPhoneCall';
import { CallCard } from './CallCard';
import { TodayFooter } from './TodayFooter';
import { openSettingsSection } from '../../foundation/settingsNavigation';
import type { FirstUseContinuation } from './localCompanyContinuation';
import { useOverlayLayers } from '../../app/overlayLayers';
import { Phone, RefreshCw } from 'lucide-react';
import { useLocalWorkspaceRead, type LocalDeskRead } from './localWorkspaceRead';
import { RetainedWork, RetainedWorkDetail, LocalOnlyCalls, LocalDraftContinuations, retainedKey, localDraftKey } from './RetainedWork';
import { LocalAccountLibrary, LocalAccountDetail, localAccountKey, LocalOnlyAccountLibrary, requestLocalAccountStep, takeLocalAccountStep, type LocalAccountSelectionRequest, type LocalAccountStepRequest } from './LocalAccountLibrary';
import type { LocalDraftContinuation } from '../../../shared/contracts/localWorkspaceContract';
import { routeHash } from '../../app/routes';
import { LocalCompanyIntake, useLocalCompanyIntake } from './LocalCompanyIntake';
import { formatVisibleCount, localCommitmentsCount, type VisibleCount } from './visibleCount';
import { updateRequestedSessionHolds } from './requestedDraftSession';
import { updateLinkedInSessionHolds } from '../linkedin/linkedInSession';
import {
  captureDailySessionScope,
  setDailySessionScope,
} from './dailySessionScope';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
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
import { ManualLinkedInPreparation } from '../linkedin/ManualLinkedInPreparation';
import { CallCampaignEnrollment } from '../campaigns/CallCampaignEnrollment';
import { CallCampaignDraft } from '../campaigns/CallCampaignDraft';
import { describeCampaignRow } from '../campaigns/campaignListLabel';
import { describeOneCompanyCampaignTemplate, type OneCompanyCampaignChannel } from '../../../shared/contracts/callCampaignDraft';
import './nativeDesk.css';
export type NativeDeskApi = Pick<
  CalliePreloadApi,
  'daily' | 'delegation' | 'linkedin' | 'leads' | 'leadDetail'
> & Partial<Pick<CalliePreloadApi, 'localWorkspace' | 'phoneSetup'>>;
type Config = Awaited<ReturnType<NativeDeskApi['delegation']['status']>>;
type Surface = 'today' | 'accounts' | 'campaigns';
export type NativeDeskRouteProps = {
  firstUse: FirstUseContinuation;
  api: NativeDeskApi;
  surface?: Surface;
};
/** Local-only composition. Failed refresh preserves the editor and its DOM. */
/** Route-owned copy for the two exact one-company templates. Every other version is an opaque read-only preview. */
const oneCompanyCampaignCopy: Record<OneCompanyCampaignChannel, { campaign: string; outreach: string }> = {
  call: { campaign: 'call campaign', outreach: 'places a call' },
  linkedin: { campaign: 'LinkedIn campaign', outreach: 'sends a LinkedIn note' },
};
/** Scope, transport and allocation codes describe the paused cloud side. Every other issue is a real local record problem. */
const OPERATIONAL_ISSUE_CODES = new Set<DailySnapshot['issues'][number]['code']>(['scope_unknown', 'scope_mismatch', 'transport_incomplete', 'call_allocation_unconfigured', 'workload_conflict']);
export function NativeDeskRoute({
  api,
  firstUse,
  surface = 'today',
}: NativeDeskRouteProps) {
  useSyncExternalStore(firstUse.subscribe, firstUse.snapshot, firstUse.snapshot);
  const firstUseEpoch = firstUse.captureEpoch();
  const local = useLocalWorkspaceRead(api.localWorkspace);
  const [state, setState] = useState<{
    api: NativeDeskApi;
    snapshot: DailySnapshot | null;
    config: Config | null;
    error: boolean;
  }>({ api, snapshot: null, config: null, error: false });
  const sequence = useRef(0);
  const load = useCallback(() => {
    const request = ++sequence.current;
    // Retain the mounted content, but invalidate admission before either read.
    setDailySessionScope(api.delegation, null);
    setDailySessionScope(api.linkedin, null);
    updateRequestedSessionHolds(api.delegation, () => 'Daily configuration pending');
    updateLinkedInSessionHolds(api.linkedin, () => 'Daily configuration pending');
    setState((previous) => previous.api === api
      ? { ...previous, config: null }
      : { api, snapshot: null, config: null, error: false });
    let validated: DailySnapshot | null = null;
    let local: Config | null = null;
    const matchingConfig = (snapshot: DailySnapshot) =>
      snapshot.workspaceId !== null && local?.workspaceId === snapshot.workspaceId
        ? local
        : null;
    const daily = Promise.resolve().then(() => api.daily.get());
    void Promise.resolve()
      .then(() => api.delegation.status())
      .catch((): Config | null => null)
      .then((config) => {
        if (request !== sequence.current) return;
        local = config;
        const snapshot = validated;
        if (!snapshot) return;
        setState((previous) =>
          request === sequence.current && previous.api === api &&
          previous.snapshot === snapshot && !previous.error
            ? { ...previous, config: matchingConfig(snapshot) }
            : previous,
        );
      });
    void daily
      .then((raw) => {
        if (request !== sequence.current) return;
        const snapshot = dailySnapshotSchema.parse(raw);
        validated = snapshot;
        setState({
          api,
          snapshot,
          config: matchingConfig(snapshot),
          error: false,
        });
      })
      .catch(() => {
        validated = null;
        if (request === sequence.current) {
          setDailySessionScope(api.delegation, null);
          setDailySessionScope(api.linkedin, null);
          updateRequestedSessionHolds(
            api.delegation,
            () => 'Daily read unavailable',
          );
          updateLinkedInSessionHolds(
            api.linkedin,
            () => 'Daily read unavailable',
          );
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
    // Dispatched by the preload when the main process reports a background sync that applied worker events (D3).
    window.addEventListener('callie:daily-changed', load);
    window.addEventListener('callie:outcome-logged', load);
    window.addEventListener('callie:email-sent', load);
    window.addEventListener('callie:workflow-changed', load);
    return () => {
      sequence.current++;
      setDailySessionScope(api.delegation, null);
      setDailySessionScope(api.linkedin, null);
      updateRequestedSessionHolds(api.delegation, () => 'Daily view closed');
      updateLinkedInSessionHolds(api.linkedin, () => 'Daily view closed');
      window.removeEventListener('focus', load);
      window.removeEventListener('callie:daily-changed', load);
      window.removeEventListener('callie:outcome-logged', load);
      window.removeEventListener('callie:email-sent', load);
      window.removeEventListener('callie:workflow-changed', load);
    };
  }, [load]);
  const current = state.api === api ? state : null,
    snapshot = current?.snapshot;
  const localHold = !!api.localWorkspace && (local.read.overview.pending || local.read.overview.error || !local.read.overview.value || local.read.overview.value.workflowMode !== snapshot?.workflowMode);
  useLayoutEffect(() => {
    if (!snapshot) {
      setDailySessionScope(api.delegation, null);
      setDailySessionScope(api.linkedin, null);
      return;
    }
    const local = current?.config;
    const scope =
      !localHold && !current?.error && snapshot.workflowMode === 'meeting_first' &&
      local?.workspaceId === snapshot.workspaceId &&
      local.state === 'active' &&
      local.configuration
        ? snapshot.workspaceId
        : null;
    setDailySessionScope(api.delegation, scope);
    setDailySessionScope(api.linkedin, scope);
    const hold = (
      accountId: string,
      workspaceId: string,
      accountVersion?: number,
    ) => {
      const account = snapshot.accounts.find(
        (a) => a.account.id === accountId,
      );
      const owner = snapshot.ownerStatus.find(
        (o) => o.accountId === accountId,
      );
      if (!scope || workspaceId !== scope)
        return 'Daily workspace or configuration held';
      if (
        !account ||
        (accountVersion !== undefined &&
          account.account.version !== accountVersion)
      )
        return 'Account context changed';
      if (
        !owner?.authority ||
        owner.authority.owner !== 'worker' ||
        owner.authority.state !== 'active' ||
        owner.pendingCommands.length
      )
        return 'Owner authority or command held';
      return undefined;
    };
    updateRequestedSessionHolds(api.delegation, (d) => {
      const current = snapshot.answers.find(
        (a) =>
          a.kind === 'requested_followup' &&
          a.draft.id === d.id &&
          a.accountId === d.accountId,
      );
      return (
        hold(d.accountId, snapshot.workspaceId ?? '', d.accountVersion) ||
        (!current ||
        current.kind !== 'requested_followup' ||
        current.draft.recipient !== d.recipient ||
        current.draft.contextRevision !== d.contextRevision ||
        current.draft.revision > d.revision
          ? 'Saved draft context changed'
          : undefined)
      );
    });
    updateLinkedInSessionHolds(api.linkedin, (d) =>
      hold(d.accountId, d.workspaceId),
    );

  }, [api, localHold, snapshot, current?.config, current?.error]);
  const [intakeSelection, setIntakeSelection] = useState<{ api: NativeDeskApi['localWorkspace']; request: LocalAccountSelectionRequest } | null>(null);
  const onIntakeSelectionHandled = useCallback((request: LocalAccountSelectionRequest) => {
    setIntakeSelection(previous => previous?.request === request ? null : previous);
  }, []);
  // A requested step (a Today draft row or an Accounts step control) outlives the pending -> composed switch, not this route.
  const [stepSelection, setStepSelection] = useState<{ api: NativeDeskApi['localWorkspace']; request: LocalAccountStepRequest } | null>(() => {
    const request = surface === 'accounts' && api.localWorkspace ? takeLocalAccountStep(api.localWorkspace) : null;
    return request ? { api: api.localWorkspace, request } : null;
  });
  const requestStep = useCallback((request: LocalAccountStepRequest) => { setStepSelection({ api: api.localWorkspace, request }); }, [api.localWorkspace]);
  const onStepHandled = useCallback((request: LocalAccountStepRequest) => {
    setStepSelection(previous => previous?.request === request ? null : previous);
  }, []);
  const stepRequest = surface === 'accounts' && stepSelection?.api === api.localWorkspace ? stepSelection.request : null;
  const openLocalDraft = (draft: LocalDraftContinuation) => {
    const localApi = api.localWorkspace;
    if (!localApi || !firstUse.selectAccount(firstUseEpoch, draft.accountId)) return;
    viewSelection(api.daily).set(JSON.stringify([snapshot?.workspaceId ?? null, 'accounts']), localAccountKey(draft.accountId));
    // Opening the company is navigation, never sending. The Accounts route takes this step on mount and focuses the draft panel.
    requestLocalAccountStep(localApi, { accountId: draft.accountId, step: 'reopen_draft' });
    window.location.hash = routeHash('accounts');
  };
  const intakeController = useLocalCompanyIntake({
    api: api.localWorkspace,
    scopeKey: `local-company:${surface}`,
    available: surface === 'accounts' && !local.read.overview.pending && !local.read.overview.error
      && local.read.overview.value?.accounts.state === 'available',
    localRead: local.read.overview,
    onRefreshLocal: local.refresh,
    onOpenAccount: id => {
      if (!firstUse.selectAccount(firstUseEpoch, id)) return;
      const key = localAccountKey(id);
      viewSelection(api.daily).set(JSON.stringify([snapshot?.workspaceId ?? null, surface]), key);
      setIntakeSelection({ api: api.localWorkspace, request: { key } });
    },
  });
  const intake = surface === 'accounts' ? <LocalCompanyIntake controller={intakeController} /> : undefined;
  const intakeRequest = surface === 'accounts' && intakeSelection?.api === api.localWorkspace ? intakeSelection?.request : null;
  const refresh = () => { local.refresh(); load(); };
  const localOnly = surface === 'accounts'
    ? <LocalOnlyAccountLibrary api={api.localWorkspace} contactApi={api} firstUse={firstUse} intake={intake} selectionRequest={intakeRequest} onSelectionHandled={onIntakeSelectionHandled} read={local.read.overview} onSelectionChange={key => viewSelection(api.daily).set(JSON.stringify([snapshot?.workspaceId ?? null, surface]), key)} stepRequest={stepRequest} onStep={requestStep} onStepHandled={onStepHandled} onEvidenceChanged={local.refresh} />
    : surface === 'today' ? <LocalOnlyCalls read={local.read.retained} onOpenDraft={openLocalDraft} initialSelected={viewSelection(api.daily).get(JSON.stringify([snapshot?.workspaceId ?? null, surface]))} onSelectionChange={key => viewSelection(api.daily).set(JSON.stringify([snapshot?.workspaceId ?? null, surface]), key)} /> : <p>Campaign scope unavailable. This is a read-only capability preview. Creation, editing, enrollment and activation are not available here.</p>;
  if (!snapshot)
    return (
      <section className="native-desk native-desk--pending" data-presentation="native-a">
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
        <button onClick={refresh}>Refresh</button>
        {localOnly}
      </section>
    );
  // Retained mode evidence owns composition; refresh health only owns admission.
  // API replacement discards current/snapshot above, and confirmed mode changes
  // still leave this branch. Never remove the worker/session holds to retain UI.
  if ((snapshot.workflowMode === 'unknown' || snapshot.workflowMode === 'legacy') && local.read.overview.value?.workflowMode !== 'meeting_first')
    return (
      <section
        className={snapshot.workflowMode === 'unknown' ? 'native-desk native-desk--pending' : 'native-desk'}
        data-presentation={snapshot.workflowMode === 'unknown' ? 'native-a' : undefined}
      >
        <h1>{surface === 'today' ? 'Today' : surface === 'accounts' ? 'Accounts' : 'Campaigns'}</h1>
        <p>
          {snapshot.workflowMode === 'legacy' && !localHold && !current?.error
            ? 'Legacy workflow is active. Local records remain available. Switch to Native Desk in Settings to change the daily workspace. Worker actions are held.'
            : 'Workflow mode unavailable or inconsistent. Refresh to check local status. Worker actions are held.'}
        </p>
        <button onClick={refresh}>Refresh</button>
        {localOnly}
      </section>
    );
  return (
    <NativeDesk
      firstUse={firstUse}
      key={`${snapshot.workspaceId}:${surface}`}
      snapshot={snapshot}
      api={api}
      config={localHold ? null : current.config}
      readError={current.error || localHold}
      phoneReadError={current.error}
      localRead={local.read}
      localHold={localHold}
      intake={intake}
      intakeSelection={intakeRequest}
      onIntakeSelectionHandled={onIntakeSelectionHandled}
      onRefresh={refresh}
      onOpenLocalDraft={openLocalDraft}
      stepRequest={stepRequest}
      onStep={requestStep}
      onStepHandled={onStepHandled}
      onEvidenceChanged={local.refresh}
      surface={surface}
    />
  );
}
/** Explicit workspace-wide reconciliation, never a new-work bypass. The owner
 * decides which retained commands can be replayed and which events settle them. */
function OwnerReconciliation({
  snapshot,
  api,
  config,
  readError,
  onRefresh,
}: {
  snapshot: DailySnapshot;
  api: NativeDeskApi;
  config: Config | null;
  readError: boolean;
  onRefresh(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const flight = useRef(false);
  const lifetime = useRef(0);
  const pending = snapshot.ownerStatus.filter((o) => o.pendingCommands.length);
  const allowed =
    !readError &&
    snapshot.workflowMode === 'meeting_first' &&
    snapshot.workspaceId !== null &&
    config?.workspaceId === snapshot.workspaceId &&
    config.state === 'active' &&
    !!config.configuration &&
    pending.length > 0 &&
    pending.every(
      (o) => o.authority?.owner === 'worker' && o.authority.state === 'active',
    );
  // Invalidate even when a held scope later returns to the same workspace.
  const guard = JSON.stringify([
    snapshot.workspaceId,
    snapshot.workflowMode,
    readError,
    config,
    snapshot.ownerStatus.map((o) => [o.accountId, o.authority]),
  ]);
  useLayoutEffect(() => {
    lifetime.current++;
    return () => {
      lifetime.current++;
    };
  }, [api, guard]);
  const reconcile = async () => {
    if (!allowed || flight.current) return;
    const generation = lifetime.current;
    flight.current = true;
    setBusy(true);
    setFailed(false);
    try {
      const assertScope = captureDailySessionScope(
        api.delegation,
        snapshot.workspaceId!,
      );
      await api.delegation.sync();
      assertScope();
      if (generation !== lifetime.current) return;
      // Counts/HTTP acceptance are not receipts. Only the subsequent canonical
      // local read may update pending holds or saved approval/outcome state.
      onRefresh();
    } catch {
      if (generation === lifetime.current) setFailed(true);
    } finally {
      flight.current = false;
      setBusy(false);
    }
  };
  return pending.length ? (
    <div>
      <p>
        Reconciliation may retry already-queued commands across this workspace.
        It does not approve new work. Pending or unknown receipts are not proof
        of sending.
      </p>
      <button
        disabled={!allowed || busy}
        onClick={() => { void reconcile(); }}
      >
        Reconcile queued commands
      </button>
      {failed && (
        <p role="status">
          Reconciliation unavailable. Pending work remains held. Retry explicitly
          when the owner is available.
        </p>
      )}
    </div>
  ) : null;
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
  firstUse,
  snapshot,
  api,
  config,
  readError = false,
  phoneReadError = readError,
  onRefresh,
  surface = 'today',
  localRead,
  localHold = false,
  intake,
  intakeSelection,
  onIntakeSelectionHandled,
  onOpenLocalDraft,
  stepRequest = null,
  onStep,
  onStepHandled,
  onEvidenceChanged,
}: {
  firstUse: FirstUseContinuation;
  snapshot: DailySnapshot;
  api: NativeDeskApi;
  config: Config | null;
  readError?: boolean;
  phoneReadError?: boolean;
  localRead?: LocalDeskRead;
  localHold?: boolean;
  intake?: ReactNode;
  intakeSelection?: LocalAccountSelectionRequest | null;
  onIntakeSelectionHandled?(request: LocalAccountSelectionRequest): void;
  onRefresh(): void;
  onOpenLocalDraft?(draft: LocalDraftContinuation): void;
  stepRequest?: LocalAccountStepRequest | null;
  onStep?(request: LocalAccountStepRequest): void;
  onStepHandled?(request: LocalAccountStepRequest): void;
  onEvidenceChanged?(): void;
  surface?: Surface;
}) {
  const firstUseState = useSyncExternalStore(firstUse.subscribe, firstUse.snapshot, firstUse.snapshot);
  const firstUseEpoch = firstUse.captureEpoch();
  const scopeKey = JSON.stringify([snapshot.workspaceId, surface]);
  const cache = viewSelection(api.daily);
  const [viewSelected, setSelected] = useState<string | null>(
    () => surface === 'accounts' && firstUseState.selectedAccountId !== null
      ? localAccountKey(firstUseState.selectedAccountId) : cache.get(scopeKey) ?? null,
  );
  // Worker selection remains presentation-cached. Local selection belongs only
  // to the current intake owner, including after a local API lifetime change.
  const selected = surface !== 'accounts' ? viewSelected
    : firstUseState.selectedAccountId !== null ? localAccountKey(firstUseState.selectedAccountId)
    : viewSelected?.startsWith('["local-account",') ? null : viewSelected;
  useEffect(() => {
    if (!intakeSelection) return;
    cache.set(scopeKey, intakeSelection.key);
    setSelected(intakeSelection.key);
    onIntakeSelectionHandled?.(intakeSelection);
  }, [intakeSelection, onIntakeSelectionHandled, cache, scopeKey]);
  const root = useRef<HTMLElement>(null);
  const localAccounts = localRead?.overview.value?.accounts.state === 'available' ? localRead.overview.value.accounts.snapshots : [];
  const select = (key: string | null) => {
    if (surface === 'accounts') {
      const local = localAccounts.find(item => localAccountKey(item.account.id) === key);
      if (!firstUse.selectAccount(firstUseEpoch, local?.account.id ?? null)) return false;
    }
    cache.set(scopeKey, key);
    setSelected(key);
    return true;
  };
  const closeDetails = () => {
    const old = selected;
    select(null);
    root.current?.querySelectorAll<HTMLButtonElement>('[data-row-key]').forEach(row => {
      if (row.dataset.rowKey === old) row.focus();
    });
  };
  const name = (id: string) =>
    snapshot.accounts.find((a) => a.account.id === id)?.account.name ?? id;
  const answer = snapshot.answers.find((a) => answerKey(a) === selected),
    meeting = snapshot.meetings.find((m) => meetingKey(m) === selected),
    campaign = snapshot.campaigns.find(
      (c) => `campaign:${c.version.id}` === selected,
    );
  const campaignTemplate = campaign ? describeOneCompanyCampaignTemplate(campaign.version) : null;
  const campaignCopy = campaignTemplate ? oneCompanyCampaignCopy[campaignTemplate.channel] : null;
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
  const retained = localRead?.retained.value?.items.find(item => retainedKey(item) === selected);
  const localAccount = localAccounts.find(item => localAccountKey(item.account.id) === selected);
  const unavailableScope = snapshot.workspaceId === null;
  const incomplete = snapshot.freshness.kind === 'incomplete';
  // Paused or unpaired is a chosen state of this Mac, not a fault: one quiet line, connection details collapsed.
  // A real local record problem (invalid record, failed research) keeps its own visible line either way.
  const pausedWorker = configuration?.state === 'paused' || configuration?.configuration?.configuration.state === 'paused';
  const calm = unavailableScope || pausedWorker;
  const localRecordProblem = snapshot.issues.some(issue => !OPERATIONAL_ISSUE_CODES.has(issue.code));
  const showIncomplete = incomplete && (!calm || localRecordProblem);
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
  const { continuations, history } = partitionFirstUseAnswers(snapshot.answers);
  const localDrafts = localRead?.retained.value?.localDrafts ?? [];
  const keys =
    surface === 'today'
      ? [
          ...(localRead?.retained.value?.items.map(retainedKey) ?? []),
          ...snapshot.calls.accountIds.map((id) => `call:${id}`),
          ...continuations.map(answerKey),
          ...history.map(answerKey),
          ...localDrafts.map(localDraftKey),
          ...snapshot.meetings.map(meetingKey),
        ]
      : surface === 'accounts'
        ? [...((localRead?.overview.value?.accounts.state === 'available' ? localRead.overview.value.accounts.snapshots : []).map(a => localAccountKey(a.account.id)) ?? []), ...snapshot.accounts.map((a) => `account:${a.account.id}`)]
        : snapshot.campaigns.map((c) => `campaign:${c.version.id}`);
  const layers = useOverlayLayers();
  const keyboard = (e: KeyboardEvent<HTMLElement>) => {
    if (e.defaultPrevented || layers.hasOpenLayer() || (e.key === 'Escape' && e.repeat)) return;
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
      const draft = localDrafts.find((item) => localDraftKey(item) === key);
      if (draft) onOpenLocalDraft?.(draft);
      else select(key);
    }
  };
  const retainedCount = localCommitmentsCount(localRead?.retained);
  const workerCount = (value: number): VisibleCount => unavailableScope ? { kind: 'unavailable' } : readError || localHold ? { kind: 'last_known', value } : incomplete ? { kind: 'partial', value } : { kind: 'known', value };
  const callCount = workerCount(snapshot.calls.accountIds.length);
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
      data-presentation="native-a"
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
                : campaignCopy
                  ? `Save an unapproved ${campaignCopy.campaign} draft for one worker-owned company. Review and enrollment are separate explicit actions. Neither ${campaignCopy.outreach}.`
                  : 'Save an unapproved call campaign draft for one worker-owned company, or a LinkedIn campaign draft. Review and enrollment are separate explicit actions. Neither places a call or sends a LinkedIn note.'}
          </p>
        </div>
        <div className="native-desk__header-status">
          <details className="native-desk__connection">
            <summary>{unavailableScope ? 'Worker unavailable' : pausedWorker ? 'Worker paused' : 'Worker freshness unknown'}</summary>
            <p>{configLabel}</p>
            <p>Local records are separate from worker-authorized work. Pairing and owner checks are required for worker actions.</p>
            <p>Remote freshness unknown. This is a local snapshot.</p>
            <p>Snapshot: {snapshot.freshness.generatedAt}</p>
            <a href="#/settings" onClick={() => openSettingsSection('worker')}>Review Settings</a>
            {snapshot.ownerStatus.map((o) => (
              <p key={o.accountId}>
                {name(o.accountId)}: {o.status.replaceAll('_', ' ')}
                {o.pendingCommands.length
                  ? ` · ${o.pendingCommands.length} pending command(s)`
                  : ''}
              </p>
            ))}
            <OwnerReconciliation
              snapshot={snapshot}
              api={api}
              config={configuration}
              readError={readError}
              onRefresh={onRefresh}
            />
            {snapshot.transport.map((t) => (
              <p key={`${t.pairingId}:${t.revision}`}>
                Stored transport: {t.state}. Not current connectivity.
              </p>
            ))}
          </details>
          <button className="native-desk__refresh" aria-label="Refresh" title="Refresh" onClick={onRefresh}><RefreshCw size={16} aria-hidden="true" /></button>
        </div>
      </header>
      {surface === 'campaigns' && <CallCampaignDraft api={api} snapshot={snapshot} config={configuration} readError={readError || !!localHold} onRefresh={onRefresh} />}
      {localHold && <p role="status">Local workflow unavailable or inconsistent. Worker actions are held. Refresh to check status.</p>}
      {calm && <p role="status" className="native-desk__calm">Cloud work is paused on this Mac. Local work continues.</p>}
      {showIncomplete && <p role="status">The daily snapshot is incomplete. Account work may be missing. Existing owner checks still apply.</p>}
      <div className="native-desk__layout">
        <nav className={`native-desk__queue${surface === 'today' ? ' native-desk__queue--today' : ''}`} aria-label={`${title} queue`} tabIndex={0}>
          <div className="native-desk__queue-title"><h2>{surface === 'today' ? 'Your next conversations' : surface === 'accounts' ? 'Your accounts' : 'Saved campaign versions'}</h2><p className="native-desk__hint" title="j / k to move · Enter to review">j / k · ↵</p></div>
          {surface === 'today' ? (
            <>
              <section className="native-desk__lane" aria-label="Local commitments" tabIndex={0}>
                <h2>
                  <Phone size={14} aria-hidden="true" /><span className="native-desk__lane-label">Local commitments</span><span className="native-desk__count">{formatVisibleCount(retainedCount)}</span>
                </h2>
                {localRead && <RetainedWork read={localRead.retained} selected={selected} onSelect={select} />}
              </section>
              <section className="native-desk__lane" aria-label="Calls" tabIndex={0}>
                <h2>
                  <Phone size={14} aria-hidden="true" /><span className="native-desk__lane-label">Calls</span><span className="native-desk__count">{formatVisibleCount(callCount)}</span>
                </h2>
                {!snapshot.calls.accountIds.length ? (
                  <details><summary>About queued calls</summary><p>Calls require saved contact and phone-route evidence and applicable owner permission. <a href="#/settings" onClick={() => openSettingsSection('phone')}>Phone settings</a> configure calling, not permission. <a href="#/settings" onClick={() => openSettingsSection('worker')}>Worker settings</a> configure worker access. Setup alone does not queue or place a call.</p></details>
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
                workspaceId={snapshot.workspaceId}
                unavailable={unavailableScope}
                items={snapshot.answers}
                selected={selected}
                name={name}
                onSelect={select}
              />
              {onOpenLocalDraft && <LocalDraftContinuations drafts={localDrafts} onOpen={onOpenLocalDraft} />}
              <UpcomingMeetings
                unavailable={unavailableScope}
                items={snapshot.meetings}
                selected={selected}
                name={name}
                onSelect={select}
              />
            </>
          ) : surface === 'accounts' ? (
            <>
            {localRead && <LocalAccountLibrary intake={intake} read={localRead.overview} selected={selected} onSelect={select} onStep={(key, step) => {
              const accountId = localAccounts.find(item => localAccountKey(item.account.id) === key)?.account.id;
              if (accountId !== undefined && select(key)) onStep?.({ accountId, step });
            }} />}
            <section className="native-desk__lane">
              <h2>
                Worker accounts <span>{formatVisibleCount(workerCount(snapshot.accounts.length))}</span>
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
              {!snapshot.accounts.length && <p>{unavailableScope ? 'Worker-scoped accounts are unavailable.' : 'No stored accounts.'}</p>}
            </section>
            </>
          ) : (
            <section className="native-desk__lane">
              <h2>
                Saved campaign versions <span>{formatVisibleCount(workerCount(snapshot.campaigns.length))}</span>
              </h2>
              {snapshot.campaigns.map((c) => {
                // Company · channel with a plain state for the two exact templates; the saved id for anything else.
                const label = describeCampaignRow(c, snapshot.accounts);
                return (
                  <button
                    className="native-desk__row"
                    key={c.version.id}
                    data-row-key={`campaign:${c.version.id}`}
                    aria-current={
                      selected === `campaign:${c.version.id}` ? 'true' : undefined
                    }
                    onClick={() => select(`campaign:${c.version.id}`)}
                  >
                    <strong>{label.title}</strong>
                    <span>{label.detail}</span>
                  </button>
                );
              })}
              {!snapshot.campaigns.length && <><p>{unavailableScope ? 'Campaign scope is unavailable.' : 'No saved campaign drafts. A configured worker and active company ownership are required to save one.'}</p><p><a href="#/settings" onClick={() => openSettingsSection('worker')}>Worker settings</a> configure access. Saving a draft does not enroll accounts or activate outreach.</p></>}
            </section>
          )}
        </nav>
        <div className={`native-desk__detail${!retained && !localAccount && !account && !campaign && !meeting && !answer ? ' native-desk__detail--welcome' : ''}`}>
          {selected && (
            <div className="native-desk__detail-bar">
              <span>
                {retained
                  ? 'Existing commitments and relationships'
                  : answer
                  ? answer.kind === 'reply' ? 'Saved reply history' : 'Saved draft continuations'
                  : meeting
                    ? 'Upcoming meeting'
                    : campaign
                      ? campaignCopy ? campaign.version.approvedAt ? `Reviewed ${campaignCopy.campaign}` : `Saved ${campaignCopy.campaign} draft` : 'Read-only campaign preview'
                      : 'Company context'}
              </span>
              <button aria-label="Close details" onClick={closeDetails}>
                Close
              </button>
            </div>
          )}
          {retained && <RetainedWorkDetail entry={retained} />}
          {localAccount && <LocalAccountDetail account={localAccount} api={api.localWorkspace} contactApi={api} continuation={firstUse}
            step={stepRequest?.accountId === localAccount.account.id ? stepRequest : null} onStepHandled={onStepHandled} onEvidenceChanged={onEvidenceChanged} />}
          {account && !answer && <AccountContext account={account} />}{' '}
          {answer && snapshot.workspaceId && (
            <DailyAnswerDetail
              item={answer}
              company={name(answer.accountId)}
              accountDetails={account ? <AccountContext account={account} /> : null}
              workspaceId={snapshot.workspaceId}
              api={api.delegation}
              linkedin={api.linkedin}
              actionHold={actionHold}
            />
          )}{' '}
          {meeting && <MeetingDetail item={meeting} />}{' '}
          {campaign && (
            <>
            <CampaignReview
              campaign={campaign}
              accounts={snapshot.accounts}
              answers={snapshot.answers}
            />
            <ManualLinkedInPreparation api={api} snapshot={snapshot} campaign={campaign} config={configuration}
              readError={readError || !!localHold} onRefresh={onRefresh} />
            {campaignTemplate && <CallCampaignEnrollment key={`${snapshot.workspaceId}:${campaign.version.id}`} api={api} snapshot={snapshot} config={configuration}
              campaign={campaign} readError={readError || !!localHold} onRefresh={onRefresh} />}
            </>
          )}
          {account && (selected?.startsWith('call:') || selected?.startsWith('account:')) && (
            <section className="native-desk__call">
              <CallCard key={JSON.stringify([snapshot.workspaceId, account.account.id, account.account.version])} account={account} api={api.localWorkspace} />
              <CompanyPhoneCall key={JSON.stringify([snapshot.workspaceId, account.account.id])}
                api={api} snapshot={snapshot} config={configuration} accountId={account.account.id}
                readError={phoneReadError} newWorkHold={!!localHold} onRefresh={onRefresh} />
            </section>
          )}
          {!retained && !localAccount && !account && !campaign && !meeting && !answer && (
            <div className="native-desk__welcome">
              <h2>
                {selected
                  ? 'This item is no longer in the local queue.'
                  : keys.length ? 'Make room for a good conversation.' : surface === 'today' ? 'No conversations queued.' : surface === 'accounts' ? 'Your account library starts here.' : 'No saved campaign versions to preview.'}
              </h2>
              <p>
                {selected ? 'Your selection is retained. Refresh to check its saved work.' : keys.length ? 'Select an item to review its company context and exact saved work.' : surface === 'today' ? unavailableScope ? 'Local work remains available. Worker-scoped calls, saved drafts and meetings are unavailable until a workspace is connected.' : 'No work in this local snapshot. Refresh to check for saved conversations and local commitments.' : surface === 'accounts' ? 'Local company evidence will appear here. Local records do not establish worker ownership.' : 'Save a call campaign draft after worker ownership is configured, then review its exact company and offer here. Drafts are not approved, enrolled or active.'}
              </p>
              {!selected && unavailableScope && <a href="#/settings" onClick={() => openSettingsSection('worker')}>Review Settings</a>}
            </div>
          )}
        </div>
      </div>
      <TodayFooter snapshot={snapshot} readError={readError} researchSetup={configuration?.state === 'active' ? api.delegation.researchSetup : undefined} />
    </section>
  );
}
