# Runtime, Recovery, and Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make sourcing failures visible and recoverable, add current verified encrypted backups and a founder-facing recovery drill, remove plaintext operational secrets and PII-bearing logs, surface prior identity-merge risks without mutation, and enforce an exact-SHA Node 24 release gate.

**Architecture:** Immediately contain already exposed credentials before implementation, then bound every local remote operation with owned abort signals, expose one durable in-process poll execution snapshot through sourcing and primary health contracts, and retain only allowlisted structured logs. Reuse the verified migration-backup discipline for immutable periodic backups, recording non-secret receipts in schema 15. Prepare permanent managed AWS parameter lookup and remote Terraform state before their separately confirmed migration. Keep identity analysis read-only until a separately reviewed and hashed manifest authorizes deterministic repair. Finish with tracked-source lint, secret scanning, CI, and package-marker verification tied to a protected-main commit.

**Tech Stack:** TypeScript 5.9, Node 24.20.0, Electron 44, React 19, Zod 4, Vitest 2, Playwright, SQLCipher/better-sqlite3, AWS SDK v3, Lambda, CloudWatch, SSM Parameter Store, KMS, S3, DynamoDB, OpenTofu/Terraform, GitHub Actions, gitleaks.

**Spec:** `docs/superpowers/specs/2026-09-04-runtime-recovery-security-hardening-design.md`

## Global Constraints

- Task 0 and Hold Point 0 are cross-plan preflight. Execute them immediately after the compliance plan's Task 0 schedule pause and before compliance Task 1 or any repository implementation.
- Execute runtime Tasks 1–13 after the compliance plan has registered schema 13 and 14, and before the lead-review plan registers schema 16. This plan exclusively owns schema 15.
- Known exposed provider and AWS credentials must be revoked or deactivated in Hold Point 0; if no safe replacement is ready, keep the dependent feature offline rather than extending exposure.
- Every `npm` or `npx` command begins with `export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"`.
- List operations time out after 30 seconds. Object fetch plus body transformation time out after 60 seconds. Each upload times out after 60 seconds. One full poll owns a 14-minute deadline.
- A timeout records a typed failure, leaves unprocessed ledger state untouched, releases the poll slot in `finally`, and allows the next scheduled or manual attempt.
- Health degrades after two 15-minute cadences without a successful poll, not after hours.
- Logs never contain person or organization names, phone numbers, email addresses, property street addresses, message subjects/bodies, provider payloads, contact HMACs, credentials, tokens, or recovery material.
- Backups are immutable, mode 0600 files in mode 0700 directories. Never overwrite a backup or delete a migration backup.
- Restore drills operate on private temporary copies, never the live database.
- Immediate exposed-credential containment, permanent managed-secret/state migration, and live identity repair are separate founder-confirmed hold points. Reversible code preparation does not authorize those operations.
- The identity audit is read-only. Repair code may be built and tested against fixtures, but no founder-data repair runs without an exact reviewed manifest and separate confirmation.
- Generated audit manifests, recovery receipts, and credential migration evidence stay outside the repository unless they contain no PII or secrets and the founder explicitly approves retention.

---

## File and Ownership Map

### Bounded sourcing runtime

- Create `src/main/runtime/abortDeadline.ts` and `tests/main/runtime/abortDeadline.test.ts`.
- Create `src/main/sourcing/pollExecutionState.ts` and `tests/main/sourcing/pollExecutionState.test.ts`.
- Modify `src/main/sourcing/inboxClient.ts`, `src/main/sourcing/upstreamSync.ts`, `src/main/sourcing/sourcingPoller.ts`, and their focused tests.
- Modify `src/shared/contracts/sourcingContract.ts`, `src/shared/healthContract.ts`, `src/main/health/healthService.ts`, `src/main/sourcing/registerSourcingIpc.ts`, `src/preload/apis/sourcingApi.ts`, `src/main/ipc/registerApplicationIpc.ts`, `src/main/startApplication.ts`, `src/renderer/foundation/SourcingStatusRow.tsx`, `src/renderer/foundation/SettingsScreen.tsx`, and their tests.

### PII-safe observability

- Create `src/main/logging/safeLogger.ts`, `src/main/logging/fileLogSink.ts`, and focused tests.
- Modify `src/main.ts`, `src/main/startApplication.ts`, sourcing/domain log call sites, `src/shared/contracts/shellContract.ts`, `src/preload/apis/shellApi.ts`, Settings, and tests.
- Create `cloud/lambdas/shared/src/safeLog.ts` and `cloud/lambdas/shared/test/safeLog.test.ts`.
- Modify each scheduled Lambda's `src/log.ts` and relevant handler tests.
- Modify `cloud/terraform/iam.tf`, `cloud/terraform/alarms.tf`, `cloud/terraform/dashboard.tf`, and `cloud/terraform/adapters.tf`.
- Create `tests/infrastructure/terraformHardening.test.ts`.

### Backup and recovery

- Create `src/main/db/migrations/0015RecoveryMetadata.ts` and `tests/main/db/migrations/0015RecoveryMetadata.test.ts`.
- Create `src/main/domain/operations/operationalSafetyRepository.ts` and its tests.
- Create `src/main/backup/verifiedBackup.ts`, `src/main/backup/backupRetention.ts`, `src/main/backup/backupService.ts`, and tests.
- Create `src/shared/contracts/recoveryContract.ts`, `src/main/recovery/recoveryService.ts`, `src/main/recovery/restoreDrill.ts`, `src/main/recovery/registerRecoveryIpc.ts`, `src/preload/apis/recoveryApi.ts`, and tests.
- Modify `src/main/db/migrationBackup.ts`, `src/main/db/migrate.ts`, `src/main/db/domainSchema.ts`, `src/main/foundation/foundationRuntime.ts`, `src/main/startApplication.ts`, `src/preload/createCallieApi.ts`, `src/main/ipc/registerApplicationIpc.ts`, Settings, and packaged E2E tests.

### Secrets, identity audit, and release governance

- Create `cloud/lambdas/shared/src/secureParameter.ts`, its test, `cloud/terraform/secrets.tf`, `cloud/terraform/backend.hcl.example`, `cloud/terraform/terraform.tfvars.example`, and `cloud/scripts/bootstrap-terraform-state.sh`.
- Modify Lambda handlers/configuration and Terraform variables/IAM/configuration without applying production changes.
- Create `src/main/db/readOnlyEncryptedDatabase.ts`, `src/main/identityMigration/identityMigrationAudit.ts`, `src/main/identityMigration/identityMigrationManifest.ts`, `scripts/runIdentityMigrationAudit.mjs`, `scripts/finalizeIdentityMigrationReview.mjs`, `scripts/buildOperationalTools.mjs`, and tests.
- Create `src/main/identityMigration/identityRepair.ts`, `src/main/identityMigration/identityRepairValidation.ts`, `scripts/runIdentityMigrationRepair.mjs`, and fixture-only tests.
- Create `scripts/lintTracked.mjs`, `scripts/verifyLambdas.mjs`, `scripts/verifySecrets.mjs`, `scripts/writeReleaseMarker.mjs`, `.gitleaks.toml`, `.github/workflows/ci.yml`, and `.github/workflows/release.yml`.
- Modify `package.json`, `package-lock.json`, `forge.config.ts`, `scripts/verifyPackage.mjs`, tests, and release documentation.

---

## Exact Interfaces

### Remote operation deadline

