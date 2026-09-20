import type { RepositoryContext } from '../db/workspaceScope.ts';
import { isAdminScope } from '../db/workspaceScope.ts';
import {
  POSTURE_RULES_REVISION,
  POSTURE_STATEMENT_KEYS,
  STATE_POSTURE_RULES,
  isUsStateCode,
  postureReviewAt,
  selectApplicablePosture,
  type PostureDecision,
  type StatePostureRecord,
} from '../src/rules/statePosture.ts';
import { acceptPolicy, refusePolicy, type PolicyResult } from './types.ts';

/**
 * State postures (specification 9.2 step 6, 10.1, invariant 7).
 *
 * "Software records and enforces legal posture; it does not invent it. The founder or
 * counsel decides the posture, records the source material, and sets its review date."
 *
 * Three consequences run through this file.
 *
 * **The reference texts are not stored here.** They live in
 * `packages/domain/src/rules/statePosture.ts`, verbatim, versioned with the release
 * through `POSTURE_RULES_REVISION`. A row records *which* revision the founder
 * confirmed and which statements they ticked, so a later edit to the quoted passages
 * is a new revision and the rows confirmed under the old one are findable. Storing
 * the quotes in the database instead would have made the reference material editable
 * by an application role, which is the one thing invariant 7 is against.
 *
 * **Zero and two rows both fail.** The exclusion constraint in migration 0006 makes
 * two applicable rows impossible to write; `selectApplicablePosture` in the domain
 * makes zero and two both a refusal to read. Appendix G 25 asks for exactly that
 * asymmetry to be visible from the outside: "policy versions with zero, one, and two
 * applicable rows fail, allow, and fail respectively".
 *
 * **Recording is admin-only.** Section 5.2 puts "policy posture" in the admin's list
 * and nowhere else.
 */

export interface StatePostureRow {
  readonly id: string;
  readonly state: string;
  readonly revision: number;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly reviewAt: string;
  readonly rulesRevision: number;
  readonly confirmedStatements: readonly string[];
  readonly sources: readonly { readonly title: string; readonly url: string }[];
  readonly confirmedByUserId: string;
  readonly revokedAt: string | null;
}

interface PostureDbRow {
  readonly id: string;
  readonly state: string;
  readonly revision: number;
  readonly effective_from: Date;
  readonly effective_to: Date | null;
  readonly review_at: Date;
  readonly rules_revision: number;
  readonly confirmed_statements: string[];
  readonly sources: { title: string; url: string }[];
  readonly confirmed_by_user_id: string;
  readonly revoked_at: Date | null;
  readonly [column: string]: unknown;
}

const POSTURE_COLUMNS = `id, state, revision, effective_from, effective_to, review_at, rules_revision,
  confirmed_statements, sources, confirmed_by_user_id, revoked_at`;

function toPosture(row: PostureDbRow): StatePostureRow {
  return {
    id: row.id,
    state: row.state,
    revision: row.revision,
    effectiveFrom: row.effective_from.toISOString(),
    effectiveTo: row.effective_to === null ? null : row.effective_to.toISOString(),
    reviewAt: row.review_at.toISOString(),
    rulesRevision: row.rules_revision,
    confirmedStatements: row.confirmed_statements,
    sources: row.sources,
    confirmedByUserId: row.confirmed_by_user_id,
    revokedAt: row.revoked_at === null ? null : row.revoked_at.toISOString(),
  };
}

/** The applicability record `selectApplicablePosture` reasons over. */
function toRecord(posture: StatePostureRow): StatePostureRecord {
  return {
    state: posture.state,
    revision: posture.revision,
    effectiveFrom: posture.effectiveFrom,
    effectiveTo: posture.effectiveTo,
    reviewAt: posture.reviewAt,
    revokedAt: posture.revokedAt,
  };
}

export async function listStatePostures(
  context: RepositoryContext,
  options: { readonly state?: string } = {},
): Promise<readonly StatePostureRow[]> {
  const { rows } = await context.db.query<PostureDbRow>(
    `SELECT ${POSTURE_COLUMNS} FROM state_postures
      WHERE workspace_id = $1 AND ($2::text IS NULL OR state = $2::text)
      ORDER BY state, revision`,
    [context.scope.workspaceId, options.state ?? null],
  );
  return rows.map(toPosture);
}

export type ApplicablePosture = { readonly posture: StatePostureRow; readonly decision: PostureDecision };

/**
 * The one applicable posture for a state at a database instant, or the refusal.
 *
 * `at` is database time, supplied by the caller. It is a parameter rather than a
 * `now()` inside the statement for the same reason every ported rule takes one: a
 * decision made across several reads has to be made at one instant, and the caller
 * is the only thing that knows which. See
 * `docs/decisions/g4-database-time-is-a-parameter.md`.
 */
export async function applicablePosture(
  context: RepositoryContext,
  state: string,
  at: string,
): Promise<ApplicablePosture | { readonly decision: PostureDecision }> {
  const postures = await listStatePostures(context, { state: state.trim().toUpperCase() });
  const decision = selectApplicablePosture(postures.map(toRecord), state, at);
  if (decision.kind === 'refused') return { decision };
  const chosen = postures.find(
    posture => posture.revision === decision.posture.revision && posture.state === decision.posture.state,
  );
  if (chosen === undefined) return { decision: { kind: 'refused', reason: 'posture_missing' } };
  return { posture: chosen, decision };
}

