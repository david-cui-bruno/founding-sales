import {
  addRouteCommandSchema,
  confirmRouteCommandSchema,
  createContactCommandSchema,
  retireRouteCommandSchema,
  updateContactCommandSchema,
  verifyRouteCommandSchema,
} from '@fss/contracts';
import {
  addEmailRoute,
  addPhoneRoute,
  confirmPhoneRoute,
  createContact,
  listContacts,
  retireRoute,
  updateContact,
  verifyRoute,
} from '@fss/domain/crm';
import { REFUSAL_STATUS, contextForPrincipal, redactError, requirePrincipal, runCrmCommand } from './crmSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * Contact and route commands (specification 7.2, 7.4, 9.1).
 *
 * The routes live here rather than in their own module because they are contact data:
 * a route belongs to a contact or to the firm, and the authorization that governs
 * both is the firm's assignment. There is no `/routes/...` path for a caller to reach
 * a number without naming the firm it belongs to.
 *
 * `/contacts/routes/add` takes a `routeKind` and one `value` rather than two shapes,
 * because the command is the same command; which table it lands in is a detail of
 * where an E.164 number is stored and where a lower-cased address is.
 */

const CONTACTS_OF_FIRM = /^\/contacts\/firm\/([0-9a-fA-F-]{36})$/u;

export async function routeContacts(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!request.path.startsWith('/contacts')) return null;
  const auth = options.auth;
  if (auth === undefined) return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };

  const authenticated = await requirePrincipal(auth, request);
  if (!authenticated.ok) return authenticated.result;
  const principal = authenticated.principal;
  const scoped = contextForPrincipal(auth, principal);
  if (!scoped.ok) return scoped.result;
  const deps = { auth, request, principal };

  if (request.method === 'GET' || request.method === 'HEAD') {
    const match = CONTACTS_OF_FIRM.exec(request.path);
    if (match === null) return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
    const contacts = await listContacts(scoped.context, match[1] ?? '');
    return {
      status: 200,
      body: {
        contacts: contacts.map(contact => ({
          id: contact.id,
          fullName: contact.full_name,
          title: contact.title,
          linkedinUrl: contact.linkedin_url,
          status: contact.status,
          isPrimary: contact.is_primary,
        })),
      },
    };
  }

  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }

  switch (request.path) {
    case '/contacts/create':
      return await runCrmCommand(deps, createContactCommandSchema, 'contact.created', async (repository, body) =>
        await createContact(repository, {
          firmId: body.firmId,
          fullName: body.fullName,
          title: body.title,
          linkedinUrl: body.linkedinUrl,
          isPrimary: body.isPrimary,
          externalId: body.externalId,
        }),
      );
    case '/contacts/update':
      return await runCrmCommand(deps, updateContactCommandSchema, 'contact.updated', async (repository, body) =>
        await updateContact(repository, { contactId: body.contactId, patch: body.patch }),
      );
    case '/contacts/routes/add':
      return await runCrmCommand(deps, addRouteCommandSchema, 'route.added', async (repository, body) => {
        const shared = {
          firmId: body.firmId,
          contactId: body.contactId,
          source: body.source,
          associationConfidence: body.associationConfidence,
          technicalValidation: body.technicalValidation,
        };
        return body.routeKind === 'phone'
          ? await addPhoneRoute(repository, { ...shared, e164: body.value })
          : await addEmailRoute(repository, { ...shared, address: body.value });
      });
    case '/contacts/routes/verify':
      return await runCrmCommand(deps, verifyRouteCommandSchema, 'route.verified', async (repository, body) =>
        await verifyRoute(repository, {
          routeKind: body.routeKind,
          routeId: body.routeId,
          technicalValidation: body.technicalValidation,
          associationConfidence: body.associationConfidence,
        }),
      );
    case '/contacts/routes/confirm':
      // Lane g88: a person confirms a phone number reaches the firm. The command records
      // who and when (its receipt and its audit event); the route policy decides what
      // the confirmation makes the route, and the version moves with it.
      return await runCrmCommand(deps, confirmRouteCommandSchema, 'route.confirmed', async (repository, body) =>
        await confirmPhoneRoute(repository, { routeId: body.routeId, routeVersion: body.routeVersion }),
      );
    case '/contacts/routes/retire':
      return await runCrmCommand(deps, retireRouteCommandSchema, 'route.retired', async (repository, body) =>
        await retireRoute(repository, {
          routeKind: body.routeKind,
          routeId: body.routeId,
          reason: body.reason,
        }),
      );
    default:
      return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  }
}
