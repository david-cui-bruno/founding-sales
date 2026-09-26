import type { RepositoryContext } from '../db/workspaceScope.ts';
import { jobIdempotencyKey } from '../jobs/jobKinds.ts';
import { enqueueJob, type JobSpecification } from '../jobs/jobStore.ts';
import { decideFirmMutation } from './authorization.ts';
import { recordCrmAuditEvent } from './audit.ts';
import { emitCrmDomainEvent } from './events.ts';
import { loadFirmForUpdate } from './firms.ts';
import { decidePhoneOnEntry, decideRouteEligibility } from './routePolicy.ts';
import {
  accept,
  refuse,
  type CrmRefusalCode,
  type CrmResult,
  type RouteEligibility,
  type RouteKind,
  type RouteRow,
  type RouteSource,
  type TechnicalValidation,
} from './types.ts';

/**
 * Phone routes and email addresses (specification 7.2, 7.4, 9.1).
 *
 * The two tables are the same shape and the same rules, so they are the same code
 * with a table name and a value column. What differs — an E.164 number against a
 * lower-cased address — is enforced by each table's own CHECK.
 *
 * The version is the piece that matters most. Section 9.1: "Authorization uses the
 * route version displayed on the card, preventing a stale client from dialing a
 * replaced or retired number." So every change to a route's eligibility bumps its
 * version, the database refuses an eligibility change that forgot to, and a card
 * holding version 1 of a route now at version 2 is refused by `authorizeDial` (G4).
 */

interface RouteTable {
  readonly table: 'phone_routes' | 'email_addresses';
  readonly valueColumn: 'e164' | 'address';
  readonly associationConstraint: string;
}

const TABLES: Readonly<Record<RouteKind, RouteTable>> = Object.freeze({
  phone: Object.freeze({
    table: 'phone_routes',
    valueColumn: 'e164',
    associationConstraint: 'phone_routes_one_per_association',
  }),
  email: Object.freeze({
    table: 'email_addresses',
    valueColumn: 'address',
    associationConstraint: 'email_addresses_one_per_association',
  }),
});

const ROUTE_COLUMNS = `id, workspace_id, firm_id, contact_id, source, retrieved_at, association_confidence,
  technical_validation, eligibility, eligibility_policy_version, version, retired_at, retired_reason`;

export interface AddRouteInput {
  readonly firmId: string;
  /** Null or omitted for a firm-level route: a switchboard, a general mailbox. */
  readonly contactId?: string | undefined;
  readonly source: RouteSource;
  readonly retrievedAt?: Date | undefined;
  readonly associationConfidence?: number | undefined;
  readonly technicalValidation?: TechnicalValidation | undefined;
}

export interface PhoneRouteInput extends AddRouteInput {
  readonly e164: string;
}

export interface EmailRouteInput extends AddRouteInput {
  readonly address: string;
}

export async function addPhoneRoute(
  context: RepositoryContext,
  input: PhoneRouteInput,
): Promise<CrmResult<RouteRow>> {
  return await addRoute(context, 'phone', input.e164, input);
}

export async function addEmailRoute(
  context: RepositoryContext,
  input: EmailRouteInput,
): Promise<CrmResult<RouteRow>> {
  // Canonical means lower-cased, the same spelling the suppression canonicalizer
  // produces, so a handle suppression and a route compare without a second rule.
  return await addRoute(context, 'email', input.address.trim().toLowerCase(), input);
}

interface RouteEvidence {
  readonly eligibility: RouteEligibility;
  readonly policyVersion: string | null;
  readonly technicalValidation: TechnicalValidation;
  readonly associationConfidence: number | null;
}

/**
 * What a route is written with: its evidence and the eligibility that evidence makes it.
 *
 * A phone number is usable on entry (wave 2, S4.4; `decidePhoneOnEntry`), with the
 * evidence defaults schema 18's CHECK requires. An email address is the versioned
 * policy's decision (7.4, `decideRouteEligibility`): a caller may say what it retrieved
 * and how confident it is, never what that makes the route.
 */
function evidenceFor(
  kind: RouteKind,
  source: RouteSource,
  technicalValidation: TechnicalValidation,
  associationConfidence: number | null,
): RouteEvidence {
  if (kind === 'phone') return decidePhoneOnEntry({ technicalValidation, associationConfidence });
  return {
    ...decideRouteEligibility({ source, technicalValidation, associationConfidence }),
    technicalValidation,
    associationConfidence,
  };
}

/**
 * Record a route, with the evidence and eligibility `evidenceFor` decides.
 */