```ts
export type RemoteOperationCode =
  | 'S3_LIST_TIMEOUT'
  | 'S3_FETCH_TIMEOUT'
  | 'S3_BODY_TIMEOUT'
  | 'S3_UPLOAD_TIMEOUT'
  | 'POLL_TOTAL_TIMEOUT';

export class RemoteOperationTimeoutError extends Error {
  readonly code: RemoteOperationCode;
  readonly timeoutMs: number;
}

export function runWithAbortDeadline<T>(input: {
  code: RemoteOperationCode;
  timeoutMs: number;
  parentSignal?: AbortSignal;
  operation(signal: AbortSignal): Promise<T>;
}): Promise<T>;
```

Update object-store seams:

```ts
export type InboxObjectStore = {
  listKeys(input: {
    prefix: string;
    startAfter: string | null;
    signal: AbortSignal;
  }): Promise<string[]>;
  getObjectText(input: { key: string; signal: AbortSignal }): Promise<string>;
};

export type PollableInbox = {
  listNewObjects(sinceKey: string | null, signal: AbortSignal): Promise<string[]>;
  fetchNdjson(key: string, signal: AbortSignal): Promise<InboxBatch>;
};

export type UpstreamObjectStore = {
  putObjectText(input: {
    key: string;
    body: string;
    contentType: string;
    signal: AbortSignal;
  }): Promise<void>;
};

// This declaration shows the exact new method signature on the existing class.
// The implementation forwards the poll-owned signal into every upload deadline.
export declare class UpstreamSync {
  run(
    store: UpstreamObjectStore,
    signal: AbortSignal,
  ): Promise<UpstreamSyncReport>;
}
```

### Poll state and health

```ts
export type PollExecutionState = {
  state: 'idle' | 'running';
  pollId: string | null;
  startedAt: string | null;
  lastCompletedAt: string | null;
  consecutiveFailures: number;
  lastFailureAt: string | null;
  lastFailureCode: string | null;
  backlogCount: number | null;
};

export type PollDegradedReason =
  | 'POLL_EXCEEDED_TOTAL_DEADLINE'
  | 'NO_SUCCESS_WITHIN_TWO_CADENCES'
  | 'BACKLOG_PERSISTED_ACROSS_POLLS'
  | 'CREDENTIALS_WITHOUT_COMPLETED_POLL';

export type SourcingPollHealth = {
  status: 'healthy' | 'degraded';
  reasons: PollDegradedReason[];
  state: PollExecutionState;
  lastSuccessAgeMs: number | null;
};

export function evaluatePollHealth(input: {
  state: PollExecutionState;
  credentialState: SourcingCredentialState;
  consecutiveBackloggedPolls: number;
  nowMs: number;
  cadenceMs: number;
  totalDeadlineMs: number;
}): SourcingPollHealth;
```

`SourcingPoller` adds `retry(): Promise<void>`, `getExecutionState(): PollExecutionState`, and `getHealth(): SourcingPollHealth`. `SourcingStatus` adds `execution` and `health`. `AppHealth` adds `operationalStatus: 'ready' | 'degraded'` and `sourcing: SourcingPollHealth`.

```ts
export type SourcingStatusApi = {
  status(): Promise<SourcingStatus>;
  retry(): Promise<SourcingStatus>;
};
```

### Structured logs

```ts
export type SafeLogFields = Readonly<{
  component?: string;
  requestId?: string;
  pollId?: string;
  objectKey?: string;
  objectVersionId?: string | null;
  objectEtag?: string;
  objectChecksumSha256?: string;
  invalidLineNumbers?: readonly number[];
  invalidLineCount?: number;
  lineNumber?: number;
  durationMs?: number;
  count?: number;
  backlogCount?: number;
  unprocessedCount?: number;
  status?: string;
  errorClass?: string;
}>;

export interface SafeLogger {
  log(
    level: 'debug' | 'info' | 'warn' | 'error',
    eventCode: string,
    fields?: SafeLogFields,
  ): void;
}
```

Unknown keys and nested objects are omitted, not serialized. Error handling records only the sanitized error class. The canonical names above replace ad hoc snake-case fields at every Lambda call site. Suppression diagnostics may log collision-safe object identity, checksums, invalid line numbers, and counts, but never row bodies or contact HMACs.

### Schema 15 recovery metadata

```sql
CREATE TABLE backup_receipts (
  id TEXT PRIMARY KEY,
  backup_basename TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('daily','manual','pre_release')),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  created_at TEXT NOT NULL,
  verified_at TEXT NOT NULL
);

CREATE TABLE recovery_readiness (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  recovery_setup_completed_at TEXT,
  last_restore_drill_at TEXT,
  last_restore_backup_sha256 TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE identity_repair_events (
  id TEXT PRIMARY KEY,
  manifest_sha256 TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  canonical_person_id TEXT NOT NULL,
  created_person_ids_json TEXT NOT NULL,
  reassigned_source_event_ids_json TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  UNIQUE (manifest_sha256, candidate_id)
);
```

### Backup and recovery services

```ts
export type BackupKind = 'daily' | 'manual' | 'pre_release';

export type VerifiedBackup = {
  path: string;
  basename: string;
  kind: BackupKind;
  schemaVersion: number;
  sha256: string;
  sizeBytes: number;
  createdAt: string;
  verifiedAt: string;
};

export function createVerifiedEncryptedBackup(input: {
  database: AppDatabase;
  backupDirectory: string;
  key: WorkspaceKey;
  kind: BackupKind;
  schemaVersion: number;
  clock: Clock;
}): VerifiedBackup;

export type RecoveryReadinessStatus = {
  setupCompletedAt: string | null;
  lastRestoreDrillAt: string | null;
  outreachReady: boolean;
};

export type RecoverySetupSession = {
  sessionId: string;
  material: string;
  generatedAt: string;
};

export type RestoreDrillReceipt = {
  backupTimestamp: string;
  backupSha256: string;
  schemaVersion: number;
  verifiedAt: string;
  aggregateCounts: {
    people: number;
    prospects: number;
    sourceEvents: number;
  };
};

export type RecoveryProvider = {
  status(): Promise<RecoveryReadinessStatus>;
  beginSetup(input: { founderConfirmed: true }): Promise<RecoverySetupSession>;
  saveSetupMaterial(input: {
    sessionId: string;
  }): Promise<
    | { kind: 'saved'; backupBasename: string }
    | { kind: 'cancelled' }
  >;
  completeSetup(input: {
    sessionId: string;
    founderConfirmed: true;
  }): Promise<RecoveryReadinessStatus>;
  selectAndRunRestoreDrill(input: {
    founderConfirmed: true;
  }): Promise<
    | { kind: 'completed'; receipt: RestoreDrillReceipt }
    | { kind: 'cancelled' }
  >;
};
```

### Identity audit and repair manifests

```ts
export type IdentityAuditCandidate = {
  candidateId: string;
  normalizedDisplayName: string;
  currentPersonId: string;
  priorPeople: Array<{
    priorPersonId: string;
    displayName: string;
    postalCodes: string[];
    propertyAddresses: string[];
    cloudEntityIds: string[];
    sourceEventIds: string[];
  }>;
  conflictReasons: Array<
    | 'DIFFERENT_POSTAL_CODES'
    | 'DIFFERENT_PROPERTY_ADDRESSES'
    | 'DIFFERENT_CLOUD_ENTITY_IDS'
  >;
  contactOwnership: 'unknown';
};

export type IdentityMigrationManifest = {
  format: 'callie-identity-migration-audit';
  version: 1;
  beforeDatabaseSha256: string;
  currentDatabaseSha256: string;
  generatedAt: string;
  candidates: IdentityAuditCandidate[];
};

export type ReviewedIdentityMigrationManifest = Omit<IdentityMigrationManifest, 'format'> & {
  format: 'callie-identity-migration-review';
  auditManifestSha256: string;
  reviewedAt: string;
  approvedCandidateIds: string[];
  rejectedCandidateIds: string[];
};
```

