import { z } from 'zod';

/**
 * The release record (specification 16.2, Appendix G 42; lanes g71 and g96).
 *
 * It is the thing an admin names when enabling production sending:
 * `workspace_settings.sending_enabled.releaseGateReference` is its
 * `releaseGateReference`. Until lane g71 the reference was any nonempty string and
 * nothing compared it with anything, so "the deployed commit/image digests match the
 * rehearsal artifacts" was an operator instruction rather than a rule.
 *
 * Two things write one, and `source` says which (lane g96, the owner's axiom 10B of
 * 25 September 2026: the record comes from the CI gate):
 *
 *   * **`ci-gate`** — `infra/scripts/release-record-from-ci.sh`, from the green
 *     *Greenfield gate* run on the deployed commit and the green *Greenfield images*
 *     run whose `fss-image-digests` names the same two digests. This is the record a
 *     release puts. A CI run drills nothing, so it carries no `rehearsalPrefix` or
 *     `rehearsalScenarios`, and a `ci-gate` record that claims one is refused: it names
 *     the run, its URL and the commit instead.
 *   * **the rehearsal** — `infra/scripts/rehearsal-release-record.sh`, the last step of
 *     a green `full` rehearsal. It writes no `source` (every record stored before g96
 *     is one of these, so an absent `source` means the rehearsal), and it still has to
 *     carry both drill fields.
 *
 * Both are `fss.release-record.v1`: the table's CHECK (`0017_release_records.sql`) and
 * `release-deploy.sh --release-record` both read that id, and the five columns the
 * rules compare — reference, suite, the two digests, the desktop stamp — are the same
 * fields in both. The binding (`packages/domain/release/records.ts`) reads only those,
 * so a `ci-gate` record binds sending exactly as a rehearsal's does.
 *
 * The shape lives here, in `@fss/contracts`, for the reason every other wire shape
 * does: two places have to agree about it and neither may import the other. The
 * script writes it and the domain stores it. `test/release/scenario42.check.ts` runs
 * the script and parses what it wrote with `releaseRecordSchema`, so a field renamed
 * on either side fails the release suite rather than the production enable.
 *
 * **Strict, on purpose.** An unknown field is refused rather than stripped: a record
 * from a script this contract no longer describes is a record nobody has reviewed the
 * meaning of, and storing a subset of it would store a claim the writer did not make.
 * `test/release/releaseRecordFromCi.check.ts` does for the CI script what
 * `scenario42.check.ts` does for the rehearsal's.
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
 * The release process, as an attestation can name it (lane g100; the owner's decision
 * of 25 September 2026 that app-only merges deploy themselves).
 *
 * Until g100 the owner's `sending_enabled` attestation named one record, so every CI
 * deploy of a new worker digest held sending until somebody put a record for it and
 * attested again, which is a person in the loop of every automatic deploy. The
 * attestation may now name the process instead: `releaseGateReference: "ci-gate:main"`
 * means *any stored record with `source: "ci-gate"`* — which only
 * `infra/scripts/release-record-from-ci.sh` writes, and only from a green *Greenfield
 * gate* run of a push to main at the record's commit — normally put by the CI deploy
 * after its rollout and smoke passed. Each process still compares its own half of the
 * record with its own digest, exactly as under a named reference; a rehearsal record is
 * never admitted by the policy, only by its own reference.
 */
export const CI_GATE_MAIN_POLICY = 'ci-gate:main';

/** What an attestation's `releaseGateReference` names: one record, or the process. */
export type ReleaseAttestation =
  | { readonly kind: 'reference'; readonly reference: string }
  | { readonly kind: 'policy'; readonly policy: typeof CI_GATE_MAIN_POLICY };

/** Read the attestation's `releaseGateReference`: the policy's exact name, or one reference. */
export function releaseAttestationOf(releaseGateReference: string): ReleaseAttestation {
  return releaseGateReference === CI_GATE_MAIN_POLICY
    ? { kind: 'policy', policy: CI_GATE_MAIN_POLICY }
    : { kind: 'reference', reference: releaseGateReference };
}

/**
 * `<rehearsal prefix>-<recordedAt>` from a rehearsal
 * (`fss-rh-202609250554-2026-09-25T07:20:44Z`), `ci-gate-<gate run id>-<first twelve
 * characters of the commit>` from the CI gate (`ciGateReleaseReference`). Bounded at
 * 200 characters, which is the bound `sendingEnabledSettingSchema` already puts on the
 * reference an admin types.
 */
export const releaseGateReferenceSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u, 'a release gate reference')
  // The process attestation's name is not a record's (lane g100): an attestation that
  // says `ci-gate:main` must mean the policy and never one stored row that happens to
  // carry the same string.
  .refine(value => value !== CI_GATE_MAIN_POLICY, { message: `${CI_GATE_MAIN_POLICY} names the release process, not a record` });

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

/** Who wrote the record. An absent `source` is the rehearsal (every record before g96). */
export const RELEASE_RECORD_SOURCES = ['ci-gate', 'rehearsal'] as const;
export type ReleaseRecordSource = (typeof RELEASE_RECORD_SOURCES)[number];

