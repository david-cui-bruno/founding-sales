import { listMatches, listMessagesForOpportunity, readMessageBody, resolveAmbiguity } from '@fss/domain/mail';
import { decideFirmRead, readFirm } from '@fss/domain/crm';
import { readOpportunity } from '@fss/domain/crm';
import { REFUSAL_STATUS, redactError } from '../limits.ts';
import { listMessagesRequestSchema, mailRouteDeps, resolveAmbiguityCommandSchema } from './mailSupport.ts';
import { contextForPrincipal, runRouteCommand } from './routeSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * The minimal message view and the ambiguity resolution (14.1, Appendix F).
 *
 * The brief's boundary for G7-1 is "not the desktop reply cards beyond a minimal
 * message view", so this is two endpoints: the correspondence on one opportunity, and
 * the command that resolves an ambiguous match on to one of its candidates.
 *
 * Both are `POST`, including the read, for the reason in
 * `docs/decisions/g3b-reads-are-posts.md`: a read that takes a body is a read whose
 * parameters are not in a URL, a log line or a browser history.
 *
 * **Bodies are redacted by visibility class.** Appendix F puts "message bodies" in
 * the assigned-salesperson-or-admin row, so a member who is neither gets the
 * envelope — who wrote, when, about what — and not a word of the message. That is
 * decided by `decideFirmRead` from the firm, not from a flag on the request.
 */

export const MESSAGE_PATHS: readonly string[] = ['/messages', '/messages/resolve-ambiguity'];

export async function routeMessages(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!MESSAGE_PATHS.includes(request.path)) return null;
  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }

  const prepared = await mailRouteDeps(request, options);
  if (!prepared.ok) return prepared.result;
  const deps = prepared.deps;

  if (request.path === '/messages/resolve-ambiguity') {
    return await runRouteCommand(
      deps,
      resolveAmbiguityCommandSchema,
      'resolve_message_ambiguity',
      async (context, body) =>
        await resolveAmbiguity(context, {
          messageId: body.messageId,
          selectedOpportunityId: body.selectedOpportunityId,
          human: body.human,
        }),
    );
  }

  const parsed = listMessagesRequestSchema.safeParse(request.body);
  if (!parsed.success) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };
  const scoped = contextForPrincipal(deps.auth, deps.principal);
  if (!scoped.ok) return scoped.result;
  const context = scoped.context;

  const opportunity = await readOpportunity(context, parsed.data.opportunityId);
  if (opportunity === null) return { status: 404, body: redactError('not_found') };
  const firm = await readFirm(context, opportunity.firm_id);
  if (firm === null) return { status: 404, body: redactError('not_found') };
  const visibility = decideFirmRead(context, firm);

  const messages = await listMessagesForOpportunity(context, {
    opportunityId: parsed.data.opportunityId,
    ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }),
  });

  const dtos = [];
  for (const message of messages) {
    const body =
      visibility === 'assigned_or_admin' && !message.metadataOnly ? await readMessageBody(context, message.id) : null;
    dtos.push({
      id: message.id,
      direction: message.direction,
      internalDate: message.internalDate,
      from: message.headerFrom,
      to: message.headerTo,
      subject: visibility === 'assigned_or_admin' ? message.subject : null,
      matches: (await listMatches(context, message.id)).map(match => ({
        opportunityId: match.opportunityId,
        rule: match.rule,
        ambiguous: match.ambiguous,
        selected: match.selected,
      })),
      body: body === null ? null : { text: body.text, truncated: body.truncated },
    });
  }

  return { status: 200, body: { visibility, messages: dtos } };
}
