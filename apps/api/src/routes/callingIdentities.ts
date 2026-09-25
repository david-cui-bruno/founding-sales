import {
  attestCallingIdentityCommandSchema,
  disableCallingIdentityCommandSchema,
  registerCallingIdentityCommandSchema,
} from '@fss/contracts';
import {
  disableCallingIdentity,
  listOwnCallingIdentities,
  registerCallingIdentity,
  verifyCallingIdentity,
  type CallingIdentityRow,
} from '@fss/domain/dial';
import { REFUSAL_STATUS, contextForPrincipal, policyRouteDeps, redactError, runPolicyCommand } from './dialSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * The exact paths this module owns, for G5b's route registry (lane g60).
 *
 * Exact, like every endpoint since G3b, so a mistyped path is `not_found` rather than
 * somebody else's router answering it.
 */
export const CALLING_IDENTITY_PATHS: readonly string[] = [
  '/calling-identities',
  '/calling-identities/attest',
  '/calling-identities/disable',
  '/calling-identities/register',
];

/**
 * A salesperson's own calling number (specification 9.1; lane g60).
 *
 * 9.2's second step refuses every dial whose calling identity is not "active, verified
 * and owned by the actor", and until this module nothing could make one. Four
 * endpoints, in the dial family and on its shared helper, so every mutation carries
 * the 5.3 envelope and its receipt commits with the row:
 *
 *   * `GET /calling-identities` — the caller's own numbers, and which one Today dials
 *     from. A GET because the request carries nothing but the session
 *     (`docs/decisions/g3b-reads-are-posts.md` applies to requests that would put a
 *     prospect's data in an access log; this one has none).
 *   * `POST /calling-identities/register` — any active member, for themselves; an
 *     admin, for any active member.
 *   * `POST /calling-identities/attest` — the owner's statement that this is the number
 *     they place calls from, or an admin's on their behalf. The body must carry
 *     `attested: true`; the method recorded is decided by who sends it.
 *   * `POST /calling-identities/disable` — retire a number. The row stays.
 *
 * No route decides who may do what: the domain command does, from the scope, in the
 * same transaction as the write. The refusals are `CALLING_IDENTITY_REFUSAL_CODES`,
 * request refusals in the sense of `docs/decisions/g4-dial-refusal-codes.md` — a 409
 * with a code, never a hold. The number itself travels only in request and response
 * bodies, which the access log does not record.
 */
export async function routeCallingIdentities(
  request: ApiRequest,
  options: RoutingOptions,
): Promise<RouteResult | null> {
  if (!CALLING_IDENTITY_PATHS.includes(request.path)) return null;
  const prepared = await policyRouteDeps(request, options);
  if (!prepared.ok) return prepared.result;
  const deps = prepared.deps;

  if (request.path === '/calling-identities') {
    if (request.method !== 'GET') {
      return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
    }
    const scoped = contextForPrincipal(deps.auth, deps.principal);
    if (!scoped.ok) return scoped.result;
    const identities = await listOwnCallingIdentities(scoped.context);
    return { status: 200, body: { identities: identities.map(dtoOf) } };
  }

  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }

  switch (request.path) {
    case '/calling-identities/register':
      return await runPolicyCommand(
        deps,
        registerCallingIdentityCommandSchema,
        'register_calling_identity',
        async (repository, body) => {
          const outcome = await registerCallingIdentity(repository, {
            e164: body.e164,
            ...(body.label === undefined ? {} : { label: body.label }),
            ...(body.ownerUserId === undefined ? {} : { ownerUserId: body.ownerUserId }),
          });
          return outcome.ok
            ? { ok: true, value: { outcome: outcome.value.outcome, identity: dtoOf(outcome.value.identity) } }
            : outcome;
        },
      );
    case '/calling-identities/attest':
      return await runPolicyCommand(
        deps,
        attestCallingIdentityCommandSchema,
        'attest_calling_identity',
        async (repository, body) => {
          const outcome = await verifyCallingIdentity(repository, { identityId: body.identityId });
          return outcome.ok
            ? { ok: true, value: { outcome: outcome.value.outcome, identity: dtoOf(outcome.value.identity) } }
            : outcome;
        },
      );
    case '/calling-identities/disable':
      return await runPolicyCommand(
        deps,
        disableCallingIdentityCommandSchema,
        'disable_calling_identity',
        async (repository, body) => {
          const outcome = await disableCallingIdentity(repository, { identityId: body.identityId });
          return outcome.ok
            ? { ok: true, value: { outcome: outcome.value.outcome, identity: dtoOf(outcome.value.identity) } }
            : outcome;
        },
      );
    default:
      return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  }
}

/**
 * The wire shape, `callingIdentityDtoSchema`. `disabledByUserId` is left out: who
 * retired a number is in the audit trail, and the Mac has nothing to do with it.
 */
function dtoOf(row: CallingIdentityRow): Record<string, unknown> {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    e164: row.e164,
    label: row.label,
    verificationStatus: row.verificationStatus,
    enabled: row.enabled,
    verifiedAt: row.verifiedAt,
    verifiedByUserId: row.verifiedByUserId,
    verificationMethod: row.verificationMethod,
    disabledAt: row.disabledAt,
    usedForCalls: row.usedForCalls,
    createdAt: row.createdAt,
  };
}
