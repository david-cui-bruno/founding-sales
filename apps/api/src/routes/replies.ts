import { z } from 'zod';
import {
  CLASSIFIER_EFFORTS,
  CLASSIFIER_MODELS,
  confirmReplyDisposition,
  listReplyCards,
  readClassifierSettings,
  readReplyCard,
  updateClassifierSettings,
} from '@fss/domain/classification';
import { REPLY_DISPOSITIONS } from '@fss/domain';
import { businessDateOf } from '@fss/domain/today';
import { REFUSAL_STATUS, redactError } from '../limits.ts';
import { contextForPrincipal, requirePrincipal, runRouteCommand, type RouteDeps } from './routeSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * The reply cards, the confirmation, and the classifier's configuration
 * (specification 8.3, 10.1, 14.1, Appendix A "Confirm disposition").
 *
 * Five exact paths. Reads are `POST` for the reason in
 * `docs/decisions/g3b-reads-are-posts.md`: a read that takes a body is a read whose
 * parameters are not in a URL, a log line or a browser history — and a reply card's
 * parameter is a message id.
 *
 * **Resolving an ambiguity is not here.** G7-1 already mounts
 * `/messages/resolve-ambiguity`, and it is the same command the reply card's
 * `nextAction` names. A second path doing the same thing would be two ways to
 * resolve one ambiguity, and 12.3 allows one resolution per message.
 * See `docs/decisions/g7b-ambiguity-stays-where-g7-put-it.md`.
 *
 * **The card is a read and the confirmation is a command.** `/replies` and
 * `/replies/card` write nothing; `/replies/confirm` goes through `runCommand`, so the
 * receipt, the payload hash, the device and every consequence commit in one
 * transaction (5.3) and a replayed click returns the original result rather than
 * confirming twice.
 */

export const REPLY_PATHS: readonly string[] = [
  '/replies',
  '/replies/card',
  '/replies/confirm',
  '/replies/settings',
  '/replies/settings/update',
];

const commandEnvelope = {
  commandId: z.string().uuid(),
  clientVersion: z.string().min(1).max(32),
};

const listRepliesRequestSchema = z
  .object({
    /** The workspace business date. Today's, when the client does not say. */
    businessDate: z.iso.date().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

const replyCardRequestSchema = z.object({ messageId: z.string().uuid() }).strict();

/**
 * The confirmation.
 *
 * `callback` is the instant a person supplied, with the local wall clock and the
 * zone it came from (Appendix D). It is not the model's proposal and the server will
 * not read that proposal on the client's behalf: 12.4 forbids the model committing a
 * callback instant, and a client that omitted the field on a card that carried a
 * proposal is refused with `callback_required` rather than having one chosen for it.
 *
 * `firmWideOptOut` is the question 9.1's do-not-call row asks, answered by the
 * person. Nothing infers it from the wording.
 */
const confirmReplyCommandSchema = z
  .object({
    ...commandEnvelope,
    messageId: z.string().uuid(),
    disposition: z.enum(REPLY_DISPOSITIONS),
    callback: z
      .object({
        localDate: z.iso.date(),
        localTime: z.string().regex(/^\d{2}:\d{2}$/u).optional(),
        sourceTimeZone: z.string().min(1).max(64),
        dueAt: z.iso.datetime(),
      })
      .strict()
      .optional(),
    firmWideOptOut: z.boolean().optional(),
    note: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

const updateSettingsCommandSchema = z
  .object({
    ...commandEnvelope,
    enabled: z.boolean().optional(),
    modelName: z.enum(CLASSIFIER_MODELS).optional(),
    effort: z.enum(CLASSIFIER_EFFORTS).optional(),
    maxOutputTokens: z.number().int().min(64).max(4096).optional(),
    dailyCallCap: z.number().int().min(0).max(100_000).optional(),
  })
  .strict();

export async function routeReplies(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!REPLY_PATHS.includes(request.path)) return null;
  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }

  const auth = options.auth;
  if (auth === undefined) return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  const authenticated = await requirePrincipal(auth, request);
  if (!authenticated.ok) return authenticated.result;
  const scoped = contextForPrincipal(auth, authenticated.principal);
  if (!scoped.ok) return scoped.result;
  const context = scoped.context;
  const deps: RouteDeps = { auth, request, principal: authenticated.principal };

  if (request.path === '/replies/confirm') {
    return await runRouteCommand(deps, confirmReplyCommandSchema, 'confirm_reply_disposition', async (scope, body) =>
      await confirmReplyDisposition(scope, {
        messageId: body.messageId,
        disposition: body.disposition,
        ...(body.callback === undefined ? {} : { callback: body.callback }),
        ...(body.firmWideOptOut === undefined ? {} : { firmWideOptOut: body.firmWideOptOut }),
        ...(body.note === undefined ? {} : { note: body.note }),
        // 10.2: the object-locked journal is written before the suppression row, and
        // the route never chooses whether there is one — `routingOptions` supplies
        // the local no-op when the deployment has no bucket.
        journal: options.suppressionJournal,
      }),
    );
  }

  if (request.path === '/replies/settings/update') {
    return await runRouteCommand(deps, updateSettingsCommandSchema, 'configure_classifier', async (scope, body) =>
      await updateClassifierSettings(scope, {
        ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
        ...(body.modelName === undefined ? {} : { modelName: body.modelName }),
        ...(body.effort === undefined ? {} : { effort: body.effort }),
        ...(body.maxOutputTokens === undefined ? {} : { maxOutputTokens: body.maxOutputTokens }),
        ...(body.dailyCallCap === undefined ? {} : { dailyCallCap: body.dailyCallCap }),
      }),
    );
  }

  if (request.path === '/replies/settings') {
    // A read, and not admin-only: the card names the model that produced its
    // suggestion, and a salesperson looking at a card is entitled to know which.
    return { status: 200, body: await readClassifierSettings(context) };
  }

  if (request.path === '/replies/card') {
    const parsed = replyCardRequestSchema.safeParse(request.body);
    if (!parsed.success) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };
    const card = await readReplyCard(context, { messageId: parsed.data.messageId });
    if (card === null) return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
    return { status: 200, body: card };
  }

  const parsed = listRepliesRequestSchema.safeParse(request.body ?? {});
  if (!parsed.success) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };
  const businessDate = parsed.data.businessDate ?? (await businessDateOf(context, new Date().toISOString()));
  const cards = await listReplyCards(context, {
    businessDate,
    ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }),
  });
  return { status: 200, body: { businessDate, cards } };
}
