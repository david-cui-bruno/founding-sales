import type { RepositoryContext } from '../db/workspaceScope.ts';

/** Minimum spacing for cold sends. Spend the allowance across at least an hour,
 * keeping the existing 10am default inside the 9–11am recipient window.
 * This is an operating policy, not a guarantee of inbox placement.
 */
export function prospectingSpacingMilliseconds(cap: number): number {
  return Math.max(60_000, Math.ceil(3_600_000 / Math.max(1, cap)));
}

/** Called only after decideSend has locked this mailbox's send-day row inside
 * the claim transaction. Concurrent claims serialize there, then see the prior
 * committed claim. Count ambiguous sends as activity: they must never be retried.
 * Replies can leave promptly, but their activity also spaces later cold mail.
 */
export async function prospectingRetryAt(
  context: RepositoryContext,
  input: { readonly mailboxId: string; readonly cap: number; readonly now: string },
): Promise<string | null> {
  const { rows } = await context.db.query<{ last_claim: Date | null }>(
    `SELECT max(dispatch_started_at) AS last_claim FROM outbound_messages
      WHERE workspace_id = $1 AND mailbox_id = $2`,
    [context.scope.workspaceId, input.mailboxId],
  );
  const last = rows[0]?.last_claim;
  if (last === null || last === undefined) return null;
  const retryAt = last.getTime() + prospectingSpacingMilliseconds(input.cap);
  return retryAt > Date.parse(input.now) ? new Date(retryAt).toISOString() : null;
}
