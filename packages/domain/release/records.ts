import {
  CI_GATE_MAIN_POLICY,
  isImageDigest,
  releaseAttestationOf,
  releaseRecordSchema,
  releaseRecordSource,
  sendingEnabledSettingSchema,
  type ReleaseRecord,
  type ReleaseRecordBindingRefusal,
  type ReleaseRecordPutRefusal,
} from '@fss/contracts';
import type { Queryable } from '../db/queryable.ts';

/**
 * The release records, and the one rule that reads them (specification 16.2,
 * Appendix G 42; lane g71).
 *
 * 16.2 asks three things before production sends: the mandatory rehearsal scenarios
 * passed, "the deployed commit/image digests match the rehearsal artifacts", and an
 * authenticated admin enabled sending. A record of the first is written by the CI gate
 * since lane g96 (`infra/scripts/release-record-from-ci.sh`, `source: "ci-gate"`, the
 * owner's axiom 10B) and by a green `full` rehearsal before it
 * (`infra/scripts/rehearsal-release-record.sh`); the admin's attestation names that
 * record's `releaseGateReference`, and this file is what makes the middle clause a
 * comparison rather than a sentence: a stored record, compared with the digest of the
 * image that is asking. The rule reads the reference, the suite and the two digests,
 * which both kinds of record carry, and never the rehearsal's drill fields, so a
 * `ci-gate` record binds exactly as a rehearsal's does.
 *
 * Two moments ask, and each compares its own half of the record:
 *
 *   * **the API, when an admin enables sending** (`updateSetting`): the record must
 *     pass and its `api` digest must be the running API's. The API is the process
 *     that takes the admin's statement, so it is the one that can check the statement
 *     against itself.
 *   * **the worker, before every dispatch** (`decideSend`): the record must pass and
 *     its `worker` digest must be the running worker's. The worker is the process that
 *     sends, so a deploy of a different worker after the enable stops sending at once,
 *     without anybody remembering to withdraw the attestation.
 *
 * Neither side trusts the other's check: an API that accepted an enable is not a
 * statement about which worker is running, and a worker that finds a record is not a
 * statement about which API took the enable. See
 * `docs/decisions/g71-sending-gate-is-bound-to-the-release-record.md`.
 *
 * **Two forms of attestation** (lane g100). The attestation names one record's
 * reference, as since g71, or the release process, `ci-gate:main`
 * (`CI_GATE_MAIN_POLICY`): any stored `source: "ci-gate"` record whose half names the
 * asking process's digest. The first binds one release; the second binds every release
 * the CI gate certified, so an automatic deploy that puts its record keeps sending on
 * without the owner attesting again. Under both, each side still compares its own half
 * with its own digest, and a binding says which form admitted it (`admittedBy`), which
 * the send gate writes on the claim it makes.
 *
 * Release records are deployment facts, not workspace facts, so these functions take
 * a bare `{ db }` rather than a `RepositoryContext`. A `RepositoryContext` satisfies
 * it, which is how the settings command and the send gate call them inside their own
 * transactions; the `fss` tool, which acts for no workspace, passes its session.
 */

export interface ReleaseRecordContext {
  readonly db: Queryable;
}

/** One stored record: the columns the rules read, and the record itself. */
export interface StoredReleaseRecord {
  readonly reference: string;
  readonly recordedAt: string;
  readonly suite: string;
  readonly apiDigest: string;
  readonly workerDigest: string;
  readonly desktopCommitStamp: string;
  readonly enablesSending: boolean;
  readonly record: ReleaseRecord;
  readonly putAt: string;
}

export type ReleaseRecordPutResult =
  | {
      readonly ok: true;
      readonly value: { readonly outcome: 'created' | 'existing'; readonly record: StoredReleaseRecord };
    }
  | { readonly ok: false; readonly reason: ReleaseRecordPutRefusal; readonly detail: string };

interface ReleaseRecordRow {
  readonly reference: string;
  readonly recorded_at: Date;
  readonly suite: string;
  readonly api_digest: string;
  readonly worker_digest: string;
  readonly desktop_commit_stamp: string;
  readonly enables_sending: boolean;
  readonly record: ReleaseRecord;
  readonly put_at: Date;
  readonly [column: string]: unknown;
}

const COLUMNS =
  'reference, recorded_at, suite, api_digest, worker_digest, desktop_commit_stamp, enables_sending, record, put_at';

function toStored(row: ReleaseRecordRow): StoredReleaseRecord {
  return {
    reference: row.reference,
    recordedAt: row.recorded_at.toISOString(),
    suite: row.suite,
    apiDigest: row.api_digest,
    workerDigest: row.worker_digest,
    desktopCommitStamp: row.desktop_commit_stamp,
    enablesSending: row.enables_sending,
    record: row.record,
    putAt: row.put_at.toISOString(),
  };
}

