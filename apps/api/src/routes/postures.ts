import {
  allowCallingStatesCommandSchema,
  recordStatePostureCommandSchema,
  revokeStatePostureCommandSchema,
  setCallingWindowCommandSchema,
} from '@fss/contracts';
import {
  FEDERAL_CITATIONS,
  POSTURE_RULES_REVISION,
  POSTURE_STATEMENTS,
  STATE_POSTURE_RULES,
  US_STATE_CODES,
  US_STATE_NAMES,
  type PostureCitation,
} from '@fss/domain';
import {
  allowCallingStates,
  currentCallingWindow,
  listStatePostures,
  recordStatePosture,
  revokeStatePosture,
  setCallingWindow,
} from '@fss/domain/policy';
import type { RepositoryContext } from '@fss/domain/db';
import { REFUSAL_STATUS, contextForPrincipal, policyRouteDeps, redactError, runPolicyCommand } from './dialSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * The exact paths this module owns, for G5b's route registry.
 *
 * Exact rather than a `/postures` prefix: the registry refuses two claims on one
 * path, and that guarantee is only as sharp as the claim. The `startsWith` guard
 * in the router below is redundant for a mounted request and kept because the
 * router is also called directly, by tests and by `route`.
 */
export const POSTURE_PATHS: readonly string[] = [
  '/postures',
  '/postures/allow',
  '/postures/calling-window',
  '/postures/record',
  '/postures/reference',
  '/postures/revoke',
];

const RECORD_SAVEPOINT = 'posture_record';

/**
 * Run `recordStatePosture` in a savepoint (lane g84).
 *
 * `posture_overlapping` is the database's answer: the exclusion constraint in migration
 * 0006 refuses the insert, and `recordStatePosture` turns SQLSTATE 23P01 into the
 * refusal. Inside `runCommand` that error had already aborted the command's transaction,
 * so the receipt insert after it failed and the API answered 500 where the domain meant
 * `posture_overlapping`. Rolling back to a savepoint taken before the insert is what lets
 * the refusal be recorded and answered. The postures form is the first client that can
 * send a second posture for a state, which is why nobody met it before.
 */
async function inSavepoint<T extends { readonly ok: boolean }>(context: RepositoryContext, work: () => Promise<T>): Promise<T> {
  await context.db.query(`SAVEPOINT ${RECORD_SAVEPOINT}`);
  const result = await work();
  if (!result.ok) await context.db.query(`ROLLBACK TO SAVEPOINT ${RECORD_SAVEPOINT}`);
  await context.db.query(`RELEASE SAVEPOINT ${RECORD_SAVEPOINT}`);
  return result;
}

function citation(entry: PostureCitation): { readonly title: string; readonly url: string; readonly quote: string } {
  return { title: entry.title, url: entry.url, quote: entry.quote };
}

/**
 * `GET /postures/reference` (lane g84, audit item G04): what the postures form shows
 * beside its checkboxes. Every text is `statePosture.ts`'s, verbatim and in its order —
 * the statements a posture confirms, the federal rules the business-to-business
 * statement rests on, and each state with its quoted rule where the release carries one.
 * The Mac reads them here rather than carrying a copy, for invariant 7's reason: the
 * software records a posture and does not author its sources, so there is one text.
 */
export function postureReference(): Readonly<Record<string, unknown>> {
  const rules = STATE_POSTURE_RULES as Readonly<Partial<Record<string, (typeof STATE_POSTURE_RULES)[keyof typeof STATE_POSTURE_RULES]>>>;
  return {
    rulesRevision: POSTURE_RULES_REVISION,
    statements: Object.entries(POSTURE_STATEMENTS).map(([key, text]) => ({ key, text })),
    federalCitations: FEDERAL_CITATIONS.map(citation),
    states: US_STATE_CODES.map(state => {
      const rule = rules[state];
      return {
        state,
        name: US_STATE_NAMES[state],
        rule:
          rule === undefined
            ? null
            : { summary: rule.summary, citations: [rule.citation, ...rule.furtherCitations].map(citation) },
      };
    }),
  };
}

/**
 * State postures and the configured calling window (specification 9.2, 10.1).
 *
 * Invariant 7: "Software records and enforces legal posture; it does not invent
 * it." The API's whole job here is to record what a person confirmed and to refuse
 * everything else — the reference texts come from `@fss/domain`, not from the
 * request body, so a caller cannot cite material the release does not carry.
 *
 * The calling window shares this module because it is the same kind of thing:
 * versioned configuration an admin maintains, which narrows a floor fixed in code
 * and can never widen it.
 *
 * The reads are open to any authenticated member. A salesperson who sees the
 * refusal `posture_missing` on a card should be able to see which states are listed.
 * A posture has no yearly expiry since wave 2 (S4.2); `/postures/allow` lists several
 * states at once, and `/postures/record` stays for desktops up to 1.0.11.
 */
export async function routePostures(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!request.path.startsWith('/postures')) return null;
  const prepared = await policyRouteDeps(request, options);
  if (!prepared.ok) return prepared.result;
  const deps = prepared.deps;

  if (request.method === 'GET') {
    const scoped = contextForPrincipal(deps.auth, deps.principal);
    if (!scoped.ok) return scoped.result;
    if (request.path === '/postures') {
      const state = request.query.get('state');
      return { status: 200, body: { postures: await listStatePostures(scoped.context, state === null ? {} : { state }) } };
    }
    if (request.path === '/postures/calling-window') {
      return { status: 200, body: { callingWindow: await currentCallingWindow(scoped.context) } };
    }
    if (request.path === '/postures/reference') return { status: 200, body: postureReference() };
    return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  }

  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }

  switch (request.path) {
    // Wave 2 (S4.2, D5): several states onto the "OK to call" list, one confirmation.
    case '/postures/allow':
      return await runPolicyCommand(
        deps,
        allowCallingStatesCommandSchema,
        'allow_calling_states',
        async (repository, body) =>
          await inSavepoint(repository, async () =>
            await allowCallingStates(repository, {
              states: body.states,
              ...(body.note === undefined ? {} : { note: body.note }),
            }),
          ),
      );
    // Deprecated (remove after desktop 1.0.12): one state, statements ticked one by one.
    case '/postures/record':
      return await runPolicyCommand(
        deps,
        recordStatePostureCommandSchema,
        'record_state_posture',
        async (repository, body) =>
          await inSavepoint(repository, async () =>
            await recordStatePosture(repository, {
              state: body.state,
              effectiveFrom: body.effectiveFrom,
              ...(body.effectiveTo === undefined ? {} : { effectiveTo: body.effectiveTo }),
              ...(body.reviewAt === undefined ? {} : { reviewAt: body.reviewAt }),
              confirmedStatements: body.confirmedStatements,
              ...(body.note === undefined ? {} : { note: body.note }),
            }),
          ),
      );
    case '/postures/revoke':
      return await runPolicyCommand(
        deps,
        revokeStatePostureCommandSchema,
        'revoke_state_posture',
        async (repository, body) => await revokeStatePosture(repository, { postureId: body.postureId }),
      );
    case '/postures/calling-window':
      return await runPolicyCommand(deps, setCallingWindowCommandSchema, 'set_calling_window', async (repository, body) =>
        await setCallingWindow(repository, {
          startMinute: body.startMinute,
          endMinute: body.endMinute,
          ...(body.weekdays === undefined ? {} : { weekdays: body.weekdays }),
        }),
      );
    default:
      return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  }
}