Operational CLI signatures are fixed and accept no implicit founder-data paths:

```text
node scripts/runIdentityMigrationAudit.mjs --before-database <pre-schema-8.db> --current-database <current.db> --recovery-material-file <mode-0600.txt> --output <audit-manifest.json>
node scripts/finalizeIdentityMigrationReview.mjs --audit-manifest <audit-manifest.json> --decisions <candidate-decisions.json> --output <reviewed-manifest.json>
node scripts/runIdentityMigrationRepair.mjs --current-database <current.db> --reviewed-manifest <reviewed-manifest.json> --manifest-sha256 <64-hex> --recovery-material-file <mode-0600.txt> --mode <dry-run|apply>
```

Both CLIs that accept `--current-database` hard-code `EXPECTED_CURRENT_SCHEMA = 15`; there is no operator override flag. Before creating an output/temp copy or opening any write transaction, they verify `app_meta.schema_version = 15` and the Kysely migration ledger is the exact ordered history through `0015RecoveryMetadata`. They reject schema 14 and lower, schema 16 and higher, missing/extra migration rows, or a mismatched schema/ledger pair. The pre-schema-8 audit input is intentionally exempt from this current-database gate.

---

## Task 0: Temporary operational containment

**Files:** No repository changes.

- [ ] Through the existing validated health/sourcing APIs, record the current `lastPolledAt`, backlog, counters, and credential state without triggering Retry.
- [ ] Quit the current application so the existing wedged in-process poll promise releases the slot, and keep the app closed until Hold Point 0 installs the replacement app-inbox credential.
- [ ] Record current database size, newest verified backup timestamp, resolver log-stream count, EventBridge rule state, and deployed exact SHA.
- [ ] Do not delete local data, S3 objects, DynamoDB items, credentials, or Terraform state.

**Commit:** None.

---

### Hold Point 0: Immediate exposed-credential containment

Stop before Task 1. Obtain explicit founder confirmation for this operational sequence because it revokes credentials and may intentionally leave enrichment or inbox polling offline.

1. Keep `enricher`, suppression processing, and outreach schedules disabled and record their current rule states.
2. Create replacement Tracerfy and app-inbox AWS credentials using provider consoles. Enter values only through the currently supported protected runtime path, never repository files, Terraform variables, shell history, logs, or chat.
3. Validate one bounded non-outreach request per replacement and inspect only redacted identifiers and status. For the app-inbox credential, import it into the protected credential store, relaunch once, and run one bounded manual poll.
4. Revoke the known plaintext Tracerfy key and app-inbox AWS access key immediately after validation. If either replacement cannot be validated, revoke or deactivate the exposed credential anyway and keep that dependent feature offline.
5. Confirm whether backlog 2 drains under the replacement credential. If it does not, close the app again, keep schedules and outreach paused, and attach the read-only evidence to the rollout ticket.
6. Move any plaintext credential-bearing operational files into a mode-0700 private quarantine directory with mode-0600 files pending secure migration. Do not delete them until Hold Point 1 verifies the permanent managed location and an independent recovery path.
7. Record only credential identifiers/fingerprints, revocation timestamps, disabled feature states, and operator confirmation in a private external evidence file.

No compliance Task 1, runtime repository task, backup task, live poll, enrichment request, or schedule re-enable proceeds until this hold point is complete.

---

## Task 1: Bound S3 list, fetch, body, upload, and total-poll operations

**Files:**

- Create `src/main/runtime/abortDeadline.ts`
- Create `tests/main/runtime/abortDeadline.test.ts`
- Modify `src/main/sourcing/inboxClient.ts`
- Modify `tests/main/sourcing/inboxClient.test.ts`
- Modify `src/main/sourcing/upstreamSync.ts`
- Modify `tests/main/sourcing/upstreamSync.test.ts`
- Modify `src/main/sourcing/sourcingPoller.ts`
- Modify `tests/main/sourcing/sourcingPoller.test.ts`

- [ ] Write failing tests proving a never-resolving operation rejects with the exact timeout code, parent abort propagates, timers are cleared after success/failure, and late promise settlement cannot change the result.
- [ ] Run the deadline tests and confirm the module is missing.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/main/runtime/abortDeadline.test.ts
```

- [ ] Implement `runWithAbortDeadline` with one owned `AbortController`, parent-signal forwarding, deterministic cleanup, and `RemoteOperationTimeoutError`.
- [ ] Update S3 `send` calls to pass `{ abortSignal: signal }`; include `Body.transformToString()` inside the same 60-second fetch budget.
- [ ] Update filesystem fakes to check `signal.aborted` before and after reads so production and fixtures share cancellation behavior.
- [ ] Wrap upstream writes in the 60-second upload budget. A timeout must not mark outcome or suppression rows flushed.
- [ ] Give one complete poll an owned 14-minute controller and pass the exact `controller.signal` through list, fetch, and `UpstreamSync.run(store, signal)`. `run` forwards that parent signal into each 60-second membership, outcome, and suppression upload deadline, which in turn passes its child signal to `putObjectText`.
- [ ] Add failing-then-green integration cases for hung list, body, and upload. Assert signal identity reaches `UpstreamSync.run`, parent abort reaches each upload, processed-file ledgers and outboxes remain unchanged, and a later poll succeeds.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/main/runtime/abortDeadline.test.ts tests/main/sourcing/inboxClient.test.ts tests/main/sourcing/upstreamSync.test.ts tests/main/sourcing/sourcingPoller.test.ts
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run typecheck
```

- [ ] Commit.

```bash
git add src/main/runtime/abortDeadline.ts tests/main/runtime/abortDeadline.test.ts src/main/sourcing/inboxClient.ts tests/main/sourcing/inboxClient.test.ts src/main/sourcing/upstreamSync.ts tests/main/sourcing/upstreamSync.test.ts src/main/sourcing/sourcingPoller.ts tests/main/sourcing/sourcingPoller.test.ts
git commit -m "fix: bound sourcing remote operations"
```

---

## Task 2: Track poll identity, watchdog ownership, degraded health, and safe Retry

**Files:**

- Create `src/main/sourcing/pollExecutionState.ts`
- Create `tests/main/sourcing/pollExecutionState.test.ts`
- Modify `src/main/sourcing/sourcingPoller.ts`
- Modify `tests/main/sourcing/sourcingPoller.test.ts`
- Modify `src/shared/contracts/sourcingContract.ts`
- Modify `src/shared/healthContract.ts`
- Modify `tests/integration/healthContract.test.ts`
- Modify `src/main/health/healthService.ts`
- Modify `tests/main/healthService.test.ts`
- Modify `tests/main/registerHealthIpc.test.ts`
- Modify `src/main/sourcing/registerSourcingIpc.ts`
- Modify `tests/main/sourcing/registerSourcingIpc.test.ts`
- Modify `src/preload/apis/sourcingApi.ts`
- Modify `src/main/ipc/registerApplicationIpc.ts`
- Modify `tests/main/registerApplicationIpc.test.ts`
- Modify `tests/integration/preload.test.ts`
- Modify `src/main/startApplication.ts`
- Modify `tests/main/startApplication.test.ts`
- Modify `src/renderer/foundation/SourcingStatusRow.tsx`
- Modify `src/renderer/foundation/SettingsScreen.tsx`
- Modify `src/renderer/foundation/SettingsScreen.test.tsx`
- Modify `tests/e2e/sourcingInbox.spec.ts`