/** The first few issues, as `path: message`. The record is not secret; its shape is the answer. */
function describeIssues(issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[]): string {
  return issues
    .slice(0, 3)
    .map(issue => `${issue.path.map(String).join('.') || '(record)'}: ${issue.message}`)
    .join('; ');
}

/**
 * Store one `fss.release-record.v1`, idempotently by reference.
 *
 * Takes the JSON text or an already-parsed value. The contract is applied first and
 * the row is written only from what it returned, so a record not in the shape its
 * `source` requires is refused with `release_record_invalid` and names the field.
 *
 * The same reference twice is `existing` when the content is the same (jsonb equality,
 * so key order and whitespace do not matter) and `release_record_conflict` when it is
 * not. There is no update: an attestation must never come to name a record whose
 * digests changed after the admin relied on it, and the table's privileges refuse the
 * UPDATE anyway.
 */
export async function putReleaseRecord(context: ReleaseRecordContext, input: unknown): Promise<ReleaseRecordPutResult> {
  let candidate: unknown = input;
  if (typeof input === 'string') {
    try {
      candidate = JSON.parse(input);
    } catch {
      return { ok: false, reason: 'release_record_invalid', detail: 'the release record is not JSON' };
    }
  }
  const parsed = releaseRecordSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, reason: 'release_record_invalid', detail: describeIssues(parsed.error.issues) };
  }
  const record = parsed.data;
  const recordJson = JSON.stringify(record);

  const inserted = await context.db.query<ReleaseRecordRow>(
    `INSERT INTO release_records
       (reference, recorded_at, suite, api_digest, worker_digest, desktop_commit_stamp, enables_sending, record)
     VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8::jsonb)
     ON CONFLICT (reference) DO NOTHING
     RETURNING ${COLUMNS}`,
    [
      record.releaseGateReference,
      record.recordedAt,
      record.suite,
      record.artifacts.api,
      record.artifacts.worker,
      record.artifacts.desktopCommitStamp,
      record.enablesSending,
      recordJson,
    ],
  );
  const created = inserted.rows[0];
  if (created !== undefined) return { ok: true, value: { outcome: 'created', record: toStored(created) } };

  const existing = await context.db.query<ReleaseRecordRow & { readonly same: boolean }>(
    `SELECT ${COLUMNS}, record = $2::jsonb AS same FROM release_records WHERE reference = $1`,
    [record.releaseGateReference, recordJson],
  );
  const row = existing.rows[0];
  if (row === undefined) {
    // The conflicting row vanished between the two statements, which the revoked
    // DELETE makes impossible for the runtime role. Refused rather than retried.
    return { ok: false, reason: 'release_record_conflict', detail: 'the reference was taken and is no longer readable' };
  }
  if (!row.same) {
    return {
      ok: false,
      reason: 'release_record_conflict',
      detail: `a different record is already stored under ${record.releaseGateReference}; records are never replaced`,
    };
  }
  return { ok: true, value: { outcome: 'existing', record: toStored(row) } };
}

/** One stored record, or null. */
export async function readReleaseRecord(
  context: ReleaseRecordContext,
  reference: string,
): Promise<StoredReleaseRecord | null> {
  const { rows } = await context.db.query<ReleaseRecordRow>(
    `SELECT ${COLUMNS} FROM release_records WHERE reference = $1`,
    [reference],
  );
  const row = rows[0];
  return row === undefined ? null : toStored(row);
}

/** Which half of the record a process compares with itself. */
export type ReleaseArtifactSide = 'api' | 'worker';

/**
 * Which attestation admitted a binding: the record's own reference, or the release
 * process (`ci-gate:main`). Audited on every claim the send gate makes.
 */
export type ReleaseAdmission = 'reference' | typeof CI_GATE_MAIN_POLICY;

export type ReleaseBinding =
  | { readonly ok: true; readonly record: StoredReleaseRecord; readonly admittedBy: ReleaseAdmission }
  | { readonly ok: false; readonly reason: ReleaseRecordBindingRefusal };

function digestFor(record: StoredReleaseRecord, side: ReleaseArtifactSide): string {
  return side === 'api' ? record.apiDigest : record.workerDigest;
}

/**
 * Whether a record binds to the image that is asking. Pure, and the whole rule.
 *
 * The order is the order an operator fixes things in: a reference nobody stored, then
 * a record that did not pass, then a process that cannot say what it is running, then
 * the comparison itself. `runningDigest` is anything the bootstrap discovered —
 * including the literal `unknown` — and only a real `sha256:` digest can match, so an
 * unknown identity is a refusal and never a pass (fail closed).
 */
