import { withTransaction } from '@fss/domain/db/queryable.ts';
import { personCreateSchema, personReadSchema, personSourceAddSchema, personSourceChangeSchema, personBridgeSchema, personListSchema, personSourceRecaptureSchema } from '@fss/contracts';
import { createPerson, addSelectedSource, readPerson, changeSelectedSource, bridgeLegacyContacts, listPeople, recaptureSelectedSource } from '@fss/domain/crm/people.ts';
import { contextForPrincipal, requirePrincipal, runRouteCommand } from './routeSupport.ts';
import { redactError } from '../limits.ts';
import type { ApiRequest, RoutingOptions, RouteResult } from './types.ts';
export const PEOPLE_PATHS = ['/crm/people/create', '/crm/people/read', '/crm/people/source/add', '/crm/people/source/delete', '/crm/people/source/restore', '/crm/people/bridge', '/crm/people/list', '/crm/people/source/recapture'] as const;
export async function routePeople(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!(PEOPLE_PATHS as readonly string[]).includes(request.path))
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
  if (request.path === '/crm/people/create')
    return runRouteCommand(deps, personCreateSchema, 'crm.person_created', (context, body) => createPerson(context, body.fullName));
  if (request.path === '/crm/people/source/add')
    return runRouteCommand(deps, personSourceAddSchema, 'crm.source_selected', (context, body) => addSelectedSource(context, body));
  if (request.path === '/crm/people/source/delete' || request.path === '/crm/people/source/restore')
    return runRouteCommand(deps, personSourceChangeSchema, request.path.endsWith('delete') ? 'crm.source_deleted' : 'crm.source_restored', (context, body) => changeSelectedSource(context, body, request.path.endsWith('delete') ? 'delete' : 'restore'));
  if (request.path === '/crm/people/source/recapture')
    return runRouteCommand(deps, personSourceRecaptureSchema, 'crm.source_recaptured', (context, body) => recaptureSelectedSource(context, body));
  if (request.path === '/crm/people/bridge')
    return runRouteCommand(deps, personBridgeSchema, 'crm.people_bridged', (context, body) => bridgeLegacyContacts(context, body.contactIds));
  if (request.path === '/crm/people/list') {
    const parsed = personListSchema.safeParse(request.body);
    if (!parsed.success)
      return { status: 400, body: redactError('malformed_body') };
    return { status: 200, body: await listPeople(scoped.context, parsed.data) };
  }
  const parsed = personReadSchema.safeParse(request.body);
  if (!parsed.success)
    return { status: 400, body: redactError('malformed_body') };
  const page = await withTransaction(options.auth.db, async () => readPerson(scoped.context, parsed.data.personId, parsed.data));
  return page === null ? { status: 404, body: redactError('not_found') } : { status: 200, body: page };
}