export interface RecordStatePostureInput {
  readonly state: string;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string | undefined;
  /** Defaults to one calendar year after `effectiveFrom`, from `postureReviewAt`. */
  readonly reviewAt?: string | undefined;
  readonly confirmedStatements: readonly string[];
  readonly note?: string | undefined;
}

const OVERLAP_SQLSTATE = '23P01';

/**
 * Record a posture the founder confirmed.
 *
 * Every statement key has to be one of `POSTURE_STATEMENTS`, and every statement has
 * to be confirmed: a partial confirmation is not a posture, it is a draft, and the
 * one thing this table must not hold is a half-answer that `authorizeDial` would
 * read as an allow. The sources are copied from the domain package rather than taken
 * from the caller, so a row can never cite material the release does not carry.
 */
export async function recordStatePosture(
  context: RepositoryContext,
  input: RecordStatePostureInput,
): Promise<PolicyResult<StatePostureRow>> {
  if (!isAdminScope(context.scope)) return refusePolicy('admin_only');
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return refusePolicy('admin_only');

  const state = input.state.trim().toUpperCase();
  if (!isUsStateCode(state)) return refusePolicy('invalid_input');

  const confirmed = [...new Set(input.confirmedStatements)].sort();
  const expected = [...POSTURE_STATEMENT_KEYS].sort();
  if (confirmed.length !== expected.length || confirmed.some((key, index) => key !== expected[index])) {
    return refusePolicy('invalid_input');
  }

  const effectiveFrom = Date.parse(input.effectiveFrom);
  if (!Number.isFinite(effectiveFrom)) return refusePolicy('invalid_input');
  const reviewAt = input.reviewAt ?? postureReviewAt(input.effectiveFrom);

  const rule = STATE_POSTURE_RULES[state as keyof typeof STATE_POSTURE_RULES] as
    | (typeof STATE_POSTURE_RULES)[keyof typeof STATE_POSTURE_RULES]
    | undefined;
  const sources =
    rule === undefined
      ? []
      : [
          { title: rule.citation.title, url: rule.citation.url },
          ...rule.furtherCitations.map(citation => ({ title: citation.title, url: citation.url })),
        ];

  try {
    const { rows } = await context.db.query<PostureDbRow>(
      `INSERT INTO state_postures
         (workspace_id, state, revision, effective_from, effective_to, review_at, rules_revision,
          confirmed_statements, sources, confirmed_by_user_id, note)
       VALUES ($1, $2,
               (SELECT coalesce(max(revision), 0) + 1 FROM state_postures WHERE workspace_id = $1 AND state = $2),
               $3::timestamptz, $4::timestamptz, $5::timestamptz, $6, $7::text[], $8::jsonb, $9, $10)
       RETURNING ${POSTURE_COLUMNS}`,
      [
        context.scope.workspaceId,
        state,
        input.effectiveFrom,
        input.effectiveTo ?? null,
        reviewAt,
        POSTURE_RULES_REVISION,
        confirmed,
        JSON.stringify(sources),
        actor.userId,
        input.note ?? null,
      ],
    );
    const row = rows[0];
    if (row === undefined) return refusePolicy('invalid_input');
    return acceptPolicy(toPosture(row));
  } catch (error) {
    // 23P01 is `exclusion_violation`: the new range overlaps a posture already in
    // force for this state. Appendix G 25's second half, refused by the database.
    if (typeof error === 'object' && error !== null && (error as { code?: string }).code === OVERLAP_SQLSTATE) {
      return refusePolicy('posture_overlapping');
    }
    if (typeof error === 'object' && error !== null && (error as { code?: string }).code === '23514') {
      return refusePolicy('invalid_input');
    }
    throw error;
  }
}

/** Revoke a posture. A revocation is a column, so the row and its history stay readable. */
export async function revokeStatePosture(
  context: RepositoryContext,
  input: { readonly postureId: string },
): Promise<PolicyResult<StatePostureRow>> {
  if (!isAdminScope(context.scope)) return refusePolicy('admin_only');
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return refusePolicy('admin_only');

  const { rows } = await context.db.query<PostureDbRow>(
    `UPDATE state_postures
        SET revoked_at = now(), revoked_by_user_id = $3
      WHERE workspace_id = $1 AND id = $2 AND revoked_at IS NULL
      RETURNING ${POSTURE_COLUMNS}`,
    [context.scope.workspaceId, input.postureId, actor.userId],
  );
  const row = rows[0];
  if (row === undefined) {
    const existing = await context.db.query(
      'SELECT 1 FROM state_postures WHERE workspace_id = $1 AND id = $2',
      [context.scope.workspaceId, input.postureId],
    );
    return refusePolicy(existing.rows.length === 0 ? 'posture_unknown' : 'posture_already_revoked');
  }
  return acceptPolicy(toPosture(row));
}