export function releaseRecordBinding(
  record: StoredReleaseRecord | null,
  side: ReleaseArtifactSide,
  runningDigest: string | null | undefined,
): ReleaseBinding {
  if (record === null) return { ok: false, reason: 'release_record_unknown' };
  if (record.suite !== 'pass') return { ok: false, reason: 'release_record_not_passing' };
  if (!isImageDigest(runningDigest)) return { ok: false, reason: 'release_record_identity_unknown' };
  if (digestFor(record, side) !== runningDigest) return { ok: false, reason: 'release_record_digest_mismatch' };
  return { ok: true, record, admittedBy: 'reference' };
}

/** The stored record named by `reference`, bound to the image that is asking. */
export async function bindReleaseRecord(
  context: ReleaseRecordContext,
  reference: string,
  side: ReleaseArtifactSide,
  runningDigest: string | null | undefined,
): Promise<ReleaseBinding> {
  return releaseRecordBinding(await readReleaseRecord(context, reference), side, runningDigest);
}

/**
 * Whether a record binds under the release process (`ci-gate:main`, lane g100). Pure,
 * and the whole of the policy form.
 *
 * `record` is what `readCiGateRecordFor` found for the running digest. The policy
 * admits a record only when the CI gate wrote it — `source: "ci-gate"`, which only
 * `release-record-from-ci.sh` writes, from a green gate run of a push to main at the
 * record's commit — so a rehearsal record is refused here even when it names this
 * digest; it binds only under its own reference. The order starts with the identity,
 * because the policy finds its record *by* the running digest: without one there is
 * nothing to look up (fail closed). Then no admitted record at all — no ci-gate record
 * names this image, which is the hold after a deploy whose record was not put — then
 * one that did not pass, then the comparison, which a record read by its digest passes
 * by construction and a record handed in by a caller need not.
 */
export function releasePolicyBinding(
  record: StoredReleaseRecord | null,
  side: ReleaseArtifactSide,
  runningDigest: string | null | undefined,
): ReleaseBinding {
  if (!isImageDigest(runningDigest)) return { ok: false, reason: 'release_record_identity_unknown' };
  if (record === null || releaseRecordSource(record.record) !== 'ci-gate') return { ok: false, reason: 'release_record_unknown' };
  const passed = record.suite === 'pass';
  if (!passed) return { ok: false, reason: 'release_record_not_passing' };
  if (runningDigest !== digestFor(record, side)) return { ok: false, reason: 'release_record_digest_mismatch' };
  return { ok: true, record, admittedBy: CI_GATE_MAIN_POLICY };
}

/**
 * The `ci-gate` record whose half names this digest, or null (lane g100).
 *
 * A passing one before any other, then the newest: one worker image can be certified by
 * more than one gate run when a commit changed only the API, and any passing record of
 * the CI gate is the statement the policy needs. Only `ci-gate` records are read, so a
 * rehearsal record for the same digest is never the answer.
 */
export async function readCiGateRecordFor(
  context: ReleaseRecordContext,
  side: ReleaseArtifactSide,
  digest: string,
): Promise<StoredReleaseRecord | null> {
  // A column chosen from a closed union, never from input.
  const column = side === 'api' ? 'api_digest' : 'worker_digest';
  const { rows } = await context.db.query<ReleaseRecordRow>(
    `SELECT ${COLUMNS} FROM release_records
      WHERE ${column} = $1 AND record->>'source' = 'ci-gate'
      ORDER BY (suite = 'pass') DESC, recorded_at DESC, reference
      LIMIT 1`,
    [digest],
  );
  const row = rows[0];
  return row === undefined ? null : toStored(row);
}

/**
 * What an attestation's `releaseGateReference` binds to the image that is asking: the
 * record it names, or — when it names the release process, `ci-gate:main` — the
 * `ci-gate` record for this digest (lane g100).
 */
export async function bindReleaseAttestation(
  context: ReleaseRecordContext,
  releaseGateReference: string,
  side: ReleaseArtifactSide,
  runningDigest: string | null | undefined,
): Promise<ReleaseBinding> {
  const attestation = releaseAttestationOf(releaseGateReference);
  if (attestation.kind === 'reference') return await bindReleaseRecord(context, attestation.reference, side, runningDigest);
  if (!isImageDigest(runningDigest)) return { ok: false, reason: 'release_record_identity_unknown' };
  return releasePolicyBinding(await readCiGateRecordFor(context, side, runningDigest), side, runningDigest);
}

/**
 * The binding of a stored `sending_enabled` value, or null when the value is not an
 * enable at all (disabled, unreadable, or naming no reference). A null is never a
 * pass: the callers treat it as "sending is not attested".
 */
export async function attestedReleaseBinding(
  context: ReleaseRecordContext,
  storedSetting: unknown,
  side: ReleaseArtifactSide,
  runningDigest: string | null | undefined,
): Promise<ReleaseBinding | null> {
  const parsed = sendingEnabledSettingSchema.safeParse(storedSetting);
  if (!parsed.success || !parsed.data.enabled || parsed.data.releaseGateReference === null) return null;
  return await bindReleaseAttestation(context, parsed.data.releaseGateReference, side, runningDigest);
}
