import type { RepositoryContext } from '../db/workspaceScope.ts';
import { lockSendGateForStopFact } from '../policy/sendGate.ts';
/** Root registers with the existing evidence retention target. No new job or
 * service. Expiry removes derived content, never opaque attempts/admission caps. */
export async function sweepCampaignOpenings(ctx: RepositoryContext, input: { limit: number }): Promise<number> {
  await lockSendGateForStopFact(ctx);
  const result = await ctx.db.query<{ count: number }>('SELECT sweep_campaign_openings($1,$2) AS count', [ctx.scope.workspaceId, input.limit]);
  return result.rows[0]?.count ?? 0;
}
/** Register before the existing manual-source denial/audit cleanup removes its
 * source predicate. URLs remain input only, never stored in attempt history. */
export async function eraseCampaignOpeningsForSources(ctx: RepositoryContext, urls: readonly string[]): Promise<number> {
  if (!urls.length) return 0;
  await lockSendGateForStopFact(ctx);
  const result = await ctx.db.query<{ count: number }>('SELECT erase_campaign_opening_sources($1,$2::text[]) AS count', [ctx.scope.workspaceId, urls]);
  return result.rows[0]?.count ?? 0;
}
