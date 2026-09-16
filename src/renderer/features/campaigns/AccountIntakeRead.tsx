import { useLayoutEffect, useMemo, useState } from 'react';
import type { CalliePreloadApi } from '../../../shared/preload';
import { accountPreparationReplySchema, type AccountPreparation } from '../../../shared/contracts/accountPreparationContract';
import { captureDailySessionScope } from '../today/dailySessionScope';
import { AccountIntakeConfigure } from './AccountIntakeConfigure';

type Api = Pick<CalliePreloadApi, 'daily' | 'delegation'>;
export function AccountIntakeRead({ api, workspaceId, accountId, disabled, scopeKey }: {
  api: Api;
  workspaceId: string | null;
  accountId: string;
  disabled: boolean;
  scopeKey: string;
}) {
  // Only this mounted read, never retained across route/review lifetimes.
  const scope = useMemo(() => ({ alive: false, inflight: false, assertCurrent: () => {} }),
    [api.daily, api.delegation, workspaceId, accountId, disabled, scopeKey]);
  const [observation, setObservation] = useState<{
    scope: typeof scope; result?: AccountPreparation; error?: boolean; busy?: boolean;
  } | null>(null);
  useLayoutEffect(() => {
    scope.alive = true;
    return () => { scope.alive = false; };
  }, [scope]);
  const current = () => {
    if (!scope.alive || disabled || !workspaceId || !accountId) return false;
    try { scope.assertCurrent(); return true; } catch { return false; }
  };
  const read = async () => {
    // A fresh explicit read captures a fresh session. Prior-read guards only
    // fence that observation and its continuation, not future user intent.
    if (!scope.alive || disabled || !workspaceId || !accountId || scope.inflight) return;
    scope.inflight = true;
    setObservation({ scope, busy: true });
    try {
      scope.assertCurrent = captureDailySessionScope(api.delegation, workspaceId!);
      const raw = await api.delegation.getAccountPreparation({ accountId });
      if (!current()) return;
      const result = accountPreparationReplySchema({ workspaceId: workspaceId!, accountId }).parse(raw);
      setObservation({ scope, result });
    } catch {
      if (current()) setObservation({ scope, error: true });
    } finally {
      scope.inflight = false;
      if (scope.alive) setObservation(prior => prior?.scope === scope && prior.busy ? null : prior);
    }
  };
  const visible = observation?.scope === scope && current() ? observation : null;
  const result = visible?.result;
  const configuration = result?.configuration;
  return <div aria-label="Intake configuration read">
    <button type="button" disabled={disabled || !workspaceId || !accountId || !!visible?.busy}
      onClick={() => { void read(); }}>Read intake configuration</button>
    <p>This read does not synchronize queued work or change configuration. Intake configuration is not outreach readiness.</p>
    {visible?.busy && <p role="status">Reading intake configuration…</p>}
    {visible?.error && <p role="status">Intake configuration could not be read. Read again to retry explicitly.</p>}
    {result && <div role="status">
      <p>{configuration ? 'Intake configuration exists.' : 'No intake configuration exists.'}</p>
      <p>Last observed: <time dateTime={result.checkedAt}>{result.checkedAt}</time>. This is not a live readiness check.</p>
      {configuration && <>
        <p>Configuration revision: {configuration.revision}. State: {configuration.state}.</p>
        <p>Mail: {configuration.mailboxSubject === null ? 'unselected' : 'configured'}. Research: {configuration.research === null ? 'not configured' : 'configured'}. Calendar: {configuration.calendarId === null ? 'not configured' : 'configured'}.</p>
        <p>An unselected mailbox does not establish no-mail eligibility. A configured mailbox does not confirm a current grant or mail readiness.</p>
      </>}
    </div>}
    {result && workspaceId && <AccountIntakeConfigure api={api.delegation} workspaceId={workspaceId} accountId={accountId} preparation={result} disabled={disabled} />}
  </div>;
}
