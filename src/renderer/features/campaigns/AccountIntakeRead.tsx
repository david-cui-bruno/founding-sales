import { useLayoutEffect, useMemo, useState } from 'react';
import type { CalliePreloadApi } from '../../../shared/preload';
import { accountPreparationReadReason, accountPreparationReplySchema, type AccountPreparation, type AccountPreparationReadReason } from '../../../shared/contracts/accountPreparationContract';
import { captureDailySessionScope } from '../today/dailySessionScope';
import { AccountIntakeConfigure } from './AccountIntakeConfigure';

type Api = Pick<CalliePreloadApi, 'daily' | 'delegation'>;
export type PreparationStage = 'copy' | 'delegate' | 'active' | 'held';
/** One honest line per allowlisted worker reason. Everything else, including a worker that was
 * never reached, gets the same explicit-retry line. Codes and reply bodies are never shown. */
const reasonLine: Record<AccountPreparationReadReason, string> = {
  preparation_unavailable: 'The worker has no record of this company yet.',
  worker_scope_denied: 'This Mac\'s pairing is not allowed to read this company.',
  preparation_changed: 'The worker\'s record changed during the read. Read again.',
  worker_route_unavailable: 'The connected worker does not offer this request yet. It may need to be updated.',
  worker_unavailable: 'The worker could not be reached or refused the request. Read again to retry explicitly.',
  worker_invalid_request: 'The worker could not be reached or refused the request. Read again to retry explicitly.',
};
const unreachableLine = reasonLine.worker_unavailable;
export function AccountIntakeRead({ api, workspaceId, accountId, disabled, stage, scopeKey }: {
  api: Api;
  workspaceId: string | null;
  accountId: string;
  disabled: boolean;
  /** Intake configuration exists only for a worker-owned company: no request before stage 'active'. */
  stage: PreparationStage;
  scopeKey: string;
}) {
  const held = disabled || stage !== 'active';
  // Only this mounted read, never retained across route/review lifetimes.
  const scope = useMemo(() => ({ alive: false, inflight: false, assertCurrent: () => {} }),
    [api.daily, api.delegation, workspaceId, accountId, held, scopeKey]);
  const [observation, setObservation] = useState<{
    scope: typeof scope; result?: AccountPreparation; error?: { reason: AccountPreparationReadReason | null }; busy?: boolean;
  } | null>(null);
  useLayoutEffect(() => {
    scope.alive = true;
    return () => { scope.alive = false; };
  }, [scope]);
  const current = () => {
    if (!scope.alive || held || !workspaceId || !accountId) return false;
    try { scope.assertCurrent(); return true; } catch { return false; }
  };
  const read = async () => {
    // A fresh explicit read captures a fresh session. Prior-read guards only
    // fence that observation and its continuation, not future user intent.
    if (!scope.alive || held || !workspaceId || !accountId || scope.inflight) return;
    scope.inflight = true;
    setObservation({ scope, busy: true });
    try {
      scope.assertCurrent = captureDailySessionScope(api.delegation, workspaceId!);
      const raw = await api.delegation.getAccountPreparation({ accountId });
      if (!current()) return;
      const result = accountPreparationReplySchema({ workspaceId: workspaceId!, accountId }).parse(raw);
      setObservation({ scope, result });
    } catch (error) {
      if (current()) setObservation({ scope, error: { reason: accountPreparationReadReason(error) } });
    } finally {
      scope.inflight = false;
      if (scope.alive) setObservation(prior => prior?.scope === scope && prior.busy ? null : prior);
    }
  };
  const visible = observation?.scope === scope && current() ? observation : null;
  const result = visible?.result;
  const configuration = result?.configuration;
  return <div aria-label="Intake configuration read">
    <button type="button" disabled={held || !workspaceId || !accountId || !!visible?.busy}
      onClick={() => { void read(); }}>Read intake configuration</button>
    <p>This read does not synchronize queued work or change configuration. Intake configuration is not outreach readiness.</p>
    {(stage === 'copy' || stage === 'delegate') && <p role="status">Intake configuration exists only for a company the worker owns. Copy and delegate this company first.</p>}
    {visible?.busy && <p role="status">Reading intake configuration…</p>}
    {visible?.error && <p role="status">{visible.error.reason ? reasonLine[visible.error.reason] : unreachableLine}</p>}
    {result && <div role="status">
      <p>{configuration ? 'Intake configuration exists.' : 'No intake configuration exists.'}</p>
      <p>Last observed: <time dateTime={result.checkedAt}>{result.checkedAt}</time>. This is not a live readiness check.</p>
      {configuration && <>
        <p>Configuration revision: {configuration.revision}. State: {configuration.state}.</p>
        <p>Mail: {configuration.mailboxSubject === null ? 'unselected' : 'configured'}. Research: {configuration.research === null ? 'not configured' : 'configured'}. Calendar: {configuration.calendarId === null ? 'not configured' : 'configured'}.</p>
        <p>An unselected mailbox does not establish no-mail eligibility. A configured mailbox does not confirm a current grant or mail readiness.</p>
      </>}
    </div>}
    {result && workspaceId && <AccountIntakeConfigure api={api.delegation} workspaceId={workspaceId} accountId={accountId} preparation={result} disabled={held} />}
  </div>;
}
