import { isDeepStrictEqual } from 'node:util';
import { campaignOpeningApproveCommandSchema, campaignOpeningRevokeCommandSchema, campaignOpeningControlRequestSchema,
  campaignOpeningCommandResultSchema } from '@fss/contracts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { approveCampaignOpening, revokeCampaignOpening, readCampaignOpeningControl, assertCampaignOpeningControlCommit,
  CampaignOpeningControlChanged } from '@fss/domain/outreach/campaignOpeningControl.ts';
import { openingAdmin } from '@fss/domain/outreach/campaignOpeningControlRead.ts';
import { runCommand } from '../auth/commands.ts';
import { requirePrincipal, contextForPrincipal, commandReply, type RouteDeps } from './routeSupport.ts';
import { retainedPrincipalAuthority } from './retainedPrincipalAuthority.ts';
import { campaignOpeningReceipt } from './campaignOpeningReceipt.ts';
import type { ApiRequest, RoutingOptions, RouteResult } from './types.ts';
export const CAMPAIGN_OPENING_CONTROL_PATHS = ['/outreach/email-campaigns/opening/control', '/outreach/email-campaigns/opening/approve',
  '/outreach/email-campaigns/opening/revoke', '/outreach/email-campaigns/opening/receipt'] as const;
export async function routeCampaignOpeningControl(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!(CAMPAIGN_OPENING_CONTROL_PATHS as readonly string[]).includes(request.path)) return null;
  if (request.method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } };
  const auth = options.auth;
  if (!auth) return { status: 404, body: { error: 'not_found' } };
  const initial = await requirePrincipal(auth, request);
  if (!initial.ok) return initial.result;
  const principal = initial.principal, scoped = contextForPrincipal(auth, principal);
  if (!scoped.ok) return scoped.result;
  if (principal.role !== 'admin') return { status: 403, body: { error: 'admin_required' } };
  const deps: RouteDeps = { auth, request, principal };
  try {
    let result: RouteResult;
    if (request.path.endsWith('/receipt')) result = await campaignOpeningReceipt(deps);
    else if (request.path.endsWith('/control')) {
      const input = campaignOpeningControlRequestSchema.safeParse(request.body);
      if (!input.success) return { status: 400, body: { error: 'malformed_body' } };
      const control = await withTransaction(auth.db, () => readCampaignOpeningControl(scoped.context, input.data, retainedPrincipalAuthority(deps, scoped.context)));
      result = control ? { status: 200, body: control } : { status: 404, body: { error: 'opening_control_unavailable' } };
    } else result = await mutateOpening(deps);
    // Both existing-receipt and unique-winner replays bypass command beforeCommit.
    const current = await requirePrincipal(auth, request);
    if (!current.ok || !isDeepStrictEqual(principal, current.principal)) return { status: 401, body: { error: 'unauthenticated' } };
    return result;
  } catch (error) {
    if (error instanceof CampaignOpeningControlChanged) return { status: error.reason === 'authority_changed' ? 401 : 409, body: { error: 'opening_control_changed' } };
    throw error;
  }
}
async function mutateOpening(deps: RouteDeps): Promise<RouteResult> {
  const approving = deps.request.path.endsWith('/approve');
  const parsed = (approving ? campaignOpeningApproveCommandSchema : campaignOpeningRevokeCommandSchema).safeParse(deps.request.body);
  if (!parsed.success) return { status: 400, body: { error: 'malformed_body' } };
  const { commandId, clientVersion, ...payload } = parsed.data;
  let accepted = false;
  const outcome = await runCommand(deps.auth, deps.principal, { commandId, clientVersion,
    kind: approving ? 'outreach.campaign_opening_approve' : 'outreach.campaign_opening_revoke', payload }, async ctx => {
    const authority = retainedPrincipalAuthority(deps, ctx);
    const result = 'variants' in payload ? await approveCampaignOpening(ctx, payload, authority) : await revokeCampaignOpening(ctx, payload, authority);
    accepted = result.ok;
    return result.ok ? { status: 'accepted', result: campaignOpeningCommandResultSchema.parse(result.value) } : { status: 'refused', reason: result.reason };
  }, async ctx => {
    const authority = retainedPrincipalAuthority(deps, ctx);
    if (accepted) await assertCampaignOpeningControlCommit(ctx, payload, authority);
    else if (!await openingAdmin(ctx) || !await authority()) throw new CampaignOpeningControlChanged('authority_changed');
  });
  // Schema-check historical results too. They never become a content read.
  if (outcome.status === 'accepted') campaignOpeningCommandResultSchema.parse(outcome.result);
  return commandReply(outcome);
}
