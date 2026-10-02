import {
  correctSuppressionCommandSchema,
  recordSuppressionCommandSchema,
  supersedeSuppressionCommandSchema,
} from '@fss/contracts';
import { listEffectiveSuppressions } from '@fss/domain/suppression/effective.ts';
import { recordAdminSupersession, recordCorrection, recordSuppression } from '@fss/domain/suppression/events.ts';
import type { SuppressionJournal, SuppressionJournalRecord } from '@fss/domain/suppression/journal.ts';
import type { Logger } from '../bootstrap/log.ts';
import { REFUSAL_STATUS, redactError } from '../limits.ts';
import { policyRouteDeps, runPolicyCommand } from './dialSupport.ts';
import { contextForPrincipal } from './routeSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * The exact paths this module owns, for G5b's route registry.
 *
 * Exact rather than a `/suppressions` prefix: the registry refuses two claims on one
 * path, and that guarantee is only as sharp as the claim. The `startsWith` guard
 * in the router below is redundant for a mounted request and kept because the
 * router is also called directly, by tests and by `route`.
 */
export const SUPPRESSION_PATHS: readonly string[] = [
  '/suppressions',
  '/suppressions/record',
  '/suppressions/correct',
  '/suppressions/supersede',
];

/**
 * The suppression surface (specification 10.2, 14.1, Appendix A).
 *
 * The one durable way to record a manual stop request that did not arrive by Gmail, a
 * confirmed reply or a logged call, and to correct or supersede one. Wave 2 (S6)
 * deleted it for having no caller; the batch review restored it before release. The
 * Mac gets controls for it later.
 *
 * Three writes and one read. The writes are `record`, `correct` and `supersede`,
 * which are the only three things 10.2 permits: there is no delete, no update and
 * no "undo", because `suppression_events` has UPDATE and DELETE revoked from the
 * application role and an endpoint that pretended otherwise would be a lie with a
 * 500 behind it.
 *
 * Every write carries the journal through `runPolicyCommand`, and the journal write
 * happens inside the command transaction and before the row. A lost journal write
 * leaves the command id free and answers 503, rather than recording a refusal the
 * client would replay forever.
 *
 * The read returns the effective set for the workspace and is not narrowed to the
 * caller's assigned firms: a handle suppression is workspace-wide (10.2), and a
 * salesperson who could not see one would re-add the number they were told to stop
 * calling.
 */
export async function routeSuppressions(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!request.path.startsWith('/suppressions')) return null;
  const prepared = await policyRouteDeps(request, options);
  if (!prepared.ok) return prepared.result;
  const deps = prepared.deps;

  if (request.method === 'GET' && request.path === '/suppressions') {
    const scoped = contextForPrincipal(deps.auth, deps.principal);
    if (!scoped.ok) return scoped.result;
    return { status: 200, body: { suppressions: await listEffectiveSuppressions(scoped.context, { limit: 200 }) } };
  }

  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }

  switch (request.path) {
    case '/suppressions/record':
      return await runPolicyCommand(
        deps,
        recordSuppressionCommandSchema,
        'record_suppression',
        async (repository, body) =>
          await recordSuppression(repository, {
            scope: body.scope,
            ...(body.firmId === undefined ? {} : { firmId: body.firmId }),
            ...(body.value === undefined ? {} : { value: body.value }),
            source: body.source,
            // Absent is `all` (migration 0037): the installed desktop's "Stop all contact
            // with this firm" sends no channel and means exactly that.
            channel: body.channel ?? 'all',
            commandId: body.commandId,
            journal: deps.journal,
          }),
      );
    case '/suppressions/correct': {
      // The lift this command made, journalled only once the command has committed (brief RF).
      let lifts: readonly SuppressionJournalRecord[] = [];
      const reply = await runPolicyCommand(deps, correctSuppressionCommandSchema, 'correct_suppression', async (repository, body) => {
        lifts = [];
        const corrected = await recordCorrection(repository, { eventId: body.eventId, commandId: body.commandId });
        if (!corrected.ok) return corrected;
        const { journalRecords, ...value } = corrected.value;
        lifts = journalRecords;
        return { ok: true, value };
      });
      await journalCommittedLifts(deps.journal, lifts, reply, options.log);
      return reply;
    }
    case '/suppressions/supersede': {
      let lifts: readonly SuppressionJournalRecord[] = [];
      const reply = await runPolicyCommand(deps, supersedeSuppressionCommandSchema, 'supersede_suppression', async (repository, body) => {
        lifts = [];
        const superseded = await recordAdminSupersession(repository, {
          eventId: body.eventId,
          reason: body.reason,
          commandId: body.commandId,
        });
        if (!superseded.ok) return superseded;
        const { journalRecords, ...value } = superseded.value;
        lifts = journalRecords;
        return { ok: true, value };
      });
      await journalCommittedLifts(deps.journal, lifts, reply, options.log);
      return reply;
    }
    default:
      return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  }
}

/** How often, and after how long, a committed lift's journal write is tried again. */
export const LIFT_JOURNAL_RETRY_DELAYS_MS: readonly number[] = [100, 500];

/**
 * Journal the releases a command wrote, after it committed, marked (brief RF, RF reset J2).
 *
 * A stop is journalled before its transaction commits, because a stop the journal holds and
 * the database lost is the safe direction (J1). A release is the opposite direction: one the
 * journal holds and the database never committed would be applied by a restore replay and
 * remove a stop. So every release — an admin lift, a correction, and each merge copy one of
 * them lifted — is appended here, after `runCommand` returned a fresh acceptance (a replay of
 * a receipt ran no work, and a command that failed to commit never gets here), carrying
 * `committed: true`, which is what a replay requires before it applies a release (J3). Each
 * is tried again after the delays; one that still fails stays committed and is logged by id,
 * and a later restore brings its stop back, which errs toward the stop. Each failed put also
 * logs `suppression_journal_write_failed`, the critical alarm's event.
 */
export async function journalCommittedLifts(
  journal: SuppressionJournal,
  lifts: readonly SuppressionJournalRecord[],
  reply: RouteResult,
  log: Logger | undefined,
  delays: readonly number[] = LIFT_JOURNAL_RETRY_DELAYS_MS,
): Promise<void> {
  if (lifts.length === 0 || reply.status !== 200) return;
  const body = reply.body as { readonly replayed?: unknown };
  if (body.replayed !== false) return;
  for (const lift of lifts) {
    const marked: SuppressionJournalRecord = { ...lift, committed: true };
    let journalled = false;
    for (let attempt = 0; attempt <= delays.length && !journalled; attempt += 1) {
      try {
        await journal.append(marked);
        journalled = true;
      } catch {
        const wait = delays[attempt];
        if (wait === undefined) break;
        await new Promise(resolve => setTimeout(resolve, wait));
      }
    }
    if (!journalled) {
      log?.log('error', 'suppression_lift_unjournalled', {
        workspace_id: lift.workspaceId,
        event_id: lift.eventId,
        supersedes_event_id: lift.supersedesEventId ?? '',
      });
    }
  }
}