- [ ] Write table-driven evaluator tests for all four degraded reasons, the 30-minute freshness threshold, two consecutive nonzero-backlog successes, healthy recovery, and deterministic reason order.
- [ ] Run the state tests and confirm failure.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/main/sourcing/pollExecutionState.test.ts
```

- [ ] Implement the pure evaluator and strict Zod contract additions.
- [ ] Replace `activePoll: Promise<void>` with an owned record `{ pollId, startedAt, controller, promise }`; inject `PollIdGenerator` and a one-minute `WatchdogTimer`.
- [ ] Set `lastCompletedAt` only after list, all object processing, and upstream sync complete. Increment failures and set a stable failure code on any typed timeout/error.
- [ ] In `finally`, release the slot only when the settling poll ID still owns it.
- [ ] Implement `retry()`: coalesce onto a nonexpired running poll; abort and await an expired owned poll; start one new poll after settlement.
- [ ] Extend primary health with `operationalStatus` and sourcing health. Do not change the immutable domain startup report fields.
- [ ] Add a read-only status and explicit Retry IPC method. Renderer Retry calls no mutation other than starting the bounded poll.
- [ ] Render last-success age, backlog, running/idle state, stable reasons, and a safe Retry button in Settings. Refresh status at most once per minute and immediately after Retry settles; prevent overlapping refreshes and ignore post-unmount results.
- [ ] Add a fixture-only hung-operation E2E switch guarded by `CALLIE_SOURCING_FIXTURE_DIR`; prove health degrades and Retry recovers.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/main/sourcing/pollExecutionState.test.ts tests/main/sourcing/sourcingPoller.test.ts tests/main/sourcing/registerSourcingIpc.test.ts tests/integration/healthContract.test.ts tests/main/healthService.test.ts tests/main/registerHealthIpc.test.ts tests/main/registerApplicationIpc.test.ts tests/integration/preload.test.ts src/renderer/foundation/SettingsScreen.test.tsx tests/main/startApplication.test.ts
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run typecheck
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx playwright test --workers=1 tests/e2e/sourcingInbox.spec.ts
```

- [ ] Commit.

```bash
git add src/main/sourcing/pollExecutionState.ts tests/main/sourcing/pollExecutionState.test.ts src/main/sourcing/sourcingPoller.ts tests/main/sourcing/sourcingPoller.test.ts src/shared/contracts/sourcingContract.ts src/shared/healthContract.ts tests/integration/healthContract.test.ts src/main/health/healthService.ts tests/main/healthService.test.ts tests/main/registerHealthIpc.test.ts src/main/sourcing/registerSourcingIpc.ts tests/main/sourcing/registerSourcingIpc.test.ts src/preload/apis/sourcingApi.ts src/main/ipc/registerApplicationIpc.ts tests/main/registerApplicationIpc.test.ts tests/integration/preload.test.ts src/main/startApplication.ts tests/main/startApplication.test.ts src/renderer/foundation/SourcingStatusRow.tsx src/renderer/foundation/SettingsScreen.tsx src/renderer/foundation/SettingsScreen.test.tsx tests/e2e/sourcingInbox.spec.ts
git commit -m "feat: expose sourcing poll health and watchdog"
```

---

## Task 3: Retain only allowlisted PII-safe local logs

**Files:**

- Create `src/main/logging/safeLogger.ts`
- Create `src/main/logging/fileLogSink.ts`
- Create `tests/main/logging/safeLogger.test.ts`
- Create `tests/main/logging/fileLogSink.test.ts`
- Modify `src/main.ts`
- Modify `src/main/startApplication.ts`
- Modify `src/main/sourcing/sourcingPoller.ts`
- Modify `src/main/sourcing/sourcingCredentialStore.ts`
- Modify `src/main/domain/founderSalesDomain.ts`
- Modify `src/shared/contracts/shellContract.ts`
- Modify `src/preload/apis/shellApi.ts`
- Modify `src/main/ipc/registerShellIpc.ts`
- Modify `src/main/ipc/registerApplicationIpc.ts`
- Modify `tests/main/registerApplicationIpc.test.ts`
- Modify `tests/integration/preload.test.ts`
- Modify `src/renderer/foundation/SettingsScreen.tsx`
- Modify `src/renderer/foundation/SettingsScreen.test.tsx`

- [ ] Write failing logger tests with representative names, phones, emails, addresses, subjects, provider payloads, recovery strings, AWS keys, nested objects, and hostile error messages. Assert none appear in serialized output.
- [ ] Write failing file-sink tests for mode 0700 directory, mode 0600 daily NDJSON file, symlink rejection, parent-permission rejection, fsync, and 14-day retention.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/main/logging/safeLogger.test.ts tests/main/logging/fileLogSink.test.ts
```

- [ ] Implement allowlist serialization and daily retained sink under `<userData>/logs`.
- [ ] Replace free-form sourcing and credential messages with stable event codes and safe fields.
- [ ] Audit changed `FounderSalesDomain` logging paths; retain IDs only when they are non-contact operational IDs.
- [ ] Add main-owned `shell:reveal-log-directory`; the renderer sends no filesystem path.
- [ ] Add a Settings action that reveals the logs directory and explains the 14-day retention.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/main/logging/safeLogger.test.ts tests/main/logging/fileLogSink.test.ts src/renderer/foundation/SettingsScreen.test.tsx tests/main/registerApplicationIpc.test.ts tests/integration/preload.test.ts
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run typecheck
```

- [ ] Commit.

```bash
git add src/main/logging/safeLogger.ts src/main/logging/fileLogSink.ts tests/main/logging/safeLogger.test.ts tests/main/logging/fileLogSink.test.ts src/main.ts src/main/startApplication.ts src/main/sourcing/sourcingPoller.ts src/main/sourcing/sourcingCredentialStore.ts src/main/domain/founderSalesDomain.ts src/shared/contracts/shellContract.ts src/preload/apis/shellApi.ts src/main/ipc/registerShellIpc.ts src/main/ipc/registerApplicationIpc.ts tests/main/registerApplicationIpc.test.ts tests/integration/preload.test.ts src/renderer/foundation/SettingsScreen.tsx src/renderer/foundation/SettingsScreen.test.tsx
git commit -m "feat: retain allowlisted local operational logs"
```

---

## Task 4: Centralize PII-safe cloud logs

**Files:**

- Create `cloud/lambdas/shared/src/safeLog.ts`
- Create `cloud/lambdas/shared/test/safeLog.test.ts`
- Modify `cloud/lambdas/shared/src/index.ts`
- Modify every `cloud/lambdas/*/src/log.ts`
- Modify `cloud/lambdas/adapter-boston-assessments/test/handler.test.ts`
- Modify `cloud/lambdas/adapter-boston-rentsmart/test/handler.test.ts`
- Modify `cloud/lambdas/adapter-pvd-taxroll/test/handler.test.ts`
- Modify `cloud/lambdas/enricher/test/handler.test.ts`
- Modify `cloud/lambdas/mail-parse/test/handler.test.ts`
- Modify `cloud/lambdas/resolver/test/handler.test.ts`
- Modify `cloud/lambdas/scorer/test/handler.test.ts`
- Modify `cloud/lambdas/suppression-sync/test/handler.test.ts`

