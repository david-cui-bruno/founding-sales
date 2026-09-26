import { pushTokenPolicyOf } from '@fss/domain/mail/config.ts';
import { receivePushNotification } from '@fss/domain/mail/webhook.ts';
import { bearerOf } from '../auth/tokens.ts';
import { REFUSAL_STATUS, redactError } from '../limits.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * The Gmail Pub/Sub webhook (specification 4.1, 12.3, Appendix G 10 and 27).
 *
 * One exact path, and it is `/integrations/gmail/push` because that is what
 * `infra/modules/stack/variables.tf` sets `gmail_push_path` to — and, crucially, the
 * same string is the OIDC *audience* the subscription mints its token for. The path
 * and the audience are one fact; changing one without the other produces a webhook
 * that refuses every notification with `audience_mismatch`, which is the right
 * failure but a confusing one.
 *
 * The endpoint takes no session, and the push token is its authentication. So it is
 * the one route in this API where the refusal codes are a security surface rather
 * than a convenience, and every one of them leaves as the same redacted body: an
 * attacker probing for which of the seven checks failed learns nothing from the
 * response, and the operator learns it from the log line.
 *
 * **A refusal is not an acknowledgement.** Pub/Sub treats a non-2xx as "deliver
 * again", which is exactly right for an unknown or inactive mailbox: the notification
 * is retried and then dropped at the subscription's retention boundary, rather than
 * FSS silently swallowing pushes for a mailbox somebody is about to reconnect. See
 * `docs/decisions/g7-webhook-rejection.md`.
 */

export const PUBSUB_PATHS: readonly string[] = ['/integrations/gmail/push'];

export async function routePubSub(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!PUBSUB_PATHS.includes(request.path)) return null;
  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }

  const mail = options.mail;
  if (mail === undefined) return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };

  const outcome = await receivePushNotification(
    options.session,
    { verifier: mail.pushVerifier, policy: pushTokenPolicyOf(mail.config) },
    { token: bearerOf(request.headers['authorization']), body: request.body },
  );

  if (!outcome.accepted) {
    // `$.event = "refusal"` with the reason is what the operator reads; the caller
    // gets one sentence whichever check failed. A known-but-inactive mailbox is
    // counted here rather than merely refused, so a revoked mailbox that keeps
    // receiving push is visible rather than silent.
    options.log?.log('info', 'refusal', { reason: `gmail_push_${outcome.refusal}`, path: request.path });
    const status = outcome.refusal === 'mailbox_unknown' || outcome.refusal === 'mailbox_inactive' ? 404 : 401;
    return { status, body: { error: 'push_refused', message: 'The notification was refused.' } };
  }

  // Acknowledged only now: the dedupe row and the coalesced job are both committed.
  return {
    status: 200,
    body: { status: 'accepted', firstDelivery: outcome.firstDelivery, coalesced: outcome.coalesced },
  };
}