async function addRoute(
  context: RepositoryContext,
  kind: RouteKind,
  value: string,
  input: AddRouteInput,
): Promise<CrmResult<RouteRow>> {
  const firm = await loadFirmForUpdate(context, input.firmId);
  if (firm === null) return refuse('firm_unknown');
  const decision = decideFirmMutation(context, firm);
  if (!decision.permitted) return refuse(decision.reason);

  const table = TABLES[kind];
  const evidence = evidenceFor(
    kind,
    input.source,
    input.technicalValidation ?? 'unknown',
    input.associationConfidence ?? null,
  );

  const { rows } = await context.db.query<RouteRow>(
    `INSERT INTO ${table.table}
       (workspace_id, firm_id, contact_id, ${table.valueColumn}, source, retrieved_at,
        association_confidence, technical_validation, eligibility, eligibility_policy_version)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()), $7, $8, $9, $10)
     ON CONFLICT ON CONSTRAINT ${table.associationConstraint} DO NOTHING
     RETURNING ${ROUTE_COLUMNS}`,
    [
      context.scope.workspaceId,
      input.firmId,
      input.contactId ?? null,
      value,
      input.source,
      input.retrievedAt ?? null,
      evidence.associationConfidence,
      evidence.technicalValidation,
      evidence.eligibility,
      evidence.policyVersion,
    ],
  );
  const created = rows[0];
  if (created === undefined) {
    // The association already exists. Section 7.2 keeps a shared handle as explicit
    // rows per association, so this is the *same* association, and the existing row
    // is the answer rather than a second one.
    const existing = await readRouteByValue(context, kind, input.firmId, input.contactId ?? null, value);
    return existing === null ? refuse('invalid_input') : accept(existing);
  }

  await recordCrmAuditEvent(context, {
    action: `route.${kind}.added`,
    subjectKind: 'route',
    subjectId: created.id,
    detail: { firmId: input.firmId, eligibility: created.eligibility, source: input.source },
  });
  // Lane g90: an address nobody has checked is checked by the worker, in this
  // transaction's commit or not at all — an import row refused after this point takes
  // its job back with it. A caller that brought its own verdict (`passed`, `failed`)
  // is not second-guessed here.
  if (kind === 'email' && created.eligibility === 'candidate' && created.technical_validation === 'unknown') {
    await enqueueJob(
      context.db,
      emailValidationJob(context.scope.workspaceId, created.id, Number(created.version), EMAIL_VALIDATION_ROUND_NEW),
    );
  }
  return accept(created);
}

// ---------------------------------------------------------------------------
// Lane g90: email technical validation — the job, and the one write it makes.
// The rules are `routeValidation.ts`; `docs/decisions/g90-email-technical-validation.md`
// says why they are these.
// ---------------------------------------------------------------------------

/** The round a route's own creation enqueues. */
export const EMAIL_VALIDATION_ROUND_NEW = 'new';

/**
 * The `route.validate` job for one email route at one version.
 *
 * Built here and nowhere else, so the creation path, the scheduler's sweep and a
 * person's "Check again" cannot disagree about the payload the handler parses.
 */
export function emailValidationJob(
  workspaceId: string,
  routeId: string,
  routeVersion: number,
  round: string,
): JobSpecification {
  return {
    workspaceId,
    kind: 'route.validate',
    idempotencyKey: jobIdempotencyKey.routeValidate(routeId, routeVersion, round),
    payload: { routeKind: 'email', routeId, routeVersion },
    maxAttempts: 4,
  };
}

export interface RecordEmailValidationInput {
  readonly routeId: string;
  /** The version the check was made against. A route that has moved since is left alone. */
  readonly routeVersion: number;
  /** A definite answer. A check that could not answer writes nothing at all. */
  readonly technicalValidation: 'passed' | 'failed';
  /**
   * The association confidence to record when the route has none and the check passed,
   * or null to record none. A recorded confidence is never replaced.
   */
  readonly vouchedConfidence: number | null;
  /** Codes for the audit event: the rule version, the reason, the basis. Never the address. */
  readonly detail: Readonly<Record<string, unknown>>;
}

export type RecordEmailValidationOutcome =
  | { readonly written: true; readonly route: RouteRow }
  | {
      readonly written: false;
      /**
       * `superseded`: the route is no longer the unchecked candidate at the version the
       * check was made for — it was checked already, re-decided, bounced, retired, or its
       * version moved. Whatever it is now is newer than this answer.
       */
      readonly reason: 'route_unknown' | 'firm_unknown' | 'superseded' | CrmRefusalCode;
    };