- [ ] Write failing shared tests proving unknown/nested fields are omitted, thrown errors expose only their class, event codes are required, and representative PII/secrets never serialize. Assert the allowlist preserves `objectKey`, `objectVersionId`, `objectEtag`, `objectChecksumSha256`, `invalidLineNumbers`, `invalidLineCount`, and `lineNumber` while still rejecting contact HMACs and row bodies.
- [ ] Run the shared tests and confirm failure.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; (cd cloud/lambdas/shared && npm test -- test/safeLog.test.ts)
```

- [ ] Implement the shared logger and make package-local `log.ts` files thin typed wrappers.
- [ ] Replace raw handler logging. Every scheduled handler emits `SCHEDULED_RUN_COMPLETED` with component, duration, counts, and unprocessed count only.
- [ ] Add handler tests that inject PII-bearing payloads and inspect captured serialized log output.
- [ ] Run all Lambda typechecks and tests. Do not ask the shared package to run a nonexistent build script.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; (cd cloud/lambdas/shared && npm run typecheck && npm test)
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; for package_dir in cloud/lambdas/adapter-boston-assessments cloud/lambdas/adapter-boston-rentsmart cloud/lambdas/adapter-pvd-taxroll cloud/lambdas/enricher cloud/lambdas/mail-parse cloud/lambdas/resolver cloud/lambdas/scorer cloud/lambdas/suppression-sync; do (cd "$package_dir" && npm run typecheck && npm test); done
```

- [ ] Commit.

```bash
git add cloud/lambdas/shared/src/safeLog.ts cloud/lambdas/shared/test/safeLog.test.ts cloud/lambdas/shared/src/index.ts cloud/lambdas/*/src/log.ts cloud/lambdas/adapter-boston-assessments/test/handler.test.ts cloud/lambdas/adapter-boston-rentsmart/test/handler.test.ts cloud/lambdas/adapter-pvd-taxroll/test/handler.test.ts cloud/lambdas/enricher/test/handler.test.ts cloud/lambdas/mail-parse/test/handler.test.ts cloud/lambdas/resolver/test/handler.test.ts cloud/lambdas/scorer/test/handler.test.ts cloud/lambdas/suppression-sync/test/handler.test.ts
git commit -m "fix: enforce PII-safe cloud logging"
```

---

## Task 5: Scheduled observability and monthly health watchdog

**Status:** Superseded. Do not execute the former Terraform-only instructions or any backend-disabled plan workflow.

Use the approved replacement documents:

- Design: `docs/superpowers/specs/2026-09-05-scheduled-observability-watchdog-design.md`
- Implementation plan: `docs/superpowers/plans/2026-09-05-scheduled-observability-watchdog.md`

The replacement keeps schedules and scheduled health notifications disabled by default, first makes completion status trustworthy, uses source-level Terraform verification only, and implements monthly health with a daily calendar-aware watchdog. Live state-aware planning remains deferred to the separately approved Runtime Task 9 hold point.

---

## Task 6: Add schema-15 operational recovery receipts

**Files:**

- Create `src/main/db/migrations/0015RecoveryMetadata.ts`
- Create `tests/main/db/migrations/0015RecoveryMetadata.test.ts`
- Create `src/main/domain/operations/operationalSafetyRepository.ts`
- Create `tests/main/operationalSafetyRepository.test.ts`
- Modify `src/main/db/migrate.ts`
- Modify `src/main/db/domainSchema.ts`
- Modify `tests/main/migrations.test.ts`

- [ ] Write the failing schema-14→15 migration test for all tables, constraints, singleton initialization, uniqueness, and preservation of compliance/jurisdiction data.
- [ ] Write failing repository tests for backup receipts, recovery readiness, restore drill updates, immutable repair-event uniqueness, and transaction rollback.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/main/db/migrations/0015RecoveryMetadata.test.ts tests/main/operationalSafetyRepository.test.ts
```

- [ ] Implement and register `0015RecoveryMetadata` after `0014OutboundJurisdictionClearance`.
- [ ] Implement repository methods `recordBackup`, `listBackups`, `recordRecoverySetupCompleted`, `recordRestoreDrill`, `getRecoveryReadiness`, and `appendIdentityRepairEvent`.
- [ ] Run focused and aggregate migration tests.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/main/db/migrations/0015RecoveryMetadata.test.ts tests/main/operationalSafetyRepository.test.ts tests/main/migrations.test.ts tests/integration/migrationBackup.test.ts
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run typecheck
```

- [ ] Commit.

```bash
git add src/main/db/migrations/0015RecoveryMetadata.ts tests/main/db/migrations/0015RecoveryMetadata.test.ts src/main/domain/operations/operationalSafetyRepository.ts tests/main/operationalSafetyRepository.test.ts src/main/db/migrate.ts src/main/db/domainSchema.ts tests/main/migrations.test.ts
git commit -m "feat: add operational recovery audit schema"
```

---

## Task 7: Create immutable periodic verified encrypted backups

**Files:**

- Create `src/main/backup/verifiedBackup.ts`
- Create `src/main/backup/backupRetention.ts`
- Create `src/main/backup/backupService.ts`
- Create `tests/main/backup/backupRetention.test.ts`
- Create `tests/integration/verifiedBackup.test.ts`
- Create `tests/integration/backupService.test.ts`
- Modify `src/main/db/migrationBackup.ts`
- Modify `src/main/foundation/foundationRuntime.ts`
- Modify `src/main/startApplication.ts`
- Modify `tests/main/startApplication.test.ts`

- [ ] Extract shared verified-copy primitives while keeping `createVerifiedMigrationBackup` source-compatible.
- [ ] Write failing tests for daily/manual/pre-release names, O_EXCL immutability, mode checks, encrypted header, SQLCipher open, integrity/schema/hash verification, directory fsync, and WAL restoration on success/failure.
- [ ] Write failing retention tests: keep newest 14 daily plus one newest representative for each of the latest 8 ISO weeks; never select migration backups for deletion.
- [ ] Write failing service tests for startup and hourly due checks, no duplicate inside 24 hours, receipt recorded only after verification, and incomplete-copy cleanup only.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/main/backup/backupRetention.test.ts tests/integration/verifiedBackup.test.ts tests/integration/backupService.test.ts tests/integration/migrationBackup.test.ts
```

- [ ] Add narrow `FoundationRuntime.withDatabase<TResult>(operation)` access so backup code never exposes the database to the renderer.
- [ ] Reload the workspace key for each backup and zero its bytes in `finally`.
- [ ] Wire daily checks at startup and hourly while the app is open. Add an explicit pre-release backup call for the release workflow.
- [ ] Verify failure preserves the live database/WAL and removes only the incomplete destination.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/main/backup/backupRetention.test.ts tests/integration/verifiedBackup.test.ts tests/integration/backupService.test.ts tests/integration/migrationBackup.test.ts tests/main/startApplication.test.ts
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run typecheck
```

- [ ] Commit.

```bash
git add src/main/backup/verifiedBackup.ts src/main/backup/backupRetention.ts src/main/backup/backupService.ts tests/main/backup/backupRetention.test.ts tests/integration/verifiedBackup.test.ts tests/integration/backupService.test.ts src/main/db/migrationBackup.ts src/main/foundation/foundationRuntime.ts src/main/startApplication.ts tests/main/startApplication.test.ts
git commit -m "feat: add periodic verified encrypted backups"
```

---

## Task 8: Add one-time recovery export and a temporary-copy restore drill

**Files:**

- Create `src/shared/contracts/recoveryContract.ts`
- Create `src/main/recovery/recoveryService.ts`
- Create `src/main/recovery/restoreDrill.ts`
- Create `src/main/recovery/registerRecoveryIpc.ts`
- Create `src/preload/apis/recoveryApi.ts`
- Create `tests/main/recoveryService.test.ts`
- Create `tests/integration/restoreDrill.test.ts`
- Modify `src/preload/createCallieApi.ts`
- Modify `src/main/ipc/registerApplicationIpc.ts`
- Modify `src/main/startApplication.ts`
- Modify `src/renderer/app/routeRegistry.tsx`
- Modify `src/renderer/foundation/SettingsScreen.tsx`
- Modify `src/renderer/foundation/SettingsScreen.test.tsx`
- Modify `tests/integration/preload.test.ts`
- Modify `tests/e2e/foundation.spec.ts`

