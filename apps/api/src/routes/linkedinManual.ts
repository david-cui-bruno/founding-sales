import { linkedinManualBindCommandSchema, linkedinManualRecordCommandSchema, linkedinManualReadSchema } from '@fss/contracts';
import { bindLinkedinManual, recordLinkedinManual } from '@fss/domain/crm/linkedinManual.ts';
import { readLinkedinManual } from '@fss/domain/crm/linkedinManualRead.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { contextForPrincipal, requirePrincipal, runRouteCommand } from './routeSupport.ts';
import type { ApiRequest, RoutingOptions, RouteResult } from './types.ts';

export const LINKEDIN_MANUAL_PATHS = ['/crm/linkedin/manual/read', '/crm/linkedin/manual/bind', '/crm/linkedin/manual/record'] as const;
export async function routeLinkedinManual(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!(LINKEDIN_MANUAL_PATHS as readonly string[]).includes(request.path)) return null;
  if (request.method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } };
  const auth = options.auth;
  if (!auth) return { status: 401, body: { error: 'unauthenticated' } };
  const verified = await requirePrincipal(auth, request);
  if (!verified.ok) return verified.result;
  const scoped = contextForPrincipal(auth, verified.principal);
  if (!scoped.ok) return scoped.result;
  const deps = { auth, request, principal: verified.principal };
  if (request.path === '/crm/linkedin/manual/bind') return runRouteCommand(deps, linkedinManualBindCommandSchema, 'linkedin_manual_bind', (ctx, body) => {
    const { commandId: _id, clientVersion: _version, ...input } = body;
    return bindLinkedinManual(ctx, input);
  });
  if (request.path === '/crm/linkedin/manual/record') return runRouteCommand(deps, linkedinManualRecordCommandSchema, 'linkedin_manual_record', (ctx, body) => {
    const { commandId: _id, clientVersion: _version, ...input } = body;
    return recordLinkedinManual(ctx, input);
  });
  const parsed = linkedinManualReadSchema.safeParse(request.body);
  if (!parsed.success) return { status: 400, body: { error: 'malformed_body' } };
  const view = await withTransaction(auth.db, () => readLinkedinManual(scoped.context, parsed.data));
  return view ? { status: 200, body: view } : { status: 404, body: { error: 'not_found' } };
}