/**
 * Record a technical validation on an email route that nobody has checked yet
 * (specification 7.4; lane g90).
 *
 * A compare-and-set. It writes only while the route is still `candidate`, still
 * `technical_validation = 'unknown'` and still at `routeVersion`, under the route's row
 * lock and then the firm's, the order every command in this file takes them. So a
 * `usable` route is never touched here — nothing this function does can lower one — and
 * a second run of the same job finds a route that has moved on.
 *
 * Eligibility is `decideRouteEligibility`'s, from the route's own source and its
 * confidence: the recorded one, or when there is none and the check passed, the
 * `vouchedConfidence` the caller's rule supplies for how the address got here. The
 * version bumps, because the validation changed (the database's trigger insists).
 */
export async function recordEmailRouteValidation(
  context: RepositoryContext,
  input: RecordEmailValidationInput,
): Promise<RecordEmailValidationOutcome> {
  const loaded = await loadRouteForUpdate(context, 'email', input.routeId);
  if (loaded === null) return { written: false, reason: 'route_unknown' };
  const firm = await loadFirmForUpdate(context, loaded.firm_id);
  if (firm === null) return { written: false, reason: 'firm_unknown' };
  const decision = decideFirmMutation(context, firm);
  if (!decision.permitted) return { written: false, reason: decision.reason };
  if (
    Number(loaded.version) !== input.routeVersion ||
    loaded.eligibility !== 'candidate' ||
    loaded.technical_validation !== 'unknown'
  ) {
    return { written: false, reason: 'superseded' };
  }

  const recorded = loaded.association_confidence === null ? null : Number(loaded.association_confidence);
  const confidence = recorded ?? (input.technicalValidation === 'passed' ? input.vouchedConfidence : null);
  const eligibility = decideRouteEligibility({
    source: loaded.source,
    technicalValidation: input.technicalValidation,
    associationConfidence: confidence,
  });

  const { rows } = await context.db.query<RouteRow>(
    `UPDATE email_addresses
        SET technical_validation = $3,
            association_confidence = $4,
            eligibility = $5,
            eligibility_policy_version = $6,
            version = version + 1,
            updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND version = $7
      RETURNING ${ROUTE_COLUMNS}`,
    [
      context.scope.workspaceId,
      input.routeId,
      input.technicalValidation,
      confidence,
      eligibility.eligibility,
      eligibility.policyVersion,
      input.routeVersion,
    ],
  );
  const updated = rows[0];
  if (updated === undefined) return { written: false, reason: 'superseded' };

  await recordCrmAuditEvent(context, {
    action: 'route.email.validated',
    subjectKind: 'route',
    subjectId: input.routeId,
    detail: {
      ...input.detail,
      firmId: loaded.firm_id,
      technicalValidation: updated.technical_validation,
      eligibility: updated.eligibility,
      policyVersion: updated.eligibility_policy_version,
      confidenceBasis: recorded !== null ? 'recorded' : confidence !== null ? 'vouched' : 'none',
      fromVersion: Number(loaded.version),
      version: Number(updated.version),
    },
  });
  return { written: true, route: updated };
}

export interface VerifyRouteInput {
  readonly routeKind: RouteKind;
  readonly routeId: string;
  readonly technicalValidation: TechnicalValidation;
  readonly associationConfidence?: number | undefined;
}

/**
 * Re-decide a route's eligibility from a fresh validation result.
 *
 * The version bumps whenever the eligibility moves, which is what a client card is
 * comparing against. It does not bump when nothing changed, so re-verifying a route
 * that was already usable does not invalidate every card showing it.
 */
