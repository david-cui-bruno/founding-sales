import { campaignOpeningReceiptInputSchema, campaignOpeningReceiptSchema } from '@fss/contracts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { CampaignOpeningControlChanged } from '@fss/domain/outreach/campaignOpeningControl.ts';
import { openingAdmin } from '@fss/domain/outreach/campaignOpeningControlRead.ts';
import { contextForPrincipal, type RouteDeps } from './routeSupport.ts';
import { retainedPrincipalAuthority } from './retainedPrincipalAuthority.ts';
import type { RouteResult } from './types.ts';
/** Read only. The caller's hash/action cannot authorize replay or policy access. */
export async function campaignOpeningReceipt(deps: RouteDeps): Promise<RouteResult> {
  const parsed = campaignOpeningReceiptInputSchema.safeParse(deps.request.body);
  if (!parsed.success) return { status: 400, body: { error: 'malformed_body' } };
  const scoped = contextForPrincipal(deps.auth, deps.principal);
  if (!scoped.ok) return scoped.result;
  return withTransaction(deps.auth.db, async () => {
    const ctx = scoped.context, authority = retainedPrincipalAuthority(deps, ctx), p = deps.principal;
    if (!await openingAdmin(ctx) || !await authority()) throw new CampaignOpeningControlChanged('authority_changed');
    const row = (await ctx.db.query<{ result_status: string; result: unknown }>(`SELECT r.result_status,r.result FROM command_receipts r
      JOIN devices d ON d.workspace_id=r.workspace_id AND d.id=r.device_id
      WHERE r.workspace_id=$1 AND r.command_id=$2 AND r.device_id=$3 AND d.user_id=$4 AND r.command_kind=$5 AND r.payload_hash=$6`,
    [p.workspaceId, parsed.data.commandId, p.deviceId, p.userId, `outreach.campaign_opening_${parsed.data.action}`, parsed.data.payloadSHA256])).rows[0];
    if (!await openingAdmin(ctx) || !await authority()) throw new CampaignOpeningControlChanged('authority_changed');
    const body = campaignOpeningReceiptSchema.parse(!row ? { state: 'unknown' } : row.result_status === 'accepted'
      ? { state: 'accepted', result: row.result } : { state: 'refused', reason: typeof row.result === 'string' ? row.result : 'refused' });
    return { status: 200, body };
  });
}
