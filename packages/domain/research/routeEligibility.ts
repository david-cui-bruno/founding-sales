import type { RepositoryContext } from '../db/workspaceScope.ts';
import { decideAdminOnly } from '../crm/authorization.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import {
  ROUTE_SOURCES,
  type RouteEligibility,
  type RouteSource,
  type TechnicalValidation,
} from '../crm/types.ts';
import {
  decideRouteEligibility,
  type RouteEligibilityDecision,
  type RouteEligibilityPolicy,
} from '../crm/routePolicy.ts';
import { accept, numeric, refuse, type ResearchResult, type ResearchRoutePolicyRow } from './types.ts';

/**
 * The versioned provider/source policy that decides `candidate → usable`
 * (specification 7.4, 9.1; deliverable 2).
 *
 * Section 7.4: "Email and phone routes become `usable` only when a versioned
 * provider/source policy satisfies both technical-validation and
 * association-confidence thresholds. Weaker routes remain `candidate`."
 *
 * G3a wrote the *decision* as a pure function over a policy object, with one frozen
 * policy constant, `route-policy.1`. That was the right shape and this lane does not
 * replace it: `decideRouteEligibility` is still the only function that says what a
 * route becomes, and it is still pure. What this file adds is where the policy comes
 * from — a row, published by an admin, with the history the brief asks for.
 *
 * ## Why history is a table and not an audit trail
 *
 * A route carries `eligibility_policy_version`. That column is only worth anything if
 * the policy it names can still be read, including after a later policy raised the
 * threshold: the question an operator asks after tightening a threshold is "which
 * routes were promoted under the old one, and would they still qualify?". So the
 * policy rows are insert-only (migration 0007 revokes UPDATE and DELETE), a new
 * threshold is a new version with its own `effective_from`, and the old version stays
 * exactly as it was when the routes were promoted.
 *
 * ## Failing closed
 *
 * `activeRoutePolicy` returns null when no row has taken effect. A caller that gets
 * null must refuse `policy_missing` rather than fall back to a constant, and there is
 * a second line of defence underneath: migration 0004's `*_usable_is_evidenced` CHECK
 * refuses a `usable` route with no recorded policy version, so a bug here becomes a
 * failed insert rather than an unexplained usable route.
 */

const POLICY_COLUMNS = `id, version, minimum_association_confidence, require_technical_validation,
  trusted_sources, note, effective_from`;

export interface PublishedRoutePolicy extends RouteEligibilityPolicy {
  readonly id: string;
  /** False only for a policy that deliberately promotes unvalidated routes. */
  readonly requireTechnicalValidation: boolean;
  readonly note: string | null;
  readonly effectiveFrom: string;
}

function toPolicy(row: ResearchRoutePolicyRow): PublishedRoutePolicy {
  const sources = row.trusted_sources.filter((value): value is RouteSource =>
    (ROUTE_SOURCES as readonly string[]).includes(value),
  );
  return {
    id: row.id,
    version: row.version,
    minimumAssociationConfidence: numeric(row.minimum_association_confidence) ?? 1,
    requireTechnicalValidation: row.require_technical_validation,
    trustedSources: Object.freeze(sources),
    note: row.note,
    effectiveFrom: row.effective_from.toISOString(),
  };
}

/**
 * The policy in force, or null when none is.
 *
 * "In force" is the newest row whose `effective_from` has arrived, by database time.
 * A policy published with a future `effective_from` is visible in the history and does
 * not govern anything yet, which is how an admin schedules a tightening without
 * changing what today's routes were promised.
 */
export async function activeRoutePolicy(context: RepositoryContext): Promise<PublishedRoutePolicy | null> {
  const { rows } = await context.db.query<ResearchRoutePolicyRow>(
    `SELECT ${POLICY_COLUMNS}
       FROM research_route_policies
      WHERE workspace_id = $1 AND effective_from <= now()
      ORDER BY effective_from DESC, created_at DESC, id DESC
      LIMIT 1`,
    [context.scope.workspaceId],
  );
  const row = rows[0];
  return row === undefined ? null : toPolicy(row);
}

/** Every published version, newest first. The history a person reads. */
export async function routePolicyHistory(
  context: RepositoryContext,
  limit = 50,
): Promise<readonly PublishedRoutePolicy[]> {
  const { rows } = await context.db.query<ResearchRoutePolicyRow>(
    `SELECT ${POLICY_COLUMNS}
       FROM research_route_policies
      WHERE workspace_id = $1
      ORDER BY effective_from DESC, created_at DESC, id DESC
      LIMIT $2`,
    [context.scope.workspaceId, Math.trunc(limit)],
  );
  return rows.map(toPolicy);
}

/** One version by name, so a route's `eligibility_policy_version` can be looked up. */
export async function readRoutePolicyVersion(
  context: RepositoryContext,
  version: string,
): Promise<PublishedRoutePolicy | null> {
  const { rows } = await context.db.query<ResearchRoutePolicyRow>(
    `SELECT ${POLICY_COLUMNS} FROM research_route_policies WHERE workspace_id = $1 AND version = $2`,
    [context.scope.workspaceId, version],
  );
  const row = rows[0];
  return row === undefined ? null : toPolicy(row);
}

