import { authorizeDialCommandSchema, consumeDialTicketCommandSchema, dialCheckRequestSchema } from '@fss/contracts';
import {
  adviseDial,
  authorizeDialCommand,
  consumeDialTicket,
  type DialResult,
  type IssuedDialTicket,
} from '@fss/domain/dial';
import { runCommand } from '../auth/index.ts';
import {
  REFUSAL_STATUS,
  contextForPrincipal,
  policyRouteDeps,
  redactError,
  runPolicyCommand,
  type PolicyRouteDeps,
} from './dialSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * The exact paths this module owns, for G5b's route registry.
 *
 * Exact rather than a `/dial` prefix: the registry refuses two claims on one
 * path, and that guarantee is only as sharp as the claim. The `startsWith` guard
 * in the router below is redundant for a mounted request and kept because the
 * router is also called directly, by tests and by `route`.
 */
export const DIAL_PATHS: readonly string[] = [
  '/dial/authorize',
  '/dial/check',
  '/dial/consume',
];

/**
 * Dial advice, and the ticket pair desktops up to 1.0.11 still use (specification 9.2,
 * 5.3; wave 2, S4.5).
 *
 * `POST /dial/check` is the advisory read: callable yes or no, with every reason, for a
 * firm and optionally the number the card would dial (`adviseDial`). It writes nothing;
 * the Mac opens `tel:` itself and logs the call afterwards with `POST /calls/log`. It
 * answers only about firms the caller may see — a colleague's is `not_found` — so it
 * cannot be used to learn which firms are suppressed.
 *
 * `/dial/authorize` and `/dial/consume` are deprecated (remove after desktop 1.0.12) and
 * unchanged for the installed desktop, which asks for a ticket before it opens `tel:`.
 *
 * The replay rule of 5.3 is enforced in three places, and all three have to agree:
 *
 *  1. `command_receipts_dial_result_not_actionable` in migration 0001 refuses a
 *     receipt of this kind that carries a result, so a replayed receipt is empty.
 *  2. The reply below turns that empty replay into `already_consumed` rather than
 *     into an accepted command with a null body, which is what a client would
 *     otherwise have to interpret.
 *  3. `dial_tickets_one_per_command` refuses a second ticket for the same command
 *     even if neither of the first two was reached.
 */
export async function routeDial(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!request.path.startsWith('/dial')) return null;
  const prepared = await policyRouteDeps(request, options);
  if (!prepared.ok) return prepared.result;
  const deps = prepared.deps;

  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }

  switch (request.path) {
    case '/dial/check': {
      const parsed = dialCheckRequestSchema.safeParse(request.body);
      if (!parsed.success) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };
      const scoped = contextForPrincipal(deps.auth, deps.principal);
      if (!scoped.ok) return scoped.result;
      const advice = await adviseDial(scoped.context, {
        firmId: parsed.data.firmId,
        ...(parsed.data.routeId === undefined ? {} : { routeId: parsed.data.routeId }),
      });
      if (advice === null) return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
      return { status: 200, body: { advice } };
    }
    case '/dial/authorize':
      return await authorize(deps, request);
    case '/dial/consume':
      return await runPolicyCommand(
        deps,
        consumeDialTicketCommandSchema,
        'consume_dial_ticket',
        async (repository, body) =>
          await consumeDialTicket(repository, { ticketId: body.ticketId, deviceId: deps.principal.deviceId }),
      );
    default:
      return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  }
}

/**
 * The dial authorization command.
 *
 * It does not go through `runPolicyCommand`, and the reason is a constraint rather
 * than a preference. `command_receipts_dial_result_not_actionable` in migration 0001
 * refuses *any* receipt of kind `authorize_dial` that carries a result — a refusal
 * reason included — and the shared helper records a refused command's reason in its
 * receipt. So this command is always "accepted" as far as the receipt is concerned,
 * the decision travels back through the command's return value, and the reply is
 * built here.
 *
 * That is also what makes the replay correct. `runCommand` stores `null` for this
 * kind, so a replayed receipt has nothing in it, and "nothing" is turned into
 * `already_consumed` — the answer 9.2 names — rather than into an accepted command
 * with an empty body that a client would have to interpret.
 */
async function authorize(deps: PolicyRouteDeps, request: ApiRequest): Promise<RouteResult> {
  const parsed = authorizeDialCommandSchema.safeParse(request.body);
  if (!parsed.success) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };
  const body = parsed.data;
  const { commandId, clientVersion, ...payload } = body;

  const outcome = await runCommand<DialResult<IssuedDialTicket>>(
    deps.auth,
    deps.principal,
    { commandId, kind: 'authorize_dial', payload, clientVersion },
    async context => ({
      status: 'accepted',
      result: await authorizeDialCommand(context, {
        firmId: body.firmId,
        ...(body.contactId === undefined ? {} : { contactId: body.contactId }),
        routeId: body.routeId,
        routeVersion: body.routeVersion,
        callingIdentityId: body.callingIdentityId,
        deviceId: deps.principal.deviceId,
        commandId,
      }),
    }),
  );

  if (outcome.status === 'refused') {
    return {
      status: outcome.reason === 'client_upgrade_required' ? 426 : 409,
      body: { status: 'refused', replayed: outcome.replayed, reason: outcome.reason },
    };
  }
  // A replay: the receipt kept that the command happened and none of what it
  // produced, which is the whole point of the constraint.
  if (outcome.replayed || outcome.result === null) {
    return { status: 409, body: { status: 'refused', replayed: true, reason: 'already_consumed' } };
  }
  if (!outcome.result.ok) {
    return { status: 409, body: { status: 'refused', replayed: false, reason: outcome.result.reason } };
  }
  return { status: 200, body: { status: 'accepted', replayed: false, result: outcome.result.value } };
}
