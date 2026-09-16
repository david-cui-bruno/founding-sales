import { useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { CalliePreloadApi } from '../../../shared/preload';
import { dailySnapshotSchema, type DailySnapshot, type DailyAnswer } from '../../../shared/contracts/dailyContract';
import { localDelegationStatusSchema } from '../../../shared/contracts/ownerCommandContract';
import { linkedInDraftSchema, type LinkedInDraft } from '../../../shared/contracts/linkedInContract';
import type { Enrollment } from '../../../shared/contracts/campaignContract';
import { sha256Utf8 } from '../../../shared/crypto/sha256';
import { captureDailySessionScope } from '../today/dailySessionScope';
import { LinkedInStep } from './LinkedInStep';

type Api = Pick<CalliePreloadApi, 'daily' | 'delegation' | 'linkedin'>;
type Campaign = DailySnapshot['campaigns'][number];
type Config = Awaited<ReturnType<Api['delegation']['status']>>;
type Answer = Extract<DailyAnswer, { kind: 'manual_linkedin' }>;
export type ManualLinkedInPreparationProps = {
  api: Api; snapshot: DailySnapshot; campaign: Campaign; config: Config | null;
  readError: boolean; onRefresh(): void;
};
type Attempt = { busy: boolean; uncertain: boolean; retryReady: boolean; listeners: Set<() => void> };
class PreparationHold extends Error {}
const attempts = new WeakMap<Api['linkedin'], Map<string, Attempt>>();
function attemptFor(api: Api['linkedin'], key: string) {
  let values = attempts.get(api);
  if (!values) attempts.set(api, values = new Map());
  const existing = values.get(key);
  if (existing) return existing;
  if (values.size >= 32) {
    const idle = [...values].find(([, value]) => !value.busy && !value.uncertain && !value.listeners.size);
    if (!idle) return null;
    values.delete(idle[0]);
  }
  const value: Attempt = { busy: false, uncertain: false, retryReady: false, listeners: new Set() };
  values.set(key, value);
  return value;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const notify = (value: Attempt) => value.listeners.forEach(listener => listener());
function owner(snapshot: DailySnapshot, accountId: string) {
  return snapshot.ownerStatus.find(value => value.accountId === accountId);
}
function hold(snapshot: DailySnapshot, config: Config | null, readError: boolean, accountId: string) {
  if (readError || snapshot.workspaceId === null || snapshot.workflowMode !== 'meeting_first'
    || snapshot.issues.some(issue => ['scope_unknown', 'scope_mismatch', 'invalid_local_record'].includes(issue.code))) return 'Local context unavailable. Refresh before preparing a note.';
  const parsed = localDelegationStatusSchema.safeParse(config);
  if (!parsed.success || parsed.data.workspaceId !== snapshot.workspaceId || parsed.data.state !== 'active'
    || !parsed.data.endpoint || parsed.data.configuration?.configuration.state !== 'active') return 'Active workspace configuration is required.';
  const current = owner(snapshot, accountId);
  if (current?.authority?.accountId !== accountId || current.authority.owner !== 'worker'
    || current.authority.state !== 'active' || current.executionVersion === null) return 'Active account owner is required.';
  if (current.pendingCommands.length) return 'Owner commands are pending. Preparation does not synchronize or submit queued outreach.';
  return undefined;
}
function binding(snapshot: DailySnapshot, campaign: Campaign, enrollment: Enrollment) {
  if (snapshot.workspaceId === null || enrollment.state !== 'active' || enrollment.campaignVersionId !== campaign.version.id
    || !campaign.version.approvedAt || campaign.version.approvedAt > new Date().toISOString()
    || !campaign.version.cohortAccountIds.includes(enrollment.accountId)
    || !campaign.version.steps.some(step => step.id === enrollment.currentStepId && step.channel === 'linkedin')) return null;
  const account = snapshot.accounts.find(value => value.account.id === enrollment.accountId);
  const routes = account?.routes.filter(route => route.id === enrollment.selectedRouteId) ?? [];
  const route = routes.find(value => value.version === enrollment.selectedRouteVersion);
  if (!account || !route || routes.some(value => value.version > route.version || value.version === route.version && !same(value, route))
    || route.accountId !== enrollment.accountId || route.personId !== enrollment.personId || route.channel !== 'linkedin'
    || route.purpose !== 'business' || !['published', 'confirmed'].includes(route.verification) || !route.evidenceIds.length
    || !/^https:\/\/(?:www\.)?linkedin\.com\/(?:in\/[A-Za-z0-9_-]+|messaging\/thread\/[A-Za-z0-9_-]+)\/?$/.test(route.value)) return null;
  return { workspaceId: snapshot.workspaceId, campaign, enrollment, account, route };
}
type Binding = NonNullable<ReturnType<typeof binding>>;
function matches(draft: LinkedInDraft, value: Binding) {
  const { enrollment: e, route } = value;
  return draft.workspaceId === value.workspaceId && draft.accountId === e.accountId && draft.campaignVersionId === e.campaignVersionId
    && draft.enrollmentId === e.id && draft.stepId === e.currentStepId && draft.routeId === route.id && draft.routeVersion === route.version
    && draft.personId === e.personId && draft.contextRevision === e.contextRevision && draft.executionContextId === e.executionContextId
    && draft.contentHash === sha256Utf8(draft.body) && draft.targetHash === sha256Utf8(route.value);
}
function saved(snapshot: DailySnapshot, value: Binding): Answer | null {
  const related = snapshot.answers.filter((answer): answer is Answer => answer.kind === 'manual_linkedin'
    && answer.draft.enrollmentId === value.enrollment.id && answer.draft.stepId === value.enrollment.currentStepId
    && answer.draft.executionContextId === value.enrollment.executionContextId && answer.draft.contextRevision === value.enrollment.contextRevision);
  if (!related.length) return null;
  const answer = related[0];
  if (related.length !== 1 || answer.accountId !== value.enrollment.accountId || !matches(answer.draft, value)
    || answer.recovery.draftId !== answer.draft.id || answer.recovery.revision !== answer.draft.revision) throw new PreparationHold('Saved note identity changed. Refresh and review the current enrollment.');
  return answer;
}

/** Preparation is local reads plus explicit generation only. Never calls owner sync. */
export function ManualLinkedInPreparation(props: ManualLinkedInPreparationProps) {
  const parsed = dailySnapshotSchema.safeParse(props.snapshot);
  if (!parsed.success) return null;
  const campaign = parsed.data.campaigns.find(value => same(value, props.campaign));
  if (!campaign || !campaign.version.steps.some(step => step.channel === 'linkedin')) return null;
  const active = campaign.enrollments.filter(enrollment => enrollment.state === 'active'
    && campaign.version.steps.some(step => step.id === enrollment.currentStepId && step.channel === 'linkedin'));
  return <section aria-label="Manual LinkedIn preparation">
    <h3>Prepare an enrolled LinkedIn step</h3>
    <p>Existing enrollments only. Preparing generates a saved note, not a send. It does not synchronize queued owner commands. You send manually in LinkedIn.</p>
    {!active.length && <p>No active LinkedIn enrollment is available. Creating or enrolling a LinkedIn campaign is not available here.</p>}
    {active.map(enrollment => <EnrollmentPreparation key={JSON.stringify([props.snapshot.workspaceId, enrollment])} {...props} enrollment={enrollment} />)}
  </section>;
}
function EnrollmentPreparation({ api, snapshot, campaign, config, readError, onRefresh, enrollment }: ManualLinkedInPreparationProps & { enrollment: Enrollment }) {
  const value = binding(snapshot, campaign, enrollment);
  const attemptKey = JSON.stringify([snapshot.workspaceId, enrollment]);
  const attempt = useMemo(() => attemptFor(api.linkedin, attemptKey), [api.linkedin, attemptKey]);
  const [, render] = useReducer(n => n + 1, 0);
  const [error, setError] = useState('');
  const [openedId, setOpenedId] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<{ answer: Answer; baseline: DailySnapshot } | null>(null);
  const lifetime = useRef(0);
  const actionHold = hold(snapshot, config, readError, enrollment.accountId) ?? (!value ? 'The exact business LinkedIn route or enrollment is unavailable.' : undefined);
  const guard = JSON.stringify([snapshot, campaign, config, readError]);
  useLayoutEffect(() => {
    lifetime.current++;
    attempt?.listeners.add(render);
    return () => { lifetime.current++; attempt?.listeners.delete(render); };
  }, [api.daily, api.delegation, api.linkedin, attempt, guard]);
  let projected: Answer | null = null;
  let projectionError = '';
  try { projected = value ? saved(snapshot, value) : null; } catch (failure) {
    projectionError = failure instanceof PreparationHold ? failure.message : 'Saved note unavailable. Refresh the local workspace.';
  }
  const answer = accepted?.baseline === snapshot ? accepted.answer : projected;
  const run = async (retryGeneration = false) => {
    if (!attempt || attempt.busy || actionHold || !value || projectionError || retryGeneration && !attempt.retryReady) return;
    attempt.busy = true;
    notify(attempt);
    setError('');
    const epoch = lifetime.current;
    let isCurrent = () => epoch === lifetime.current;
    try {
      const scope = captureDailySessionScope(api.linkedin, value.workspaceId);
      const ownerScope = captureDailySessionScope(api.delegation, value.workspaceId);
      isCurrent = () => { if (epoch !== lifetime.current) return false; try { scope(); ownerScope(); return true; } catch { return false; } };
      const read = async () => {
        const fresh = dailySnapshotSchema.parse(await api.daily.get());
        if (!isCurrent()) throw new PreparationHold('Context changed. Reopen the current enrollment.');
        const freshConfig = localDelegationStatusSchema.parse(await api.delegation.status());
        if (!isCurrent()) throw new PreparationHold('Context changed. Reopen the current enrollment.');
        const freshCampaign = fresh.campaigns.find(item => item.version.id === campaign.version.id);
        const freshEnrollment = freshCampaign?.enrollments.find(item => item.id === enrollment.id);
        const next = freshCampaign && freshEnrollment ? binding(fresh, freshCampaign, freshEnrollment) : null;
        if (!next || !same(next, value) || !same(freshConfig, config) || !same(owner(fresh, enrollment.accountId), owner(snapshot, enrollment.accountId))
          || hold(fresh, freshConfig, false, enrollment.accountId)) throw new PreparationHold('Context changed. Refresh before preparing a note.');
        return fresh;
      };
      const before = await read();
      let result = saved(before, value);
      if (!result) {
        if (attempt.uncertain && !retryGeneration) {
          attempt.retryReady = true;
          throw new PreparationHold('No saved note was found and no new generation was attempted. A separate retry may start another model attempt.');
        }
        attempt.uncertain = true; // A lost reply may already have saved a durable note.
        attempt.retryReady = false;
        const draft = linkedInDraftSchema.parse(await api.linkedin.prepare({ enrollmentId: enrollment.id, stepId: enrollment.currentStepId!, expectedVersion: enrollment.version }));
        if (!isCurrent()) return;
        if (!matches(draft, value)) throw new PreparationHold('Prepared note identity mismatch. Recover the saved projection before continuing.');
        result = saved(await read(), value);
        if (!result || !same(result.draft, draft)) throw new PreparationHold('Saved note is not confirmed. Recover its local projection before continuing.');
      }
      if (!isCurrent()) return;
      attempt.uncertain = false;
      attempt.retryReady = false;
      setAccepted({ answer: result, baseline: snapshot });
      setOpenedId(result.draft.id);
      onRefresh();
    } catch (failure) {
      if (isCurrent()) setError(failure instanceof PreparationHold ? failure.message : 'LinkedIn preparation unavailable. Check model configuration, then recover the saved note before explicitly retrying. No send is inferred.');
    } finally {
      attempt.busy = false;
      notify(attempt);
    }
  };
  return <div>
    <p>{value?.account.account.name ?? enrollment.accountId}</p>
    <button disabled={!attempt || attempt.busy || !!actionHold || !!projectionError} onClick={() => void run(attempt?.retryReady ?? false)}>
      {attempt?.busy ? 'Checking saved LinkedIn note…' : attempt?.retryReady ? 'Retry LinkedIn note generation' : attempt?.uncertain ? 'Recover saved LinkedIn note' : projected ? 'Open saved LinkedIn note' : 'Prepare LinkedIn note'}
    </button>
    {attempt?.retryReady && <p>Retry checks the saved note again first. Only if it is still absent will this start a new model attempt. It never sends or synchronizes owner commands.</p>}
    {actionHold && <p>{actionHold}</p>}
    {(error || projectionError) && <p role="alert">{projectionError || error}</p>}
    {!attempt && <p>Other preparation requests need recovery before starting another.</p>}
    {answer && openedId === answer.draft.id && <LinkedInStep item={answer} api={api.linkedin} workspaceId={snapshot.workspaceId!}
      company={value?.account.account.name} actionHold={actionHold ?? (projectionError || undefined)} />}
  </div>;
}
