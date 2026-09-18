import { createHash } from 'node:crypto';
import { dailySnapshotSchema, type DailySnapshot, type DailyAnswer, type DailyIssue } from '../../../shared/contracts/dailyContract';
export type DailyProjectionInput = Omit<DailySnapshot, 'revision' | 'freshness' | 'answers' | 'workflowMode'> & {
  generatedAt: string; workflowMode?: DailySnapshot['workflowMode']; approvals: DailyAnswer[];
};
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
  const calls = { ...input.calls, accountIds: input.calls.accountIds.filter(id => {
    if (ids.has(id) && input.workspaceId !== null) return true;
    add('scope_mismatch'); return false;
  }) };
  if (calls.workloadConflict) add('workload_conflict');
  const issues = [...issueCounts].sort(([a], [b]) => a.localeCompare(b)).map(([code, count]) => ({ code, count }));
  const content = { workspaceId: input.workspaceId, workflowMode: input.workflowMode ?? 'unknown', accounts: input.workspaceId === null ? [] : input.accounts,
    calls, callSettings: input.callSettings, answers, meetings, campaigns: input.workspaceId === null ? [] : input.campaigns, ownerStatus, transport: input.workspaceId === null ? [] : input.transport, issues };
  // The allocation is derived from callSettings, so it stays outside the hashed content and every stored revision is unchanged.
  return dailySnapshotSchema.parse({ ...content, ...(input.allocation ? { allocation: input.allocation } : {}), revision: createHash('sha256').update(JSON.stringify(content)).digest('hex'),
    freshness: { kind: issues.length ? 'incomplete' : 'local_snapshot', generatedAt: input.generatedAt, remote: 'unknown' } });
}
