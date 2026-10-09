import {readMailConversationV2} from '@fss/domain/mail/crmMailOriginals.ts';
import {
  mailSourceStateReadSchema,
  mailSourceAssociateSchema,
  mailSourcesListSchema,
  mailSourceChangeSchema,
  mailControlsReadSchema,
  mailSourceReadSchema,
} from '@fss/contracts';
import {
  requestMailRecapture,
  readMailSourceState,
  associateMailSource,
  listMailSources,
  changeMailSource,
  readMailCaptureControls,
  readMailConversation,
  resolveMailSource,
} from '@fss/domain/mail/crmSources.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import {
  contextForPrincipal,
  requirePrincipal,
  runRouteCommand,
} from './routeSupport.ts';
import { redactError } from '../limits.ts';
import type { ApiRequest, RoutingOptions, RouteResult } from './types.ts';
export const BUSINESS_MAIL_PATHS = [
  '/crm/business/mail/read',
  '/crm/business/mail/read/v2',
  '/crm/business/mail/state/read',
  '/crm/business/mail/evidence/read',
  '/crm/business/mail/controls/read',
  '/crm/business/mail/delete',
  '/crm/business/mail/restore',
  '/crm/business/mail/recapture',
  '/crm/business/mail/list',
  '/crm/business/mail/associate',
] as const;
export async function routeBusinessMail(
  request: ApiRequest,
  options: RoutingOptions,
): Promise<RouteResult | null> {
  if (!(BUSINESS_MAIL_PATHS as readonly string[]).includes(request.path))
    return null;
  if (options.auth === undefined)
    return { status: 401, body: redactError('unauthenticated') };
  const verified = await requirePrincipal(options.auth, request);
  if (!verified.ok) return verified.result;
  const scoped = contextForPrincipal(options.auth, verified.principal);
  if (!scoped.ok) return scoped.result;
  if (request.method !== 'POST')
    return { status: 405, body: redactError('method_not_allowed') };
  if (request.path === '/crm/business/mail/recapture')
    return runRouteCommand(
      { auth: options.auth, request, principal: verified.principal },
      mailSourceChangeSchema,
      'crm.mail_recapture_requested',
      (context, body) => requestMailRecapture(context, body),
    );
  if (request.path === '/crm/business/mail/state/read') {
    const parsed = mailSourceStateReadSchema.safeParse(request.body);
    if (!parsed.success)
      return { status: 400, body: redactError('malformed_body') };
    return {
      status: 200,
      body: await withTransaction(options.auth.db, () =>
        readMailSourceState(scoped.context, parsed.data),
      ),
    };
  }
  if (request.path === '/crm/business/mail/associate')
    return runRouteCommand(
      { auth: options.auth, request, principal: verified.principal },
      mailSourceAssociateSchema,
      'crm.mail_source_associated',
      (context, body) => associateMailSource(context, body),
    );
  if (request.path === '/crm/business/mail/list') {
    const parsed = mailSourcesListSchema.safeParse(request.body);
    if (!parsed.success)
      return { status: 400, body: redactError('malformed_body') };
    return {
      status: 200,
      body: await withTransaction(options.auth.db, () =>
        listMailSources(scoped.context, parsed.data),
      ),
    };
  }
  if (
    request.path === '/crm/business/mail/delete' ||
    request.path === '/crm/business/mail/restore'
  )
    return runRouteCommand(
      { auth: options.auth, request, principal: verified.principal },
      mailSourceChangeSchema,
      request.path.endsWith('delete')
        ? 'crm.mail_copy_deleted'
        : 'crm.mail_copy_restored',
      (context, body) =>
        changeMailSource(
          context,
          body,
          request.path.endsWith('delete') ? 'delete' : 'restore',
        ),
    );
  if (request.path === '/crm/business/mail/controls/read') {
    const parsed = mailControlsReadSchema.safeParse(request.body);
    if (!parsed.success)
      return { status: 400, body: redactError('malformed_body') };
    const controls = await withTransaction(options.auth.db, () =>
      readMailCaptureControls(scoped.context, parsed.data.mailboxId),
    );
    return controls === null
      ? { status: 404, body: redactError('not_found') }
      : { status: 200, body: controls };
  }
  const parsed = mailSourceReadSchema.safeParse(request.body);
  if (!parsed.success)
    return { status: 400, body: redactError('malformed_body') };
  return {
    status: 200,
    body: await withTransaction(options.auth.db, () =>
      request.path.endsWith('/evidence/read')
        ? resolveMailSource(scoped.context, parsed.data)
        : request.path.endsWith('/read/v2')?readMailConversationV2(scoped.context,parsed.data):readMailConversation(scoped.context, parsed.data),
    ),
  };
}