/** A full forty-character lower-case commit, which is what GitHub reports as `headSha`. */
export const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
/** A GitHub Actions run id (`databaseId`), as a string so no reader rounds it. */
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
/** `gh run view --json url`: the run's page, and nothing after the id. */
const GATE_RUN_URL_PATTERN = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/([1-9][0-9]{0,19})$/u;

/** The one reference a `ci-gate` record may carry, composed the way the script composes it. */
export function ciGateReleaseReference(gateRunId: string, commit: string): string {
  return `ci-gate-${gateRunId}-${commit.slice(0, 12)}`;
}

/**
 * The record a green `full` rehearsal writes (`rehearsal-release-record.sh`). Until 26
 * September 2026 it also carried the old-app carry drill's verdict; the carry was deleted
 * (the old app's DynamoDB tables were destroyed on 17 September 2026), and records
 * stored before then are read back from their columns, never re-parsed.
 */
export const rehearsalReleaseRecordSchema = z.strictObject({
  schema: z.literal(RELEASE_RECORD_SCHEMA_ID),
  /** Absent in every record the rehearsal script writes; accepted when spelled out. */
  source: z.literal('rehearsal').optional(),
  releaseGateReference: releaseGateReferenceSchema,
  rehearsalPrefix: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/u, 'a rehearsal prefix'),
  recordedAt: recordedAtSchema,
  suite: releaseSuiteSchema,
  artifacts: releaseArtifactsSchema,
  /** Appendix G 11, 22 and 39, one report line each, keyed by scenario number. */
  rehearsalScenarios: z.record(z.string().regex(/^\d{1,2}$/u), z.string().max(4000)),
  /** Always false from the script: a record enables nothing by itself. */
  enablesSending: z.boolean(),
});
export type RehearsalReleaseRecord = z.infer<typeof rehearsalReleaseRecordSchema>;

/**
 * The record `infra/scripts/release-record-from-ci.sh` writes (lane g96).
 *
 * The same five fields the rules compare, and in place of the drill evidence the facts
 * the script checked: the commit, the *Greenfield gate* run that was green on it (id
 * and URL), and the *Greenfield images* run whose `fss-image-digests` named the two
 * digests. The desktop stamp is the commit (release.md 2.0), and the reference is
 * composed from the run and the commit, so a record cannot name one run and carry
 * another's reference. `recordedAt` is the moment the gate run concluded, so building
 * the record twice for one run writes the same record and a second put is `existing`.
 *
 * `enablesSending` is the operator's `--enables-sending`: whether this release is the
 * one sending is to be switched on under. Nothing binds on it. Sending is still the
 * deployment flag and the admin's attestation (release.md section 6), unchanged.
 */
export const ciGateReleaseRecordSchema = z
  .strictObject({
    schema: z.literal(RELEASE_RECORD_SCHEMA_ID),
    source: z.literal('ci-gate'),
    releaseGateReference: releaseGateReferenceSchema,
    recordedAt: recordedAtSchema,
    suite: releaseSuiteSchema,
    commit: z.string().regex(COMMIT_SHA_PATTERN, 'a full forty-character commit'),
    gateRunId: z.string().regex(RUN_ID_PATTERN, 'a GitHub Actions run id'),
    gateRunUrl: z.string().regex(GATE_RUN_URL_PATTERN, 'a GitHub Actions run URL'),
    imagesRunId: z.string().regex(RUN_ID_PATTERN, 'a GitHub Actions run id'),
    artifacts: releaseArtifactsSchema,
    enablesSending: z.boolean(),
  })
  .superRefine((value, context) => {
    if (value.releaseGateReference !== ciGateReleaseReference(value.gateRunId, value.commit)) {
      context.addIssue({
        code: 'custom',
        path: ['releaseGateReference'],
        message: `a ci-gate record's reference is ${ciGateReleaseReference(value.gateRunId, value.commit)}`,
      });
    }
    if (GATE_RUN_URL_PATTERN.exec(value.gateRunUrl)?.[1] !== value.gateRunId) {
      context.addIssue({ code: 'custom', path: ['gateRunUrl'], message: 'the URL names another run than gateRunId' });
    }
    if (value.imagesRunId === value.gateRunId) {
      context.addIssue({ code: 'custom', path: ['imagesRunId'], message: 'the images run is the gate run' });
    }
    if (value.artifacts.desktopCommitStamp !== value.commit) {
      context.addIssue({
        code: 'custom',
        path: ['artifacts', 'desktopCommitStamp'],
        message: 'the desktop commit stamp of a ci-gate record is its commit',
      });
    }
  });
export type CiGateReleaseRecord = z.infer<typeof ciGateReleaseRecordSchema>;

/** Either, told apart by `source`; the drill fields are required of the rehearsal only. */
export const releaseRecordSchema = z.discriminatedUnion('source', [rehearsalReleaseRecordSchema, ciGateReleaseRecordSchema]);
export type ReleaseRecord = z.infer<typeof releaseRecordSchema>;

/** `ci-gate` or `rehearsal`, for a record the contract accepted. */
export function releaseRecordSource(record: ReleaseRecord): ReleaseRecordSource {
  return record.source ?? 'rehearsal';
}

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
