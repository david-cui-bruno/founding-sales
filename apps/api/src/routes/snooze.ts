import { z } from 'zod';
import { commandIdSchema, instant, semanticVersionSchema, uuid } from '@fss/contracts';
import { SNOOZE_REASON_MAX, cancelTodaySnooze, releaseTodayPause, snoozeTodayItem } from '@fss/domain/today';
import { REFUSAL_STATUS, policyRouteDeps, redactError, runPolicyCommand } from './dialSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * Snooze (specification 8.2).
 *
 * "Salespeople may snooze manual tasks with a required reason and explicit return
 * instant. Automated sends are not snoozed ad hoc; delaying them creates a recorded
 * hold."
 *
 * Both halves are one endpoint, and deliberately so. The client cannot be the thing
 * that decides which of the two a task gets: a card that believed a send was manual —
 * because it was drawn before the sequences lane changed its mind, or because a
 * rebuild moved the task — would snooze an automated send and the send would go out
 * on time with nobody expecting it. So the request says "delay this task until then,
 * because of this", the server reads `today_items.automated` and answers with which
 * of the two it did, and the card renders that.
 *
 * `reason` is required by the schema as well as by the domain, so a client that
 * forgot it is told its body is malformed rather than having a blank reason recorded.
 */
export const SNOOZE_PATHS: readonly string[] = ['/today/snooze', '/today/snooze/cancel', '/today/pause/release'];

/**
 * `returnAt` is optional since lane g79: a manual task still needs it (the domain
 * refuses `snooze_return_required` without it), and an automated task's pause is
 * released by a person rather than by a clock, so the Mac no longer asks for one.
 */
const snoozeCommandSchema = z.strictObject({
  commandId: commandIdSchema,
  clientVersion: semanticVersionSchema,
  itemId: uuid,
  reason: z.string().trim().min(1).max(SNOOZE_REASON_MAX),
  returnAt: instant.optional(),
});

/** The Resume control on a paused automated task (lane g79, audit C22). */
const releasePauseCommandSchema = z.strictObject({
  commandId: commandIdSchema,
  clientVersion: semanticVersionSchema,
  holdId: uuid,
});

const cancelSnoozeCommandSchema = z.strictObject({
  commandId: commandIdSchema,
  clientVersion: semanticVersionSchema,
  snoozeId: uuid,
});

export async function routeSnooze(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!SNOOZE_PATHS.includes(request.path)) return null;
  const prepared = await policyRouteDeps(request, options);
  if (!prepared.ok) return prepared.result;
  const deps = prepared.deps;

  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }

  if (request.path === '/today/snooze') {
    return await runPolicyCommand(deps, snoozeCommandSchema, 'snooze_today_item', async (context, body) =>
      await snoozeTodayItem(context, {
        itemId: body.itemId,
        reason: body.reason,
        ...(body.returnAt === undefined ? {} : { returnAt: body.returnAt }),
      }),
    );
  }

  if (request.path === '/today/pause/release') {
    return await runPolicyCommand(deps, releasePauseCommandSchema, 'release_today_pause', async (context, body) =>
      await releaseTodayPause(context, { holdId: body.holdId }),
    );
  }

  if (request.path === '/today/snooze/cancel') {
    return await runPolicyCommand(deps, cancelSnoozeCommandSchema, 'cancel_today_snooze', async (context, body) =>
      await cancelTodaySnooze(context, { snoozeId: body.snoozeId }),
    );
  }

  return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
}