- [ ] Write strict contract and service tests: `founderConfirmed` must be literal true, setup sessions expire after 10 minutes, material is returned once, completion records no plaintext, and saving uses a main-owned file dialog plus mode 0600.
- [ ] Write restore tests: select a verified backup through a main-owned dialog, copy to mode-0700 temp, parse recovery material, open with SQLCipher, run integrity/schema/count checks, close, remove temp, zero key bytes, and record the receipt.
- [ ] Assert cancellation is non-destructive and no renderer request accepts an arbitrary filesystem path.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/main/recoveryService.test.ts tests/integration/restoreDrill.test.ts tests/main/recoveryKey.test.ts tests/integration/foundationRecovery.test.ts
```

- [ ] Implement the exact `RecoveryProvider` methods above. Validate every input through strict Zod schemas, keep file selection in the main process, and compose `context.api.recovery` into Settings through `routeRegistry.tsx`.
- [ ] Display recovery material once with Copy and Save controls. Never persist or log it automatically.
- [ ] Display backup freshness, setup completion, last drill, and `outreachReady = setup complete && drill complete` in Data & storage.
- [ ] Add packaged E2E using a disposable workspace and a temporary save destination.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/main/recoveryService.test.ts tests/integration/restoreDrill.test.ts src/renderer/foundation/SettingsScreen.test.tsx tests/integration/preload.test.ts
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run typecheck
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx playwright test --workers=1 tests/e2e/foundation.spec.ts
```

- [ ] Commit.

```bash
git add src/shared/contracts/recoveryContract.ts src/main/recovery/recoveryService.ts src/main/recovery/restoreDrill.ts src/main/recovery/registerRecoveryIpc.ts src/preload/apis/recoveryApi.ts tests/main/recoveryService.test.ts tests/integration/restoreDrill.test.ts src/preload/createCallieApi.ts src/main/ipc/registerApplicationIpc.ts src/main/startApplication.ts src/renderer/app/routeRegistry.tsx src/renderer/foundation/SettingsScreen.tsx src/renderer/foundation/SettingsScreen.test.tsx tests/integration/preload.test.ts tests/e2e/foundation.spec.ts
git commit -m "feat: add recovery export and restore drill"
```

---

## Task 9: Prepare managed secret lookup and remote Terraform state

**Files:**

- Create `cloud/lambdas/shared/src/secureParameter.ts`
- Create `cloud/lambdas/shared/test/secureParameter.test.ts`
- Modify `cloud/lambdas/shared/src/index.ts`
- Modify `cloud/lambdas/shared/package.json`
- Modify `cloud/lambdas/shared/package-lock.json`
- Modify `cloud/lambdas/enricher/src/handler.ts`
- Modify `cloud/lambdas/enricher/test/handler.test.ts`
- Modify `cloud/lambdas/enricher/package.json`
- Modify `cloud/lambdas/enricher/package-lock.json`
- Modify `cloud/lambdas/mail-parse/src/handler.ts`
- Modify `cloud/lambdas/mail-parse/test/handler.test.ts`
- Modify `cloud/lambdas/mail-parse/package.json`
- Modify `cloud/lambdas/mail-parse/package-lock.json`
- Create `cloud/terraform/secrets.tf`
- Create `cloud/terraform/backend.hcl.example`
- Create `cloud/terraform/terraform.tfvars.example`
- Create `cloud/scripts/bootstrap-terraform-state.sh`
- Modify `cloud/terraform/variables.tf`
- Modify `cloud/terraform/iam.tf`
- Modify `cloud/terraform/lambda.tf`
- Modify `cloud/terraform/adapters.tf`
- Modify `cloud/terraform/versions.tf`
- Modify `cloud/.gitignore`
- Modify `cloud/README.md`
- Modify `tests/infrastructure/terraformHardening.test.ts`

```ts
export async function loadSecureParameter(input: {
  client: Pick<SSMClient, 'send'>;
  parameterName: string;
  required: boolean;
}): Promise<string | null>;
```

- [ ] Write failing tests for required/optional parameters, decryption request, missing/empty values, sanitized errors, and no value caching beyond one invocation.
- [ ] Write failing Terraform tests requiring identifier-only Lambda variables `TRACERFY_API_KEY_PARAM`, `NTFY_TOPIC_PARAM`, and existing `HMAC_SALT_PARAM`; reject secret-valued Terraform variables/environment entries.
- [ ] Assert SSM/KMS IAM resources are restricted to exact parameter ARNs and the expected key.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; (cd cloud/lambdas/shared && npm test -- test/secureParameter.test.ts)
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/infrastructure/terraformHardening.test.ts
```

- [ ] Implement encrypted parameter lookup and update enricher/mail-parse to fetch by identifier at invocation time.
- [ ] Add a partial `backend "s3" {}` block and public example backend configuration. The bootstrap script creates encrypted/versioned/private state storage and locking, but refuses to overwrite existing resources.
- [ ] Do not create secret-valued `aws_ssm_parameter` resources and do not put replacement values in examples.
- [ ] Format, validate, and create a refresh-free plan. Do not apply, rotate, or migrate state in this task.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; (cd cloud/lambdas/shared && npm run typecheck && npm test)
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; (cd cloud/lambdas/enricher && npm run typecheck && npm test && npm run build)
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; (cd cloud/lambdas/mail-parse && npm run typecheck && npm test && npm run build)
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; (cd cloud/terraform && tofu init -backend=false -reconfigure && tofu fmt -check -recursive && tofu validate && tofu plan -refresh=false -var='schedules_enabled=false' -out="$JCODE_SCRATCH_DIR/managed-secrets.tfplan")
```

- [ ] Commit.

```bash
git add cloud/lambdas/shared/src/secureParameter.ts cloud/lambdas/shared/test/secureParameter.test.ts cloud/lambdas/shared/src/index.ts cloud/lambdas/shared/package.json cloud/lambdas/shared/package-lock.json cloud/lambdas/enricher/src/handler.ts cloud/lambdas/enricher/test/handler.test.ts cloud/lambdas/enricher/package.json cloud/lambdas/enricher/package-lock.json cloud/lambdas/mail-parse/src/handler.ts cloud/lambdas/mail-parse/test/handler.test.ts cloud/lambdas/mail-parse/package.json cloud/lambdas/mail-parse/package-lock.json cloud/terraform/secrets.tf cloud/terraform/backend.hcl.example cloud/terraform/terraform.tfvars.example cloud/scripts/bootstrap-terraform-state.sh cloud/terraform/variables.tf cloud/terraform/iam.tf cloud/terraform/lambda.tf cloud/terraform/adapters.tf cloud/terraform/versions.tf cloud/.gitignore cloud/README.md tests/infrastructure/terraformHardening.test.ts
git commit -m "feat: prepare managed cloud secrets and remote state"
```

### Hold Point 1: Permanent managed-secret and state migration

Stop. Obtain explicit founder confirmation for this operational sequence.

1. Confirm the exposed credentials from Hold Point 0 remain revoked and their dependent schedules remain paused.
2. Enter the already validated replacement provider value directly into encrypted SSM through an approved interactive operator path. Do not place it in shell history, repository files, Terraform variables, logs, or chat.
3. Apply reviewed IAM/environment changes with `schedules_enabled=false`; invoke one bounded request and inspect only redacted logs.
4. Verify the revoked provider credential cannot authenticate and is not referenced by Lambda configuration.
5. Import the already validated replacement app-inbox AWS credential into the verified protected local envelope, test bounded list/fetch/upload, observe a successful manual poll, verify the old key remains inactive, then securely remove the quarantined plaintext import only after a second protected copy is validated.
6. Bootstrap the encrypted/versioned/private state bucket and lock table. Review resource names and policies.
7. Obtain a second explicit confirmation before `tofu init -migrate-state`.
8. Compare state serial and resource count before/after, verify remote locking, archive the old local state privately, then remove plaintext local state only after rollback evidence is retained.
9. Re-enable schedules only after health, logs, and alarms are verified.

