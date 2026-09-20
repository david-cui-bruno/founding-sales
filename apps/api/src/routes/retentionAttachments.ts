import { z } from 'zod';
import { uuid } from '@fss/contracts';
import { readAttachmentReferences } from '@fss/domain/retention';
import { REFUSAL_STATUS, contextForPrincipal, redactError, requirePrincipal } from './crmSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * The open-in-Gmail link (specification 10.3, Appendix F, 5.2).
 *
 * One exact path. It answers with attachment *metadata* — filename, media type,
 * size, hash when Gmail supplied one — and a URL that opens the original message in
 * the mailbox it arrived in. No byte of the file passes through this API, and 10.3
 * says none ever will: "attachments are not copied into FSS".
 *
 * A POST that writes at most one audit event, for the reason G3b's three reads are
 * POSTs: the identifier in the body names a message from a prospect, and a query
 * string is the part of a request that survives in a load-balancer log.
 *
 * The authorization is the domain's. It is the only control on who learns that a
 * file exists and what it is called — Gmail decides separately whether they can open
 * it — so it lives beside the read rather than in this file, and an admin read is
 * audited there in the same transaction.
 */

export const ATTACHMENT_PATHS: readonly string[] = ['/attachments/open'];

const openSchema = z.strictObject({ mailMessageId: uuid });

export async function routeAttachments(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!ATTACHMENT_PATHS.includes(request.path)) return null;
  const auth = options.auth;
  if (auth === undefined) return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }

  // Authentication before validation. An unauthenticated caller learns nothing about
  // the shape this endpoint wants, and 401 is the only honest answer to a request
  // that was never going to be served whatever was in it.
  const authenticated = await requirePrincipal(auth, request);
  if (!authenticated.ok) return authenticated.result;
  const scoped = contextForPrincipal(auth, authenticated.principal);
  if (!scoped.ok) return scoped.result;

  const parsed = openSchema.safeParse(request.body);
  if (!parsed.success) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };

  const outcome = await readAttachmentReferences(scoped.context, { mailMessageId: parsed.data.mailMessageId });
  if (!outcome.ok) {
    // `message_unknown` and `not_authorized` are both 404 on purpose. Telling an
    // unassigned salesperson that the message exists but is not theirs is the same
    // disclosure the authorization exists to prevent (Appendix F, Appendix G 7).
    return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  }
  return { status: 200, body: { attachments: outcome.value } };
}
