import { mergeContactsCommandSchema, mergeFirmsCommandSchema } from '@fss/contracts';
import { mergeContacts, mergeFirms } from '@fss/domain/crm';
import { REFUSAL_STATUS, contextForPrincipal, crmReply, redactError, requirePrincipal } from './crmSupport.ts';
import { runCommand, type RefusalDetails } from '../auth/index.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * Merge commands (specification 7.2, Appendix A "Merge records", Appendix G 37).
 *
 * These do not use `runCrmCommand`, for one reason: a merge may refuse with
 * *conflicts*, and the conflicts have to reach the person so they can resolve them
 * and post again with `resolutions`. A refusal that carried only a code would leave
 * them guessing which field disagreed.
 *
 * The conflicts are field names and canonical values the caller may already read —
 * a website, a locality, a title — so returning them crosses no line in Appendix F;
 * the merge already required the caller to be entitled to change both records.
 */
export async function routeMerges(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!request.path.startsWith('/merges')) return null;
  const auth = options.auth;
  if (auth === undefined) return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };

  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }

  const authenticated = await requirePrincipal(auth, request);
  if (!authenticated.ok) return authenticated.result;
  const principal = authenticated.principal;
  const scoped = contextForPrincipal(auth, principal);
  if (!scoped.ok) return scoped.result;

  if (request.path === '/merges/firms') {
    const parsed = mergeFirmsCommandSchema.safeParse(request.body);
    if (!parsed.success) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };
    const body = parsed.data;
    const outcome = await runCommand(
      auth,
      principal,
      {
        commandId: body.commandId,
        kind: 'firm.merged',
        payload: { sourceFirmId: body.sourceFirmId, targetFirmId: body.targetFirmId, resolutions: body.resolutions ?? null },
        clientVersion: body.clientVersion,
      },
      async context => {
        const result = await mergeFirms(context, {
          sourceFirmId: body.sourceFirmId,
          targetFirmId: body.targetFirmId,
          resolutions: body.resolutions,
          commandId: body.commandId,
        });
        if (result.ok) return { status: 'accepted', result: result.value };
        return result.conflicts === undefined
          ? { status: 'refused', reason: result.reason }
          : { status: 'refused', reason: result.reason, details: { conflicts: result.conflicts } };
      },
    );
    return withConflicts(crmReply(outcome), outcome);
  }

  if (request.path === '/merges/contacts') {
    const parsed = mergeContactsCommandSchema.safeParse(request.body);
    if (!parsed.success) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };
    const body = parsed.data;
    const outcome = await runCommand(
      auth,
      principal,
      {
        commandId: body.commandId,
        kind: 'contact.merged',
        payload: {
          sourceContactId: body.sourceContactId,
          targetContactId: body.targetContactId,
          resolutions: body.resolutions ?? null,
        },
        clientVersion: body.clientVersion,
      },
      async context => {
        const result = await mergeContacts(context, {
          sourceContactId: body.sourceContactId,
          targetContactId: body.targetContactId,
          resolutions: body.resolutions,
          commandId: body.commandId,
        });
        if (result.ok) return { status: 'accepted', result: result.value };
        return result.conflicts === undefined
          ? { status: 'refused', reason: result.reason }
          : { status: 'refused', reason: result.reason, details: { conflicts: result.conflicts } };
      },
    );
    return withConflicts(crmReply(outcome), outcome);
  }

  return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
}

/**
 * Attach the conflicts to a refusal body — a fresh one and, since lane g78, a replayed
 * one too (audit item D05).
 *
 * Until g78 a replay answered from the receipt, which kept the reason and not the
 * conflicts, so a Mac that retried the same command id got `merge_conflicts` with
 * nothing to resolve. The receipt now keeps the conflicts beside the reason
 * (`RefusalDetails` in `../auth/commands.ts`), so the replay answers exactly what the
 * first refusal did, without recomputing a merge the middleware already decided.
 */
function withConflicts(reply: RouteResult, outcome: { readonly status: string; readonly details?: RefusalDetails }): RouteResult {
  const conflicts = outcome.status === 'refused' ? outcome.details?.['conflicts'] : undefined;
  if (conflicts === undefined) return reply;
  const body = reply.body as { readonly status?: string };
  if (body.status !== 'refused') return reply;
  return { ...reply, body: { ...body, conflicts } };
}