No repository commit is associated with this hold point.

---

## Task 10: Build a read-only schema-8 identity migration audit

**Files:**

- Create `src/main/db/readOnlyEncryptedDatabase.ts`
- Create `src/main/identityMigration/identityMigrationAudit.ts`
- Create `src/main/identityMigration/identityMigrationManifest.ts`
- Create `scripts/runIdentityMigrationAudit.mjs`
- Create `scripts/finalizeIdentityMigrationReview.mjs`
- Create `scripts/buildOperationalTools.mjs`
- Create `tests/main/identityMigration/identityMigrationAudit.test.ts`
- Create `tests/main/identityMigration/identityMigrationManifest.test.ts`
- Modify `package.json`
- Modify `package-lock.json`

- [ ] Write fixture tests with a pre-schema-8 database and schema-15 current database: same normalized name plus different postal codes, addresses, or cloud IDs must surface; genuine duplicates must not.
- [ ] Assert contact ownership is always `unknown`, candidate order and IDs are deterministic, and both input SHA-256 hashes remain byte-identical before/after.
- [ ] Write CLI security tests for the exact audit and finalization signatures above: reject symlinks/nonregular inputs, require mode-0600 inputs under private parents, hard-reject schema-14 and schema-16 current databases before creating output/temp files, require the exact schema-15 migration ledger, use private temp copies, emit mode-0600 manifests, log only count/hash/path, remove temp files, zero key bytes, and preserve both database hashes on every rejection.
- [ ] Write reviewed-manifest tests requiring one explicit decision per audit candidate, disjoint approved/rejected IDs, no unknown IDs, the exact audit manifest SHA-256, a canonical `reviewedAt`, deterministic output ordering, and byte-stable hashing.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/main/identityMigration/identityMigrationAudit.test.ts tests/main/identityMigration/identityMigrationManifest.test.ts
```

- [ ] Implement read-only encrypted opens plus both exact manifest interfaces above. The audit CLI calls the non-overridable schema-15 guard on `--current-database` before candidate analysis or output creation.
- [ ] Build the audit and review-finalization CLIs without bundling Electron UI or write-capable domain services. The finalizer consumes only the immutable audit manifest and a strict decisions file whose rows are `{ candidateId, decision: 'approved' | 'rejected' }`.
- [ ] Run against fixtures only during implementation.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/main/identityMigration/identityMigrationAudit.test.ts tests/main/identityMigration/identityMigrationManifest.test.ts tests/integration/migrationBackup.test.ts
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run build:operational-tools
```

- [ ] Commit.

```bash
git add src/main/db/readOnlyEncryptedDatabase.ts src/main/identityMigration/identityMigrationAudit.ts src/main/identityMigration/identityMigrationManifest.ts scripts/runIdentityMigrationAudit.mjs scripts/finalizeIdentityMigrationReview.mjs scripts/buildOperationalTools.mjs tests/main/identityMigration/identityMigrationAudit.test.ts tests/main/identityMigration/identityMigrationManifest.test.ts package.json package-lock.json
git commit -m "feat: add read-only identity migration audit"
```

### Hold Point 2: Founder review of the identity audit

Stop after generating the live read-only audit manifest outside the repository.

- A human reviews every candidate using retained source evidence and writes the strict decision rows consumed by `finalizeIdentityMigrationReview.mjs`.
- Run the review finalizer to produce `ReviewedIdentityMigrationManifest`, then independently verify `auditManifestSha256`, the complete disjoint decision partition, and the reviewed-manifest SHA-256 before any repair planning.
- The reviewed manifest, not the pre-review audit manifest, is the artifact approved at this hold point.
- Matching names alone never authorize a split or reassignment.
- Outreach remains blocked for candidates under review.
- No repair command runs at this hold point.

---

## Task 11: Build deterministic identity repair code against fixtures only

**Files:**

- Create `src/main/identityMigration/identityRepair.ts`
- Create `src/main/identityMigration/identityRepairValidation.ts`
- Create `scripts/runIdentityMigrationRepair.mjs`
- Create `tests/main/identityMigration/identityRepair.test.ts`
- Modify `scripts/buildOperationalTools.mjs`
- Modify `src/main/domain/operations/operationalSafetyRepository.ts`
- Modify `package.json`
- Modify `package-lock.json`

- [ ] Consume `ReviewedIdentityMigrationManifest` unchanged; require complete, disjoint decisions, exact `auditManifestSha256`, and the operator-supplied reviewed-manifest SHA-256 before dry-run or apply.
- [ ] Write failing tests for mismatched database hashes, missing review decisions, absent current pre-release backup, repeat application, ambiguous contacts, transaction rollback, and schema-14/schema-16 current databases. Schema rejection happens before dry-run output or a write transaction and leaves the database byte-identical.
- [ ] Test deterministic IDs from manifest hash plus candidate ID, evidence-only person/prospect reconstruction, deterministic property/source reassignment, immutable `identity_repair_events`, and no copied phone/email ownership.
- [ ] Require repaired prospects to remain `merge_review` with `unresolved_duplicate` until separately reviewed.
- [ ] Run `foreign_key_check`, integrity, and domain startup audit before commit; roll back everything on any failure.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/main/identityMigration/identityRepair.test.ts tests/main/operationalSafetyRepository.test.ts
```

- [ ] Implement and test only against disposable schema-15 fixture databases. The repair CLI calls the same non-overridable schema-15 guard before validating the manifest or opening a write transaction. Exercise the exact CLI with `--mode dry-run` in fixtures; do not run either mode against founder data.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/main/identityMigration/identityRepair.test.ts tests/main/identityMigration/identityMigrationAudit.test.ts tests/main/operationalSafetyRepository.test.ts
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run build:operational-tools
```

- [ ] Commit.

```bash
git add src/main/identityMigration/identityRepair.ts src/main/identityMigration/identityRepairValidation.ts scripts/runIdentityMigrationRepair.mjs tests/main/identityMigration/identityRepair.test.ts scripts/buildOperationalTools.mjs src/main/domain/operations/operationalSafetyRepository.ts package.json package-lock.json
git commit -m "feat: add confirmed identity repair engine"
```

### Hold Point 3: Live identity repair

Stop. Obtain a separate founder confirmation after the exact reviewed manifest is available.

1. Quit the app.
2. Verify current database, pre-schema-8 database, and manifest hashes.
3. Create and open a fresh pre-release backup with recovery material.
4. Run repair validation/dry-run and review the exact candidate count and planned IDs.
5. Apply only the reviewed manifest.
6. Reopen the app, inspect startup health, rerun the read-only audit, and inspect every repaired graph.
7. Confirm ambiguous contacts remain unknown and blocked.
8. Retain the repair receipt and pre-repair backup.

No repository commit is associated with this hold point.

---

## Task 12: Enforce tracked-source lint, secret scans, CI, and exact-SHA packages

**Files:**