export async function verifyRoute(
  context: RepositoryContext,
  input: VerifyRouteInput,
): Promise<CrmResult<RouteRow>> {
  const loaded = await loadRouteForUpdate(context, input.routeKind, input.routeId);
  if (loaded === null) return refuse('route_unknown');
  const firm = await loadFirmForUpdate(context, loaded.firm_id);
  if (firm === null) return refuse('firm_unknown');
  const decision = decideFirmMutation(context, firm);
  if (!decision.permitted) return refuse(decision.reason);
  if (loaded.eligibility === 'retired') return refuse('route_retired');

  const confidence =
    input.associationConfidence ??
    (loaded.association_confidence === null ? null : Number(loaded.association_confidence));
  const eligibility = evidenceFor(input.routeKind, loaded.source, input.technicalValidation, confidence);
  const changed =
    eligibility.eligibility !== loaded.eligibility || eligibility.technicalValidation !== loaded.technical_validation;

  const table = TABLES[input.routeKind];
  const { rows } = await context.db.query<RouteRow>(
    `UPDATE ${table.table}
        SET technical_validation = $3,
            association_confidence = $4,
            eligibility = $5,
            eligibility_policy_version = $6,
            version = version + CASE WHEN $7::boolean THEN 1 ELSE 0 END,
            updated_at = now()
      WHERE workspace_id = $1 AND id = $2
      RETURNING ${ROUTE_COLUMNS}`,
    [
      context.scope.workspaceId,
      input.routeId,
      eligibility.technicalValidation,
      eligibility.associationConfidence,
      eligibility.eligibility,
      eligibility.policyVersion,
      changed,
    ],
  );
  const updated = rows[0];
  if (updated === undefined) return refuse('route_unknown');

  await recordCrmAuditEvent(context, {
    action: `route.${input.routeKind}.verified`,
    subjectKind: 'route',
    subjectId: input.routeId,
    detail: { eligibility: updated.eligibility, version: updated.version },
  });
  return accept(updated);
}

export interface ConfirmPhoneRouteInput {
  readonly routeId: string;
  /** The version the person was looking at. A route that has changed since is refused. */
  readonly routeVersion: number;
}

/**
 * A person confirms a phone number reaches the firm (lane g88).
 *
 * @deprecated (remove after desktop 1.0.12) — a phone number is usable on entry since wave
 * 2 (S4.4), and a dial accepts one an older release left `candidate`. Kept because
 * desktops up to 1.0.11 offer "Confirm this number" for such a row, and it still makes
 * that row `usable` in its stored state.
 *
 * Section 7.4 makes a route `usable` only when a versioned provider/source policy
 * satisfies both technical validation and association confidence. For a phone number in
 * version one the person *is* the provider: a call is a `tel:` handoff, nothing Callie
 * runs sees the line, and the calling-identity lane already made the same judgement for
 * the number a call leaves on (`docs/decisions/g60-calling-identities-are-attested-in-version-one.md`).
 * So the confirmation supplies both halves — the number was checked, and it is this
 * firm's — as `technical_validation = 'passed'` and a confidence of 1, and
 * `decideRouteEligibility` still decides what that makes the route. Nothing here writes
 * `usable` itself.
 *
 * Who confirmed and when is the audit event (actor, database time) and the command's
 * receipt; `method: 'person_confirmed'` in its detail is what tells a later reader this
 * route was vouched for by a person rather than validated by a provider.
 *
 * The version bumps, because the eligibility moved and 9.1's card compares against it.
 * A confirmation of the version the person was not looking at is refused
 * `route_version_stale`: they confirmed a number, and it may not be this one any more.
 * A usable route is answered as it is, without a bump. A route that failed validation is
 * refused `route_invalid`: the policy says a failure is a new retrieval, not a higher
 * confidence, and a person's word does not overrule a line that was tested dead.
 *
 * Email is deliberately absent: `docs/decisions/g88-founder-authoring-and-review.md`.
 */
export async function confirmPhoneRoute(
  context: RepositoryContext,
  input: ConfirmPhoneRouteInput,
): Promise<CrmResult<RouteRow>> {
  const loaded = await loadRouteForUpdate(context, 'phone', input.routeId);
  if (loaded === null) return refuse('route_unknown');
  const firm = await loadFirmForUpdate(context, loaded.firm_id);
  if (firm === null) return refuse('firm_unknown');
  const decision = decideFirmMutation(context, firm);
  if (!decision.permitted) return refuse(decision.reason);
  if (loaded.eligibility === 'retired') return refuse('route_retired');
  if (Number(loaded.version) !== input.routeVersion) return refuse('route_version_stale');
  if (loaded.eligibility === 'usable') return accept(loaded);
  if (loaded.eligibility === 'invalid') return refuse('route_invalid');

  const eligibility = decideRouteEligibility({
    source: loaded.source,
    technicalValidation: 'passed',
    associationConfidence: 1,
  });
  if (eligibility.eligibility !== 'usable') return refuse('invalid_input');

  const { rows } = await context.db.query<RouteRow>(
    `UPDATE phone_routes
        SET technical_validation = 'passed',
            association_confidence = 1,
            eligibility = $3,
            eligibility_policy_version = $4,
            version = version + 1,
            updated_at = now()
      WHERE workspace_id = $1 AND id = $2
      RETURNING ${ROUTE_COLUMNS}`,
    [context.scope.workspaceId, input.routeId, eligibility.eligibility, eligibility.policyVersion],
  );
  const updated = rows[0];
  if (updated === undefined) return refuse('route_unknown');

  await recordCrmAuditEvent(context, {
    action: 'route.phone.confirmed',
    subjectKind: 'route',
    subjectId: input.routeId,
    detail: {
      firmId: loaded.firm_id,
      method: 'person_confirmed',
      fromVersion: Number(loaded.version),
      version: Number(updated.version),
      eligibility: updated.eligibility,
      policyVersion: updated.eligibility_policy_version,
    },
  });
  return accept(updated);
}

