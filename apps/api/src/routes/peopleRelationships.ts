import { addFirmSource, readFirmSources, changeFirmSource } from '@fss/domain/crm/firmSources.ts';
import { claimEndpoint, matchEndpoint, listEndpoints, correctEndpoint } from '@fss/domain/crm/endpoints.ts';
import { relationshipReadSchema, relationshipSaveSchema, relationshipCorrectSchema, sourceContextSaveSchema, endpointClaimSchema, endpointMatchInputSchema, firmSourceAddSchema, firmSourceReadSchema, endpointCorrectSchema, endpointListInputSchema, firmSourceChangeSchema, firmSourceRecaptureSchema } from '@fss/contracts';
import { saveRelationship, readRelationships, correctRelationship, saveSourceContext, readSourceContexts } from '@fss/domain/crm/relationships.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { contextForPrincipal, requirePrincipal, runRouteCommand } from './routeSupport.ts';
import { redactError } from '../limits.ts';
import type { ApiRequest, RoutingOptions, RouteResult } from './types.ts';
export const IDENTITY_PATHS = ['/crm/relationships/save', '/crm/relationships/read', '/crm/relationships/correct', '/crm/relationships/context/save', '/crm/relationships/context/read', '/crm/endpoints/claim', '/crm/endpoints/match', '/crm/firm-sources/add', '/crm/firm-sources/read', '/crm/endpoints/list', '/crm/endpoints/correct', '/crm/firm-sources/delete', '/crm/firm-sources/restore', '/crm/firm-sources/recapture'] as const;
export async function routePeopleRelationships(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!(IDENTITY_PATHS as readonly string[]).includes(request.path))
    return null;
  if (options.auth === undefined)
    return { status: 401, body: redactError('unauthenticated') };
  const verified = await requirePrincipal(options.auth, request);
  if (!verified.ok)
    return verified.result;
  const scoped = contextForPrincipal(options.auth, verified.principal);
  if (!scoped.ok)
    return scoped.result;
  if (request.method !== 'POST')
    return { status: 405, body: redactError('method_not_allowed') };
  const deps = { auth: options.auth, request, principal: verified.principal };
  if (request.path === '/crm/relationships/save')
    return runRouteCommand(deps, relationshipSaveSchema, 'crm.relationship_saved', (context, body) => saveRelationship(context, body));
  if (request.path === '/crm/relationships/correct')
    return runRouteCommand(deps, relationshipCorrectSchema, 'crm.relationship_corrected', (context, body) => correctRelationship(context, body));
  if (request.path === '/crm/relationships/context/save')
    return runRouteCommand(deps, sourceContextSaveSchema, 'crm.source_context_selected', (context, body) => saveSourceContext(context, body));
  if (request.path === '/crm/endpoints/claim')
    return runRouteCommand(deps, endpointClaimSchema, 'crm.endpoint_claimed', (context, body) => claimEndpoint(context, body));
  if (request.path === '/crm/endpoints/match') {
    const parsed = endpointMatchInputSchema.safeParse(request.body);
    if (!parsed.success)
      return { status: 400, body: redactError('malformed_body') };
    const answer = await withTransaction(options.auth.db, () => matchEndpoint(scoped.context, parsed.data));
    return answer === null ? { status: 404, body: redactError('not_found') } : { status: 200, body: answer };
  }
  if (request.path === '/crm/firm-sources/add')
    return runRouteCommand(deps, firmSourceAddSchema, 'crm.firm_source_selected', (context, body) => addFirmSource(context, body));
  if (request.path === '/crm/firm-sources/read') {
    const parsed = firmSourceReadSchema.safeParse(request.body);
    if (!parsed.success)
      return { status: 400, body: redactError('malformed_body') };
    const answer = await withTransaction(options.auth.db, () => readFirmSources(scoped.context, parsed.data));
    return answer === null ? { status: 404, body: redactError('not_found') } : { status: 200, body: answer };
  }
  if (request.path === '/crm/endpoints/correct')
    return runRouteCommand(deps, endpointCorrectSchema, 'crm.endpoint_corrected', (context, body) => correctEndpoint(context, body));
  if (request.path === '/crm/endpoints/list') {
    const parsed = endpointListInputSchema.safeParse(request.body);
    if (!parsed.success)
      return { status: 400, body: redactError('malformed_body') };
    const answer = await withTransaction(options.auth.db, () => listEndpoints(scoped.context, parsed.data));
    return answer === null ? { status: 404, body: redactError('not_found') } : { status: 200, body: answer };
  }
  if (request.path === '/crm/firm-sources/delete' || request.path === '/crm/firm-sources/restore')
    return runRouteCommand(deps, firmSourceChangeSchema, request.path.endsWith('delete') ? 'crm.firm_source_deleted' : 'crm.firm_source_restored', (context, body) => changeFirmSource(context, body, request.path.endsWith('delete') ? 'delete' : 'restore'));
  if (request.path === '/crm/firm-sources/recapture')
    return runRouteCommand(deps, firmSourceRecaptureSchema, 'crm.firm_source_recaptured', (context, body) => changeFirmSource(context, body, 'recapture'));
  const parsed = relationshipReadSchema.safeParse(request.body);
  if (!parsed.success)
    return { status: 400, body: redactError('malformed_body') };
  const answer = await withTransaction<unknown>(options.auth.db, () => request.path === '/crm/relationships/context/read' ? readSourceContexts(scoped.context, parsed.data) : readRelationships(scoped.context, parsed.data));
  return answer === null ? { status: 404, body: redactError('not_found') } : { status: 200, body: answer };
}
