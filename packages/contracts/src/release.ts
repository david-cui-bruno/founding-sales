import { z } from 'zod';

/**
 * The release record (specification 16.2, Appendix G 42; lane g71).
 *
 * `infra/scripts/rehearsal-release-record.sh` writes this JSON as the last step of a
 * green `full` rehearsal, and it is the thing an admin names when enabling production
 * sending: `workspace_settings.sending_enabled.releaseGateReference` is its
 * `releaseGateReference`. Until lane g71 the reference was any nonempty string and
 * nothing compared it with anything, so "the deployed commit/image digests match the
 * rehearsal artifacts" was an operator instruction rather than a rule.
 *
 * The shape lives here, in `@fss/contracts`, for the reason every other wire shape
 * does: two places have to agree about it and neither may import the other. The
 * script writes it and the domain stores it. `test/release/scenario42.check.ts` runs
 * the script and parses what it wrote with `releaseRecordSchema`, so a field renamed
 * on either side fails the release suite rather than the production enable.
 *
 * **Strict, on purpose.** An unknown field is refused rather than stripped: a record
 * from a script this contract no longer describes is a record nobody has reviewed the
 * meaning of, and storing a subset of it would store a claim the rehearsal did not
 * make.
 */

export const RELEASE_RECORD_SCHEMA_ID = 'fss.release-record.v1';

/**
 * `sha256:` and 64 lower-case hex digits. The script refuses anything else, the cluster
 * module refuses a task definition image without it, and the comparison the gate makes
 * is only meaningful between two of these: a tag is mutable.
 */
export const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
export const imageDigestSchema = z.string().regex(IMAGE_DIGEST_PATTERN, 'an image digest');

export function isImageDigest(value: unknown): value is string {
  return typeof value === 'string' && IMAGE_DIGEST_PATTERN.test(value);
}

/**
 * `<rehearsal prefix>-<recordedAt>`, as the script composes it
 * (`fss-rh-202609250554-2026-09-25T07:20:44Z`). Bounded at 200 characters, which is
 * the bound `sendingEnabledSettingSchema` already puts on the reference an admin types.
 */
export const releaseGateReferenceSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u, 'a release gate reference');

/** `date -u +%Y-%m-%dT%H:%M:%SZ`, which is what the script writes; fractions tolerated. */
const recordedAtSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/u, 'a UTC instant')
  .refine(value => !Number.isNaN(Date.parse(value)), { message: 'a real instant' });

/**
 * The suite's verdict, as a word.
 *
 * Not `z.literal('pass')`, although the script only ever writes `pass`: the record is
 * stored as the rehearsal wrote it, and "is this a passing record" is the enable rule's
 * question (`release_record_not_passing`), asked at the moment an admin relies on it.
 * A contract that refused every other word would make that rule unreachable and its
 * test vacuous.
 */
export const releaseSuiteSchema = z.string().regex(/^[a-z][a-z_]{0,39}$/u, 'a suite verdict');

export const releaseArtifactsSchema = z
  .strictObject({
    api: imageDigestSchema,
    worker: imageDigestSchema,
    /** The desktop build's commit stamp. Free text to the script, so bounded here. */
    desktopCommitStamp: z.string().trim().min(1).max(200),
  })
  .refine(value => value.api !== value.worker, {
    // The script's own refusal: one image pushed under both names.
    message: 'the API and worker digests are identical',
  });

export const releaseRecordSchema = z.strictObject({
  schema: z.literal(RELEASE_RECORD_SCHEMA_ID),
  releaseGateReference: releaseGateReferenceSchema,
  rehearsalPrefix: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/u, 'a rehearsal prefix'),
  recordedAt: recordedAtSchema,
  suite: releaseSuiteSchema,
  artifacts: releaseArtifactsSchema,
  /** Appendix G 20's export half needs a cutover watermark; the drill says which it ran. */
  carryDrill: z.enum(['ran', 'skipped_no_watermark']),
  /** Appendix G 11, 20, 22 and 39, one report line each, keyed by scenario number. */
  rehearsalScenarios: z.record(z.string().regex(/^\d{1,2}$/u), z.string().max(4000)),
  /** Always false from the script: a record enables nothing by itself. */
  enablesSending: z.boolean(),
});
export type ReleaseRecord = z.infer<typeof releaseRecordSchema>;

/**
 * Why a stored attestation does not bind to the artifact that is asking.
 *
 * The same four answers at both moments that ask: the API when an admin saves
 * `sending_enabled` with `enabled: true` (a settings refusal), and the worker before
 * every dispatch (the `detail` of `workspace_sending_not_attested`).
 *
 *   * `release_record_unknown` — no stored record has that reference;
 *   * `release_record_not_passing` — the record's suite is not `pass`;
 *   * `release_record_identity_unknown` — the process cannot say which image it is
 *     running, so there is nothing to compare, and the answer is no;
 *   * `release_record_digest_mismatch` — the record names a different image than the
 *     one running.
 */
export const RELEASE_RECORD_BINDING_REFUSAL_CODES = [
  'release_record_unknown',
  'release_record_not_passing',
  'release_record_identity_unknown',
  'release_record_digest_mismatch',
] as const;
export type ReleaseRecordBindingRefusal = (typeof RELEASE_RECORD_BINDING_REFUSAL_CODES)[number];

/** Why `fss admin release-record put` stored nothing. */
export const RELEASE_RECORD_PUT_REFUSAL_CODES = ['release_record_invalid', 'release_record_conflict'] as const;
export type ReleaseRecordPutRefusal = (typeof RELEASE_RECORD_PUT_REFUSAL_CODES)[number];