/**
 * Retire a route (9.1: "Wrong number — retire the route; do not suppress the firm").
 *
 * Retirement is not suppression. It says this number does not reach this firm, and it
 * says nothing about whether the firm may be contacted — which is why a wrong number
 * never writes a `suppression_events` row.
 */
export async function retireRoute(
  context: RepositoryContext,
  input: { readonly routeKind: RouteKind; readonly routeId: string; readonly reason: string },
): Promise<CrmResult<RouteRow>> {
  const loaded = await loadRouteForUpdate(context, input.routeKind, input.routeId);
  if (loaded === null) return refuse('route_unknown');
  const firm = await loadFirmForUpdate(context, loaded.firm_id);
  if (firm === null) return refuse('firm_unknown');
  const decision = decideFirmMutation(context, firm);
  if (!decision.permitted) return refuse(decision.reason);
  if (loaded.eligibility === 'retired') return accept(loaded);
  if (input.reason.trim().length === 0) return refuse('invalid_input');

  const table = TABLES[input.routeKind];
  const { rows } = await context.db.query<RouteRow>(
    `UPDATE ${table.table}
        SET eligibility = 'retired', retired_at = now(), retired_reason = $3,
            eligibility_policy_version = NULL, version = version + 1, updated_at = now()
      WHERE workspace_id = $1 AND id = $2
      RETURNING ${ROUTE_COLUMNS}`,
    [context.scope.workspaceId, input.routeId, input.reason.trim()],
  );
  const updated = rows[0];
  if (updated === undefined) return refuse('route_unknown');

  await emitCrmDomainEvent(context, {
    kind: 'route.retired',
    firmId: loaded.firm_id,
    dedupeKey: `${input.routeKind}:${input.routeId}:${String(updated.version)}`,
    reasonCode: 'route_retired',
    detail: { routeKind: input.routeKind, version: updated.version },
  });
  await recordCrmAuditEvent(context, {
    action: `route.${input.routeKind}.retired`,
    subjectKind: 'route',
    subjectId: input.routeId,
    detail: { firmId: loaded.firm_id, version: updated.version },
  });
  return accept(updated);
}

export async function listRoutes(
  context: RepositoryContext,
  kind: RouteKind,
  firmId: string,
  options: { readonly eligibility?: RouteEligibility } = {},
): Promise<readonly RouteRow[]> {
  const table = TABLES[kind];
  const { rows } = await context.db.query<RouteRow>(
    `SELECT ${ROUTE_COLUMNS}, ${table.valueColumn} AS value
       FROM ${table.table}
      WHERE workspace_id = $1 AND firm_id = $2
        AND ($3::text IS NULL OR eligibility = $3::text)
      ORDER BY eligibility, version DESC`,
    [context.scope.workspaceId, firmId, options.eligibility ?? null],
  );
  return rows;
}

async function loadRouteForUpdate(
  context: RepositoryContext,
  kind: RouteKind,
  routeId: string,
): Promise<RouteRow | null> {
  const table = TABLES[kind];
  const { rows } = await context.db.query<RouteRow>(
    `SELECT ${ROUTE_COLUMNS} FROM ${table.table} WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
    [context.scope.workspaceId, routeId],
  );
  return rows[0] ?? null;
}

async function readRouteByValue(
  context: RepositoryContext,
  kind: RouteKind,
  firmId: string,
  contactId: string | null,
  value: string,
): Promise<RouteRow | null> {
  const table = TABLES[kind];
  const { rows } = await context.db.query<RouteRow>(
    `SELECT ${ROUTE_COLUMNS} FROM ${table.table}
      WHERE workspace_id = $1 AND firm_id = $2 AND contact_id IS NOT DISTINCT FROM $3 AND ${table.valueColumn} = $4`,
    [context.scope.workspaceId, firmId, contactId, value],
  );
  return rows[0] ?? null;
}
