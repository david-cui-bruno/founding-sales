import { createHash } from 'node:crypto';
import { dailySnapshotSchema, type DailySnapshot, type DailyAnswer, type DailyIssue } from '../../../shared/contracts/dailyContract';
export type DailyProjectionInput = Omit<DailySnapshot, 'revision' | 'freshness' | 'answers' | 'workflowMode'> & {
  generatedAt: string; workflowMode?: DailySnapshot['workflowMode']; approvals: DailyAnswer[];
};
/** `allocation` and `usage` are both derived and both excluded from the hash below. */
/** Pure local presentation projection. No authorization, calendar synthesis or execution. */
export function buildDailySnapshot(input: DailyProjectionInput): DailySnapshot {
  const ids = new Set(input.accounts.map(a => a.account.id));
  const issueCounts = new Map<DailyIssue['code'], number>();
  const add = (code: DailyIssue['code'], count = 1) => issueCounts.set(code, (issueCounts.get(code) ?? 0) + count);
  input.issues.forEach(i => add(i.code, i.count));
  if (input.workspaceId === null) add('scope_unknown');
  const scoped = <T extends { accountId: string }>(values: T[]) => values.filter(v => {
    if (ids.has(v.accountId) && input.workspaceId !== null) return true;
    add('scope_mismatch'); return false;
  });
  const answers = scoped(input.approvals);
  const meetings = scoped(input.meetings);
  const ownerStatus = scoped(input.ownerStatus);
  const callbacks = scoped([...(input.callbacks ?? [])]);
  const inScope = (accountId: string) => {
    if (ids.has(accountId) && input.workspaceId !== null) return true;
    add('scope_mismatch'); return false;
  };
  const accountIds = input.calls.accountIds.filter(id => inScope(id));
  // A sent sequence email is real content and changes the revision, but only once one exists: an empty list
  // is absent from `calls` entirely, so a workspace that has never sent one keeps the exact revision it had.
  const sentTemplateEmails = (input.calls.sentTemplateEmails ?? []).filter(email => inScope(email.accountId));
  // A held email step is real content and changes the revision on the same terms: an empty list is absent from
  // `calls` entirely, so a workspace with nothing waiting keeps the exact revision it had.
  const heldTemplateEmails = (input.calls.heldTemplateEmails ?? []).filter(email => inScope(email.accountId));
  const calls = { accountIds, workloadConflict: input.calls.workloadConflict,
    ...(sentTemplateEmails.length ? { sentTemplateEmails } : {}),
    ...(heldTemplateEmails.length ? { heldTemplateEmails } : {}) };
  if (calls.workloadConflict) add('workload_conflict');
  const issues = [...issueCounts].sort(([a], [b]) => a.localeCompare(b)).map(([code, count]) => ({ code, count }));
  const content = { workspaceId: input.workspaceId, workflowMode: input.workflowMode ?? 'unknown', accounts: input.workspaceId === null ? [] : input.accounts,
    calls, callSettings: input.callSettings, answers, meetings, campaigns: input.workspaceId === null ? [] : input.campaigns, ownerStatus, transport: input.workspaceId === null ? [] : input.transport, issues };
  // The allocation is derived from callSettings, so it stays outside the hashed content and every stored revision is unchanged.
  // Callbacks are real content and do change the revision, but only once one exists: an empty list is absent from the hash,
  // so a workspace that has never promised a callback keeps the exact revision it had before schema 29.
  const hashed = callbacks.length ? { ...content, callbacks } : content;
  return dailySnapshotSchema.parse({ ...hashed, ...(input.allocation ? { allocation: input.allocation } : {}), ...(input.usage ? { usage: input.usage } : {}),
    revision: createHash('sha256').update(JSON.stringify(hashed)).digest('hex'),
    freshness: { kind: issues.length ? 'incomplete' : 'local_snapshot', generatedAt: input.generatedAt, remote: 'unknown' } });
}