export interface PublishRoutePolicyInput {
  readonly version: string;
  readonly minimumAssociationConfidence: number;
  readonly requireTechnicalValidation?: boolean | undefined;
  readonly trustedSources?: readonly RouteSource[] | undefined;
  readonly note?: string | undefined;
  /** Defaults to database `now()`. A future instant schedules the change. */
  readonly effectiveFrom?: Date | undefined;
}

const VERSION_PATTERN = /^[a-z0-9._-]{1,40}$/u;

/**
 * Publish a new threshold version. Admin-only, insert-only, audited.
 *
 * A version name is never reused: the unique constraint refuses it, and the refusal is
 * `policy_version_exists` rather than a crash, because an admin who resubmits a form
 * should be told the name is taken rather than shown an error page.
 */
export async function publishRoutePolicy(
  context: RepositoryContext,
  input: PublishRoutePolicyInput,
): Promise<ResearchResult<PublishedRoutePolicy>> {
  const admin = decideAdminOnly(context);
  if (!admin.permitted) return refuse(admin.reason === 'admin_only' ? 'admin_only' : 'not_assigned');

  const version = input.version.trim();
  if (!VERSION_PATTERN.test(version)) return refuse('invalid_input');
  const minimum = input.minimumAssociationConfidence;
  if (!Number.isFinite(minimum) || minimum < 0 || minimum > 1) return refuse('invalid_input');
  const trusted = input.trustedSources ?? [];
  if (trusted.some(source => !(ROUTE_SOURCES as readonly string[]).includes(source))) return refuse('invalid_input');
  if (input.note !== undefined && input.note.trim().length === 0) return refuse('invalid_input');

  const existing = await readRoutePolicyVersion(context, version);
  if (existing !== null) return refuse('policy_version_exists');

  const { rows } = await context.db.query<ResearchRoutePolicyRow>(
    `INSERT INTO research_route_policies
       (workspace_id, version, minimum_association_confidence, require_technical_validation,
        trusted_sources, note, created_by_user_id, effective_from)
     VALUES ($1, $2, $3, $4, $5::text[], $6, $7, COALESCE($8::timestamptz, now()))
     ON CONFLICT ON CONSTRAINT research_route_policies_version_unique DO NOTHING
     RETURNING ${POLICY_COLUMNS}`,
    [
      context.scope.workspaceId,
      version,
      minimum,
      input.requireTechnicalValidation ?? true,
      [...trusted],
      input.note ?? null,
      context.scope.actor.kind === 'user' ? context.scope.actor.userId : null,
      input.effectiveFrom ?? null,
    ],
  );
  const created = rows[0];
  if (created === undefined) return refuse('policy_version_exists');

  const policy = toPolicy(created);
  await recordCrmAuditEvent(context, {
    action: 'research.route_policy_published',
    subjectKind: 'research_route_policy',
    subjectId: policy.id,
    detail: {
      version: policy.version,
      minimumAssociationConfidence: policy.minimumAssociationConfidence,
      requireTechnicalValidation: policy.requireTechnicalValidation,
      trustedSources: [...policy.trustedSources].sort(),
      effectiveFrom: policy.effectiveFrom,
    },
  });
  return accept(policy);
}

export interface RouteFinding {
  readonly source: RouteSource;
  readonly technicalValidation: TechnicalValidation;
  readonly associationConfidence: number | null;
}

/**
 * What a published policy makes of one finding.
 *
 * G3a's pure `decideRouteEligibility` does the deciding; this adds the one clause the
 * stored policy has and the constant did not — `require_technical_validation = false`,
 * which a policy may set to promote a route whose technical validation is still
 * `unknown`. The default is true and the seeded policy is true, so the shipped
 * behaviour is identical to G3a's; the flag exists because an admin who has a
 * validating provider for phones but not for addresses should be able to say so in a
 * *version*, rather than in code.
 *
 * Even then a promotion needs a recorded confidence at or above the threshold, or a
 * trusted source. There is no path here to a usable route with nothing behind it.
 */
export function decideEligibilityUnderPolicy(
  finding: RouteFinding,
  policy: PublishedRoutePolicy,
): RouteEligibilityDecision {
  if (policy.requireTechnicalValidation) return decideRouteEligibility(finding, policy);

  if (finding.technicalValidation === 'failed') return { eligibility: 'invalid', policyVersion: null };
  const trusted = policy.trustedSources.includes(finding.source);
  const confidence = finding.associationConfidence;
  if (trusted) return { eligibility: 'usable', policyVersion: policy.version };
  if (confidence === null || !Number.isFinite(confidence) || confidence < policy.minimumAssociationConfidence) {
    return { eligibility: 'candidate', policyVersion: null };
  }
  return { eligibility: 'usable', policyVersion: policy.version };
}

/**
 * Whether `next` is at least as strict as `current` on every axis.
 *
 * Not used to refuse a publication — an admin may deliberately relax a threshold and
 * the history records that they did — but the API reports it, so the person pressing
 * the button is told which routes the change would have promoted.
 */
export function isAtLeastAsStrict(next: PublishedRoutePolicy, current: PublishedRoutePolicy): boolean {
  if (next.minimumAssociationConfidence < current.minimumAssociationConfidence) return false;
  if (!next.requireTechnicalValidation && current.requireTechnicalValidation) return false;
  return next.trustedSources.every(source => current.trustedSources.includes(source));
}

export type { RouteEligibility, RouteEligibilityDecision };