- Create `scripts/lintTracked.mjs`
- Create `scripts/verifyLambdas.mjs`
- Create `scripts/verifySecrets.mjs`
- Create `scripts/writeReleaseMarker.mjs`
- Create `scripts/createPreReleaseBackup.mjs`
- Create `test/lintTracked.test.mjs`
- Create `test/verifyLambdas.test.mjs`
- Create `test/verifySecrets.test.mjs`
- Create `test/releaseMarker.test.mjs`
- Create `test/createPreReleaseBackup.test.mjs`
- Create `.gitleaks.toml`
- Create `.github/workflows/ci.yml`
- Create `.github/workflows/release.yml`
- Modify `scripts/verifyPackage.mjs`
- Modify `scripts/buildOperationalTools.mjs`
- Modify `test/verifyPackage.test.mjs`
- Modify `test/releaseDocumentation.test.mjs`
- Modify `forge.config.ts`
- Modify `package.json`
- Modify `package-lock.json`
- Modify `README.md`
- Modify `cloud/README.md`

- [ ] Write failing script tests. `lintTracked` must derive files from `git ls-files -z` and exclude generated Lambda `dist`, `.vite`, `out`, generated build artifacts, and dependencies while still linting tracked source/configuration.
- [ ] Require `verifyLambdas` to run typecheck/test/build for every Lambda package and typecheck/test only for shared.
- [ ] Require `verifySecrets` to run redacted git-history and directory scans, excluding generated dependencies but not tracked history.
- [ ] Require `writeReleaseMarker` to emit format/version, the exact 40-character commit SHA, and build timestamp; require package verification to compare the embedded marker with `git rev-parse HEAD` and reject a dirty checkout.
- [ ] Require `createPreReleaseBackup` to resolve the founder workspace through main-owned application paths, refuse arbitrary database paths and a running-app lock, invoke the verified backup service with `kind: 'pre_release'`, and print only the non-secret receipt. Tests use disposable fixtures only.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run test/lintTracked.test.mjs test/verifyLambdas.test.mjs test/verifySecrets.test.mjs test/releaseMarker.test.mjs test/createPreReleaseBackup.test.mjs test/verifyPackage.test.mjs test/releaseDocumentation.test.mjs
```

- [ ] Implement scripts and package commands `lint:tracked`, `verify:lambdas`, `verify:secrets`, `release:marker`, `backup:pre-release`, and aggregate `verify:release`.
- [ ] Add pull-request/protected-main CI with full history and Node 24.20.0. Use a trusted macOS ARM64 release runner for native packaging.
- [ ] The local operator checklist runs `backup:pre-release` before submitting a release SHA. CI never opens or copies the founder database. The release workflow verifies tag SHA equals `GITHUB_SHA`, is reachable from protected main, writes the package marker, packages, and verifies the exact marker.
- [ ] Until branch reconciliation completes, allow release only for an explicitly audited workflow-input SHA and record it in the workflow summary.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run typecheck
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run lint:tracked
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm test
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run verify:lambdas
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run verify:secrets
```

- [ ] Commit.

```bash
git add scripts/lintTracked.mjs scripts/verifyLambdas.mjs scripts/verifySecrets.mjs scripts/writeReleaseMarker.mjs scripts/createPreReleaseBackup.mjs scripts/buildOperationalTools.mjs test/lintTracked.test.mjs test/verifyLambdas.test.mjs test/verifySecrets.test.mjs test/releaseMarker.test.mjs test/createPreReleaseBackup.test.mjs test/verifyPackage.test.mjs test/releaseDocumentation.test.mjs .gitleaks.toml .github/workflows/ci.yml .github/workflows/release.yml scripts/verifyPackage.mjs forge.config.ts package.json package-lock.json README.md cloud/README.md
git commit -m "ci: enforce exact-sha security release gate"
```

---

## Task 13: Full verification and controlled rollout

**Files:** No new implementation files unless a failing acceptance check requires a scoped fix and test.

- [ ] Confirm outbound-compliance Task 10 completed after runtime Task 12, with exact suppression reconciliation and packaged final-gate acceptance, before starting this final runtime rollout.
- [ ] Run tracked typecheck, lint, tests, Lambda gates, and secret scans on a clean checkout.
- [ ] Do not hand the founder workspace to the lead-review plan or register schema 16 until every applicable hold point is resolved, schema-15 operational tools have completed against schema 15, and this Task 13 verification is signed off. If Hold Point 3 is not applicable, record the reviewed manifest disposition that makes repair unnecessary.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run typecheck
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run lint:tracked
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm test
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run verify:lambdas
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run verify:secrets
```

- [ ] Run packaged runtime verification after completing the reversible code tasks and any separately confirmed operational hold points.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run backup:pre-release
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run verify:package
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run test:e2e
```

- [ ] Force a fixture-only hung list/body/upload and verify timeout, typed failure, degraded health by 30 minutes, slot release, and successful Retry.
- [ ] Verify backlog and last-success age in both Settings and primary health.
- [ ] After reviewed Terraform apply, verify the next resolver invocation creates a log stream and all scheduled alarms route to the confirmed SNS target.
- [ ] Create a current daily or manual backup, export recovery material once, run a restore drill against a temporary copy, and verify live database/WAL hashes and health remain stable.
- [ ] Verify replacement secret values are absent from local Terraform plaintext, Lambda environment values, logs, repository history, and package contents.
- [ ] Run the identity audit read-only, review the manifest, and execute repair only if Hold Point 3 receives separate confirmation.
- [ ] Verify the packaged release marker equals the exact audited SHA and that SHA is reachable from protected main.
- [ ] Keep prospect outreach paused until compliance final-gate acceptance, suppression reconciliation, current backup restore drill, healthy polling, and release verification all pass.

**Final evidence:** Store non-secret counts, hashes, timestamps, command results, alarm state, package SHA, and restore receipt in a private dated rollout directory. Never store recovery material, credentials, raw contacts, or provider payloads.

**Commit:** Only if an acceptance check required a tested scoped fix. Otherwise none.

---

## Acceptance Traceability

| Approved requirement | Primary tasks and evidence |
|---|---|
| Hung S3 work times out and next poll runs | Tasks 1, 2, 13 timeout and Retry tests |
| Stale poll degrades before five hours | Task 2 30-minute evaluator and packaged check |
| Backlog and last-success age visible | Task 2 contracts, Settings, health tests |
| Resolver logs appear | Tasks 4, 5, 13 IAM and live stream check |
| Current encrypted backup opens with recovery material | Tasks 6, 7, 8, 13 verified copy and drill receipt |
| Backup failure cannot damage live WAL/database | Task 7 fault-injection and hash checks |
| Replacement secrets absent from plaintext Terraform and Lambda env | Task 9 static tests and Hold Point 1 |
| Sensitive values redacted from logs | Tasks 3, 4, 12 secret/log tests |
| Same-name identity conflicts surfaced without mutation | Task 10 hash-preserving read-only audit |
| Identity repair is reviewed and deterministic | Task 11 plus Hold Points 2 and 3 |
| Full Node 24 gate passes on exact release SHA | Tasks 12 and 13 CI/package marker evidence |

## Plan Self-Review Result

- Hold Point 0 revokes or deactivates already exposed credentials before Task 1 or any backup work; permanent SSM/state migration remains separately confirmed later.
- The canonical safe-log allowlist retains collision-safe suppression version/checksum/invalid-line diagnostics without admitting row bodies or contact HMACs.
- Both Terraform plan commands initialize once in a subshell and force `schedules_enabled=false`.
- Recovery provider methods and identity audit/review/repair CLIs have exact signatures; the reviewed manifest schema and hash check exist before founder approval.
- Runtime Task 13 must finish on schema 15 before the lead-review plan may register schema 16.
- Migration ownership is consistent across the three plans: compliance 0013 and 0014, runtime/recovery 0015, lead review 0016.
- Every `npm` or `npx` command starts with the required Node 24 PATH export.
- Reversible implementation tasks are separated from credential rotation, state migration, and live repair hold points.
- Backup and audit outputs are private and external by default.
- Each explicit verification requirement maps to a concrete test or operational check.
