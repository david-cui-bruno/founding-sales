# Encrypted Domain Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Callie's encrypted local persistence and deterministic founder-sales domain foundation through schema 0002, including immutable provenance, database-enforced cycle/action invariants, fixed cadences, two-axis prioritization, permanent opt-out, and the Today read model.

**Architecture:** Keep SQLite access in the Electron main process behind the existing synchronous repository pattern. A Keychain-backed workspace-key envelope unlocks one encrypted SQLite file; immutable event tables preserve evidence while mutable projections make Today and Friday-style queries fast. Domain services own `BEGIN IMMEDIATE` transactions, repositories only parse/persist rows, and pure planners calculate cadence, prioritization, and queue decisions before services commit them.

**Tech Stack:** Electron 44, macOS arm64, Node 24, TypeScript 5.9, SQLCipher-compatible synchronous SQLite binding selected by Gate 0, better-sqlite-style API, Kysely 0.29 migrations, Zod 4 validation, Vitest 2, Playwright packaged E2E.

**Spec:** `docs/superpowers/specs/2026-08-30-founder-sales-system-v1-design.md`

## Global Constraints

- Work from an isolated git worktree created with `superpowers:using-git-worktrees`; preserve unrelated user changes.
- Run all dependency installation, native rebuild, verification, and packaging under Node 24. The repository's `engine-strict=true` intentionally rejects Node 25.
- Target Electron `44.0.0`, Apple silicon, and macOS 26.4 or newer; Gate 0 must pass before Task 2 begins.
- Use `apply_patch` for hand-authored file changes. Formatting and generated lockfile changes may use their normal commands.
- Use TDD for every behavior: write the named failing test, run it and inspect the expected failure, add the minimum implementation, rerun, then refactor only while green.
- Keep encryption keys out of SQLite, renderer state, logs, diagnostics, backups, test snapshots, errors, and command-line arguments.
- The database must never open or query schema pages before applying the cipher profile and key.
- There is exactly one canonical Prospect per Person and at most one operationally open SalesCycle per Person.
- `SalesCycle.current_next_action_id` is the sole definition of the primary action. Every `active` or `onboarding` cycle references exactly one incomplete action; every `closed` cycle references none.
- Activity, ActivityAmendment, StageEvent, SourceEvent, TriggerEvent, and consent/audit evidence rows are immutable.
- Opt-out is person-wide, indefinite, render-time filtered, and transactionally checked before outbound work. Won remains Won if opt-out occurs during onboarding.
- Fit and Timing remain separate. No schema column, type, function, JSON key, UI field, or ordering tuple may introduce a 0-100 score, weighted sum, blended rank, or hidden equivalent.
- Cadence day labels are offsets from a fixed enrollment/stage anchor, never cumulative offsets from the preceding completion.
- All stored timestamps use canonical UTC ISO strings; calendar windows use the workspace IANA timezone, default `America/New_York`.
- Each task ends with its focused tests, `npm run typecheck`, `npm run lint`, and a commit. Tasks changing packaged native behavior also run packaged E2E and package verification.

---

### Task 1: Gate 0 — Prove and Select the Encrypted Synchronous Driver

**Files:**
- Create: `scripts/probeEncryptedSqlite.cjs`
- Create: `docs/superpowers/research/2026-08-30-encrypted-sqlite-driver-decision.md`
- Create: `src/main/db/sqliteDriverDecision.ts`
- Test: `tests/main/encryptedSqliteCompatibility.test.ts`
- Reference only: `package.json`
- Reference only: `vite.main.config.ts`
- Reference only: `forge.config.ts`

**Interfaces:**
- Consumes: Electron `44.0.0`, Kysely `SqliteDialect`, FTS5, WAL, and the better-sqlite synchronous connection surface used by `src/main/db/database.ts`.
- Produces: a PASS/FAIL decision naming one exact package version and cipher profile. Every later task consumes only a PASS decision.

- [ ] **Step 1: Establish the supported runtime before probing**

Run:

```bash
node --version
npm --version
node -p "process.platform + ' ' + process.arch"
```

Expected: Node reports `v24.x`, platform reports `darwin arm64`, and npm exits 0. If Node is not 24, switch runtimes before continuing.

- [ ] **Step 2: Install the synchronous candidate without changing the manifest or lockfile**

Run:

```bash
npm install --no-save --package-lock=false better-sqlite3-multiple-ciphers@12.11.1
npx electron-rebuild -f -w better-sqlite3-multiple-ciphers
```

Expected: source build/rebuild exits 0 for Electron 44 arm64. This candidate is compared against stock `better-sqlite3@13.0.3` (synchronous but no encryption) and `@journeyapps/sqlcipher@6.0.0` (encrypted but asynchronous and not compatible with Kysely's built-in synchronous dialect).

- [ ] **Step 3: Write the failing compatibility test**

Create `tests/main/encryptedSqliteCompatibility.test.ts` with this contract:

```ts
import { describe, expect, it } from 'vitest';

import { encryptedDriverDecision } from '../../src/main/db/sqliteDriverDecision';

describe('encrypted SQLite driver decision', () => {
  it('exposes the exact Gate 0 package and cipher profile', () => {
    expect(encryptedDriverDecision).toEqual({
      packageName: 'better-sqlite3-multiple-ciphers',
      packageVersion: '12.11.1',
      cipher: 'sqlcipher',
      compatibility: 4,
      synchronous: true,
    });
  });
});
```

- [ ] **Step 4: Run the RED test**

Run:

```bash
npx vitest run tests/main/encryptedSqliteCompatibility.test.ts
```

Expected: FAIL because `src/main/db/sqliteDriverDecision.ts` does not exist.

- [ ] **Step 5: Create the Electron probe**

Create `scripts/probeEncryptedSqlite.cjs` as an Electron main-process program that:

```js
const { app } = require('electron');
const { readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const Database = require('better-sqlite3-multiple-ciphers');
const { Kysely, SqliteDialect, sql } = require('kysely');

const applyProfile = (database, keyHex) => {
  database.pragma("cipher='sqlcipher'");
  database.pragma('legacy=4');
  database.pragma(`key="x'${keyHex}'"`);
};

app.whenReady().then(async () => {
  const path = join(app.getPath('temp'), `callie-cipher-probe-${process.pid}.sqlite3`);
  const key = Buffer.alloc(32, 0x4a).toString('hex');
  const wrongKey = Buffer.alloc(32, 0x7b).toString('hex');
  rmSync(path, { force: true });

  const database = new Database(path);
  applyProfile(database, key);
  database.pragma('journal_mode=WAL');
  database.exec('CREATE TABLE probe (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  database.exec('CREATE VIRTUAL TABLE probe_fts USING fts5(content)');
  const kysely = new Kysely({ dialect: new SqliteDialect({ database }) });
  await sql`INSERT INTO probe (id, value) VALUES ('one', 'encrypted')`.execute(kysely);
  const result = await sql`SELECT value FROM probe WHERE id = 'one'`.execute(kysely);
  const integrity = database.pragma('integrity_check', { simple: true });
  await kysely.destroy();

  const header = readFileSync(path).subarray(0, 16).toString('utf8');
  const reopened = new Database(path, { readonly: true });
  applyProfile(reopened, key);
  const reopenedValue = reopened.prepare('SELECT value FROM probe WHERE id = ?').get('one');
  reopened.close();

  let wrongKeyRejected = false;
  const wrong = new Database(path, { readonly: true });
  try {
    applyProfile(wrong, wrongKey);
    wrong.prepare('SELECT count(*) FROM sqlite_master').get();
  } catch {
    wrongKeyRejected = true;
  } finally {
    wrong.close();
  }

  const report = {
    synchronousRow: result.rows[0],
    integrity,
    encryptedHeader: header !== 'SQLite format 3\u0000',
    reopenedValue,
    wrongKeyRejected,
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
  rmSync(path, { force: true });
  app.exit(Object.values(report).every(Boolean) ? 0 : 1);
}).catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  app.exit(1);
});
```

- [ ] **Step 6: Execute the probe and inspect the native artifact**

Run:

```bash
node_modules/.bin/electron scripts/probeEncryptedSqlite.cjs
find node_modules/better-sqlite3-multiple-ciphers -name '*.node' -print -exec file {} \;
```

Expected: the probe exits 0 and prints JSON with `integrity:"ok"`, `encryptedHeader:true`, `wrongKeyRejected:true`, and the persisted row. `file` reports a Mach-O arm64 native bundle.

- [ ] **Step 7: Record the explicit comparison and hard decision**

Create `docs/superpowers/research/2026-08-30-encrypted-sqlite-driver-decision.md` containing:

```markdown
# Encrypted SQLite Driver Decision

**Runtime:** Electron 44.0.0, Node 24, Darwin arm64
**Verdict:** PASS — use `better-sqlite3-multiple-ciphers@12.11.1`
**Cipher profile:** `cipher=sqlcipher`, `legacy=4`, 32-byte raw key

| Candidate | Synchronous | Encrypted | Kysely built-in dialect | Electron 44 arm64 result |
|---|---:|---:|---:|---|
| `better-sqlite3@13.0.3` | Yes | No | Yes | Rejected: no encryption |
| `@journeyapps/sqlcipher@6.0.0` | No | Yes | No | Rejected: async API boundary |
| `better-sqlite3-multiple-ciphers@12.11.1` | Yes | Yes | Yes | Accepted only after probe passes |

The retained probe proves keyed creation, non-plaintext header, wrong-key rejection,
WAL, FTS5, integrity checking, Kysely queries, reopen persistence, and Electron 44
arm64 native loading. Re-run the probe before any driver/Electron major upgrade.
```

If the probe failed, change Verdict to FAIL, paste the failing command/output, commit only the research artifact, notify the user, and stop. Do not execute Tasks 2–13.

- [ ] **Step 8: Make the accepted decision executable and turn the Gate test GREEN**

Create `src/main/db/sqliteDriverDecision.ts`:

```ts
export const encryptedDriverDecision = {
  packageName: 'better-sqlite3-multiple-ciphers',
  packageVersion: '12.11.1',
  cipher: 'sqlcipher',
  compatibility: 4,
  synchronous: true,
} as const;
```

Run:

```bash
npx vitest run tests/main/encryptedSqliteCompatibility.test.ts
npm run typecheck
npm run lint
```

Expected: the focused test PASSes; typecheck and lint exit 0.

- [ ] **Step 9: Commit the passed gate artifact and probe**

Run:

```bash
git add scripts/probeEncryptedSqlite.cjs docs/superpowers/research/2026-08-30-encrypted-sqlite-driver-decision.md src/main/db/sqliteDriverDecision.ts tests/main/encryptedSqliteCompatibility.test.ts
git commit -m "research: select encrypted sqlite driver"
```

Expected: commit succeeds with the Gate test GREEN. The probe candidate remains installed only in the current `node_modules`; Task 3 makes the package dependency reproducible.

### Task 2: Keychain-Backed Workspace Key Management

**Files:**
- Create: `src/main/security/workspaceKeyTypes.ts`
- Create: `src/main/security/keyProtector.ts`
- Create: `src/main/security/safeStorageKeyProtector.ts`
- Create: `src/main/security/workspaceKeyStore.ts`
- Create: `src/main/security/recoveryKey.ts`
- Test: `tests/main/safeStorageKeyProtector.test.ts`
- Test: `tests/main/workspaceKeyStore.test.ts`
- Test: `tests/main/recoveryKey.test.ts`

**Interfaces:**
- Consumes: Electron `safeStorage.encryptStringAsync` / `decryptStringAsync`, an application-private `0700` user-data directory, injected clock/random bytes for tests.
- Produces: `WorkspaceKeyStore.loadOrCreate()`, `restore()`, and versioned recovery material. Task 3 uses the returned 32-byte key and never receives Keychain details.

- [ ] **Step 1: Write RED tests for create, reload, rotation, missing envelope, and recovery**

Use an in-memory `KeyProtector` and deterministic `Buffer.alloc(32, 0x2a)` source. Assert:

```ts
await expect(store.loadOrCreate({ envelopePath, databaseExists: false }))
  .resolves.toMatchObject({ version: 1 });
await expect(store.loadOrCreate({ envelopePath, databaseExists: true }))
  .resolves.toEqual(firstKey);
await rm(envelopePath);
await expect(store.loadOrCreate({ envelopePath, databaseExists: true }))
  .rejects.toThrow('Workspace key is unavailable for an existing database');
```

Assert the envelope is mode `0600`, never contains the raw key/base64 key, and is atomically reprotected when `shouldReprotect` is true. Recovery tests must reject checksum/version errors and reproduce the exact 32 bytes.

- [ ] **Step 2: Run the RED tests**

Run:

```bash
npx vitest run tests/main/safeStorageKeyProtector.test.ts tests/main/workspaceKeyStore.test.ts tests/main/recoveryKey.test.ts
```

Expected: FAIL with missing modules under `src/main/security`.

- [ ] **Step 3: Define key types and protector boundary**

Create these exact public contracts:

```ts
export type WorkspaceKey = Readonly<{ bytes: Buffer; version: 1 }>;

export interface KeyProtector {
  protect(value: Buffer): Promise<Buffer>;
  unprotect(value: Buffer): Promise<{
    value: Buffer;
    shouldReprotect: boolean;
  }>;
}

export type WorkspaceKeyStoreInput = {
  envelopePath: string;
  databaseExists: boolean;
};
```

`SafeStorageKeyProtector` converts bytes to base64 only in memory, uses asynchronous safeStorage calls, parses the decrypted base64 back to exactly 32 bytes, and maps temporary Keychain unavailability to `WorkspaceKeyTemporarilyUnavailableError`.

- [ ] **Step 4: Implement atomic envelope behavior and recovery material**

The envelope JSON is exactly:

```ts
type WorkspaceKeyEnvelopeV1 = {
  format: 'callie-workspace-key';
  version: 1;
  protectedKeyBase64: string;
  createdAt: string;
};
```

Write to a sibling temporary file with mode `0600`, fsync it, rename it over the destination, and fsync the parent directory. `loadOrCreate` generates a key only when both envelope and database are absent. Recovery material uses `CALLIE1-<base64url key>-<8 hex checksum characters>` and verifies SHA-256 checksum before returning bytes.

- [ ] **Step 5: Run GREEN tests and refactor**

Run:

```bash
npx vitest run tests/main/safeStorageKeyProtector.test.ts tests/main/workspaceKeyStore.test.ts tests/main/recoveryKey.test.ts
npm run typecheck
npm run lint
```

Expected: all focused tests PASS; typecheck and lint exit 0. Refactor duplicated atomic-file helpers into private functions inside `workspaceKeyStore.ts`; do not create a generic filesystem utility.

- [ ] **Step 6: Commit key management**

Run:

```bash
git add src/main/security tests/main/safeStorageKeyProtector.test.ts tests/main/workspaceKeyStore.test.ts tests/main/recoveryKey.test.ts
git commit -m "feat: add keychain-backed workspace keys"
```

Expected: one focused commit with no database changes.

### Task 3: Adopt the Encrypted Driver and Convert Plaintext Schema 1 Safely

**Files:**
- Create: `src/main/db/sqliteDriver.ts`
- Create: `src/main/db/databaseEncryption.ts`
- Create: `src/main/db/plaintextDatabaseUpgrade.ts`
- Modify: `src/main/db/database.ts`
- Modify: `src/main/foundation/foundationRuntime.ts`
- Modify: `src/main/startApplication.ts`
- Modify: `src/main.ts`
- Modify: `src/main/health/healthService.ts`
- Modify: `src/shared/healthContract.ts`
- Modify: `src/renderer/App.tsx`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `vite.main.config.ts`
- Modify: `forge.config.ts`
- Modify: `scripts/verifyPackage.mjs`
- Modify: `test/verifyPackage.test.mjs`
- Modify: `tests/fixtures/tempDatabase.ts`
- Modify: all tests that call `openDatabase` or construct `AppHealth`
- Modify: `tests/e2e/foundation.spec.ts`
- Modify: `README.md`
- Test: `tests/main/databaseEncryption.test.ts`
- Test: `tests/integration/plaintextDatabaseUpgrade.test.ts`

**Interfaces:**
- Consumes: Gate 0 PASS profile and `WorkspaceKeyStore` from Task 2.
- Produces:

```ts
export type DatabaseOpenOptions = { path: string; key: WorkspaceKey };
export function openDatabase(options: DatabaseOpenOptions): AppDatabase;
export function inspectDatabaseEncryption(db: AppDatabase): {
  encrypted: true;
  cipherVersion: string;
  integrity: 'ok';
};
```

- [ ] **Step 1: Write RED encrypted-open and conversion tests**

Tests must cover new encrypted creation, wrong key, encrypted header, persisted reopen, plaintext schema-1 conversion with a retained `jobs` row, interruption recovery, and refusal to generate a replacement key for an existing encrypted file. Use:

```ts
export const TEST_WORKSPACE_KEY: WorkspaceKey = {
  bytes: Buffer.alloc(32, 0x2a),
  version: 1,
};
```

The conversion assertion is:

```ts
expect(readFileSync(databasePath).subarray(0, 16).toString('utf8'))
  .not.toBe('SQLite format 3\u0000');
expect(reopened.raw.prepare('SELECT id FROM jobs WHERE id = ?').get('kept'))
  .toEqual({ id: 'kept' });
```

- [ ] **Step 2: Run RED tests**

Run:

```bash
npx vitest run tests/main/encryptedSqliteCompatibility.test.ts tests/main/databaseEncryption.test.ts tests/integration/plaintextDatabaseUpgrade.test.ts
```

Expected: FAIL because `sqliteDriver.ts`, encrypted open options, and conversion functions are absent.

- [ ] **Step 3: Pin and package the selected native dependency**

Run:

```bash
npm uninstall better-sqlite3
npm install --save-exact better-sqlite3-multiple-ciphers@12.11.1
npx electron-rebuild -f -w better-sqlite3-multiple-ciphers
```

Modify the `rebuild` script and configuration so future `npm run rebuild`, Vite externalization, Forge ASAR inclusion, package verification, and verifier fixtures name `better-sqlite3-multiple-ciphers`. Keep `@types/better-sqlite3` only if its structural types are still required; production imports must use `sqliteDriver.ts` rather than importing the package directly.

- [ ] **Step 4: Implement the single cipher profile and keyed open**

`sqliteDriver.ts` exports the Gate 0 decision and these functions:

```ts
export { encryptedDriverDecision } from './sqliteDriverDecision';

export function applyWorkspaceKey(database: RawDatabase, key: Buffer): void {
  if (key.byteLength !== 32) throw new RangeError('Workspace key must contain 32 bytes.');
  const keyHex = key.toString('hex');
  database.pragma("cipher='sqlcipher'");
  database.pragma('legacy=4');
  database.pragma(`key="x'${keyHex}'"`);
  database.prepare('SELECT count(*) FROM sqlite_master').get();
}
```

`openDatabase` applies the key before foreign-key, WAL, busy-timeout, FTS, schema, or health queries. It never retains the key. `FoundationRuntime` retains the caller-owned key only through conversion/open/migration/backup, then zeroes `key.bytes` in a `finally` block after initialization succeeds or fails.

- [ ] **Step 5: Implement crash-recoverable plaintext conversion**

Use sibling paths `callie.sqlite3.encrypting`, `callie.sqlite3.plaintext-recovery`, and `callie.sqlite3.encryption-state.json`. The state machine is:

1. Open plaintext without a key, checkpoint/truncate WAL, close.
2. Copy plaintext canonical file to `.encrypting`.
3. Apply the accepted profile and `rekey` to `.encrypting`.
4. Close/reopen `.encrypting` with the workspace key; verify integrity, schema version, and retained row counts.
5. Write/fsync the state marker.
6. Rename canonical plaintext to `.plaintext-recovery`.
7. Rename `.encrypting` to canonical and fsync the directory.
8. Reopen canonical with key and verify again.
9. Remove marker and plaintext recovery file.

On restart, use the marker plus independent validation of canonical/temp/recovery files to resume promotion or restore plaintext. Never delete the only valid copy.

- [ ] **Step 6: Wire asynchronous key resolution into lazy runtime initialization**

Change `FoundationRuntimeDependencies` to include:

```ts
loadWorkspaceKey(input: WorkspaceKeyStoreInput): Promise<WorkspaceKey>;
prepareEncryptedDatabase(path: string, key: WorkspaceKey): Promise<void>;
openDatabase(options: DatabaseOpenOptions): AppDatabase;
```

`startApplication` derives `callie.key-envelope.json` next to `callie.sqlite3`. `main.ts` acquires `app.requestSingleInstanceLock()` before startup; a second instance exits without touching the database.

- [ ] **Step 7: Expose encryption health without exposing secrets**

Add `databaseEncrypted: z.literal(true)` and `cipherVersion: z.string().min(1)` to `appHealthSchema`. Render `Encrypted SQLite ready`. Update all health fixtures and tests to schema version 1 at this task; Task 5 moves them to 2.

- [ ] **Step 8: Replace the packaged E2E plaintext read**

Remove the stock SQLite import from `tests/e2e/foundation.spec.ts`. Read only the first 16 file bytes and assert they do not equal the SQLite plaintext header. Continue asserting two-launch health persistence and encrypted diagnostics through the existing narrow preload API.

- [ ] **Step 9: Run GREEN verification**

Run:

```bash
npx vitest run tests/main/encryptedSqliteCompatibility.test.ts tests/main/databaseEncryption.test.ts tests/integration/plaintextDatabaseUpgrade.test.ts tests/main/database.test.ts tests/main/foundationRuntime.test.ts tests/main/startApplication.test.ts tests/main/healthService.test.ts test/verifyPackage.test.mjs
npm run typecheck
npm run lint
npm run test
npm run verify:e2e
npm run verify:package
```

Expected: all unit/integration tests PASS; packaged app launches twice against the same encrypted profile; package verifier reports one Darwin arm64 encrypted-driver native binary.

- [ ] **Step 10: Commit encrypted runtime conversion**

Run:

```bash
git add package.json package-lock.json vite.main.config.ts forge.config.ts scripts/verifyPackage.mjs test/verifyPackage.test.mjs src tests test README.md
git commit -m "feat: encrypt the local sqlite workspace"
```

Expected: the commit contains no plaintext test database or workspace-key material.

### Task 4: Create and Verify Pre-Migration Backups

**Files:**
- Create: `src/main/db/migrationBackup.ts`
- Modify: `src/main/db/migrate.ts`
- Modify: `src/main/foundation/foundationRuntime.ts`
- Modify: `src/main/startApplication.ts`
- Modify: `tests/main/migrations.test.ts`
- Test: `tests/integration/migrationBackup.test.ts`

**Interfaces:**
- Consumes: an already keyed, encrypted `AppDatabase` and workspace backup directory.
- Produces:

```ts
export type MigrationBackup = {
  path: string;
  sourceSchemaVersion: number;
  sha256: string;
  verifiedAt: string;
};

export function createVerifiedMigrationBackup(input: {
  database: AppDatabase;
  backupDirectory: string;
  key: WorkspaceKey;
  sourceSchemaVersion: number;
}): MigrationBackup;
```

- [ ] **Step 1: Write RED backup tests**

Assert no backup is created when already latest, exactly one encrypted backup is created before a pending migration, its header is not plaintext, it reopens with the key, checksum metadata matches, and an induced migration failure leaves schema 1 plus the verified backup intact.

- [ ] **Step 2: Run RED tests**

Run:

```bash
npx vitest run tests/integration/migrationBackup.test.ts tests/main/migrations.test.ts
```

Expected: FAIL because migration backup APIs and options do not exist.

- [ ] **Step 3: Implement the startup-only encrypted snapshot**

Before migration services can write:

```ts
database.raw.pragma('wal_checkpoint(TRUNCATE)');
```

Copy the closed/checkpointed encrypted file to `backups/pre-migration-schema-<version>-<UTC compact timestamp>.sqlite3`, fsync, calculate SHA-256, reopen the backup with the workspace key, run `integrity_check`, and confirm its `app_meta.schema_version`. Remove and fail initialization if verification fails.

- [ ] **Step 4: Gate migration execution on a verified backup**

Change the migration contract to:

```ts
type MigrationOptions = {
  backupDirectory: string;
  workspaceKey: WorkspaceKey;
};

export async function migrateToLatest(
  db: AppDatabase,
  options: MigrationOptions,
): Promise<MigrationResult>;
```

Read the latest registered migration version before creating a backup. Create one only when `fromVersion < latestVersion`, then enter the existing `BEGIN IMMEDIATE` migration transaction.

- [ ] **Step 5: Run GREEN tests and full foundation checks**

Run:

```bash
npx vitest run tests/integration/migrationBackup.test.ts tests/main/migrations.test.ts tests/main/foundationRuntime.test.ts tests/main/startApplication.test.ts
npm run typecheck
npm run lint
npm run test
```

Expected: tests PASS; an induced migration rollback never deletes or replaces its backup.

- [ ] **Step 6: Commit migration backup support**

Run:

```bash
git add src/main/db/migrationBackup.ts src/main/db/migrate.ts src/main/foundation/foundationRuntime.ts src/main/startApplication.ts tests/integration/migrationBackup.test.ts tests/main/migrations.test.ts tests/main/foundationRuntime.test.ts tests/main/startApplication.test.ts
git commit -m "feat: verify encrypted migration backups"
```

### Task 5: Add Schema 0002 and Database-Enforced Domain Invariants

**Files:**
- Create: `src/main/db/domainSchema.ts`
- Create: `src/main/db/migrations/0002DomainFoundation.ts`
- Modify: `src/main/db/schema.ts`
- Modify: `src/main/db/migrate.ts`
- Modify: `src/main/jobs/jobTypes.ts`
- Modify: `src/main/jobs/jobRepository.ts`
- Modify: `src/main/health/healthService.ts`
- Modify: all schema-version health fixtures from 1 to 2
- Modify: `tests/main/migrations.test.ts`
- Modify: `tests/main/jobRepository.test.ts`
- Create: `tests/main/domainSchema.test.ts`
- Create: `tests/main/domainConstraints.test.ts`
- Create: `tests/fixtures/domainRows.ts`

**Interfaces:**
- Consumes: encrypted schema 1 and verified pre-migration backup from Task 4.
- Produces: `DomainTables`, composed into the existing `FoundationDatabase`, plus concrete SQL constraints used by every later repository.

- [ ] **Step 1: Write the RED schema manifest test**

Assert schema version 2 and this exact table set in addition to existing `app_meta`, `jobs`, Kysely migration tables, and FTS probe:

```ts
const domainTables = [
  'activities',
  'activity_amendments',
  'cadence_action_components',
  'cadence_definitions',
  'cadence_enrollments',
  'cadence_steps',
  'consent_policy_records',
  'next_actions',
  'opt_out_handles',
  'opt_out_tombstones',
  'organization_aliases',
  'organizations',
  'persons',
  'person_contact_methods',
  'prioritization_evaluations',
  'prioritization_rule_versions',
  'priority_overrides',
  'properties',
  'prospects',
  'prospect_organizations',
  'prospect_priority_projection',
  'prospect_properties',
  'reactivation_rules',
  'sales_cycles',
  'sales_cycle_close_readiness',
  'source_events',
  'stage_events',
  'trigger_events',
  'workspace_settings',
  'won_terms',
];
```

Also inspect `sqlite_master` for every index and trigger named in Step 4.

- [ ] **Step 2: Write RED constraint tests before migration SQL**

Use raw inserts to prove the database rejects:

- two Prospects for one Person;
- two `active`/`onboarding` cycles for one Person;
- mismatched Prospect/Person and SourceEvent/Person references;
- open workflow with null current action and closed workflow with a current action;
- current action owned by another cycle;
- completion/deletion of the referenced current action before pointer movement;
- P0 with non-Direct reachability;
- two active cadence enrollments on one cycle;
- duplicate adapter/provider idempotency key;
- source/activity/stage/trigger UPDATE or DELETE;
- consent-policy-record UPDATE or DELETE;
- self-referral and referral without referrer/unknown reason;
- deletion of opt-out tombstone or handle.
- confirmed design-partner fitness before Interviewed.

- [ ] **Step 3: Run the RED migration tests**

Run:

```bash
npx vitest run tests/main/domainSchema.test.ts tests/main/domainConstraints.test.ts tests/main/migrations.test.ts
```

Expected: FAIL because migration 0002 and domain types are absent.

- [ ] **Step 4: Define exact schema ownership and constraints**

Keep existing foundation table types in `schema.ts`; export and intersect `DomainTables` from `domainSchema.ts`. The migration creates the Step 1 tables with these ownership rules:

- `persons`: identity projection, opt-out boolean, Never Record, soft-deletion/version timestamps.
- `person_contact_methods`: Person-owned normalized phone/email handles, validation/directness/primary flags and indexes; shared office handles are permitted.
- `organizations`, aliases, `properties`, and Prospect join tables: secondary context only.
- `prospects`: `UNIQUE(person_id)`, required original SourceEvent, segment, qualification state.
- `source_events`: immutable Person-owned channel/evidence/referrer events; composite `UNIQUE(id, person_id)`.
- `activities`: immutable communication/system facts; partial unique `(adapter, provider_idempotency_key)`.
- `activity_amendments`: immutable corrections referencing one Activity.
- `stage_events`: immutable cycle transitions with effective/confirmation time and backfill provenance.
- `consent_policy_records`: immutable policy/version/effective-time evidence for later recording and cloud-processing adapters.
- `sales_cycles`: Person/Prospect/source references, stage, workflow, current action, stage time, design fitness and optimistic version.
- `next_actions`: Cycle-owned action/channel/due/status/cadence references, with `UNIQUE(id, sales_cycle_id)`.
- `reactivation_rules`, `won_terms`, and `sales_cycle_close_readiness`: Cycle-owned one-to-many/one-to-one state.
- cadence tables: immutable versioned catalog and one partial-unique active enrollment per Cycle.
- `trigger_events` and immutable `prioritization_evaluations`: evidence and reproducible calculations.
- `prospect_priority_projection`: one mutable row per Prospect with Fit/Timing bands and independent values.
- `priority_overrides`: reasoned, expiring manual controls.
- opt-out tables: indefinite tombstone plus one-to-many normalized blocked handles.

Use these critical cycle/action definitions in the migration:

```sql
CREATE TABLE sales_cycles (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  prospect_id TEXT NOT NULL,
  entry_source_event_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN (
    'unreviewed','ready','contacted','interviewed','offered','won','lost_nurture'
  )),
  workflow_status TEXT NOT NULL CHECK (workflow_status IN ('active','onboarding','closed')),
  current_next_action_id TEXT,
  stage_entered_at TEXT NOT NULL,
  design_partner_fitness INTEGER CHECK (design_partner_fitness BETWEEN 0 AND 5),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (workflow_status IN ('active','onboarding') AND current_next_action_id IS NOT NULL)
    OR (workflow_status = 'closed' AND current_next_action_id IS NULL)
  ),
  CHECK (
    (workflow_status = 'active' AND stage IN ('unreviewed','ready','contacted','interviewed','offered'))
    OR (workflow_status = 'onboarding' AND stage = 'won')
    OR (workflow_status = 'closed' AND stage IN ('won','lost_nurture'))
  ),
  UNIQUE (id, person_id),
  FOREIGN KEY (prospect_id, person_id) REFERENCES prospects(id, person_id),
  FOREIGN KEY (entry_source_event_id, person_id) REFERENCES source_events(id, person_id),
  FOREIGN KEY (current_next_action_id, id)
    REFERENCES next_actions(id, sales_cycle_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE next_actions (
  id TEXT PRIMARY KEY,
  sales_cycle_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  channel TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','completed','cancelled','impossible')),
  due_at TEXT NOT NULL,
  timezone TEXT NOT NULL,
  allowed_window TEXT,
  cadence_enrollment_id TEXT,
  cadence_step_id TEXT,
  cadence_component_id TEXT,
  completion_activity_id TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (id, sales_cycle_id),
  FOREIGN KEY (sales_cycle_id) REFERENCES sales_cycles(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE UNIQUE INDEX one_open_cycle_per_person
ON sales_cycles(person_id)
WHERE workflow_status IN ('active','onboarding');
```

Create triggers `protect_current_action_status`, `protect_current_action_delete`, `protect_design_partner_fitness`, `immutable_source_events`, `immutable_activities`, `immutable_activity_amendments`, `immutable_stage_events`, `immutable_consent_policy_records`, `immutable_trigger_events`, `protect_opt_out_tombstone`, and `protect_opt_out_handle`. `protect_current_action_status` aborts when `OLD.id` is still selected by its cycle and `NEW.status <> 'pending'`; pointer movement before completion therefore succeeds. `protect_design_partner_fitness` permits a non-null value only when the cycle is currently Interviewed, Offered, or Won, or its immutable StageEvents prove it previously reached Interviewed.

- [ ] **Step 5: Add deterministic background-job idempotency**

Migration 0002 adds nullable `jobs.idempotency_key` plus:

```sql
CREATE UNIQUE INDEX jobs_type_idempotency_idx
ON jobs(type, idempotency_key)
WHERE idempotency_key IS NOT NULL;
```

Add optional `idempotencyKey` to `EnqueueJobInput`; `enqueue` returns the existing canonical job for the same `(type, idempotencyKey)` rather than inserting a duplicate.

- [ ] **Step 6: Register migration 0002 and update metadata only at success**

Add `0002DomainFoundation` after `0001Foundation` in the Kysely provider. Its last statement updates the singleton `app_meta.schema_version` and `updated_at` to 2. Keep the existing outer rollback test and add a deliberately late failure after several domain tables to prove the retry starts from clean schema 1.

- [ ] **Step 7: Run GREEN migration and invariant tests**

Run:

```bash
npx vitest run tests/main/domainSchema.test.ts tests/main/domainConstraints.test.ts tests/main/migrations.test.ts tests/main/jobRepository.test.ts tests/integration/migrationBackup.test.ts
npm run typecheck
npm run lint
npm run test
npm run verify:e2e
npm run verify:package
```

Expected: schema 2, all raw invalid inserts rejected with SQLite constraint/trigger errors, all existing tests PASS, and package diagnostics report encrypted schema 2.

- [ ] **Step 8: Commit schema 0002**

Run:

```bash
git add src/main/db src/main/jobs src/main/health tests test src/renderer src/shared
git commit -m "feat: add encrypted domain schema 0002"
```

Expected: one migration commit; never revise migration 0002 after another migration ships.

### Task 6: Add the Unit of Work, Identity Repositories, and Immutable Event Store

**Files:**
- Create: `src/main/domain/support/clock.ts`
- Create: `src/main/domain/support/idGenerator.ts`
- Create: `src/main/domain/support/domainUnitOfWork.ts`
- Create: `src/main/domain/support/domainErrors.ts`
- Create: `src/main/domain/identity/identityTypes.ts`
- Create: `src/main/domain/identity/identityRepository.ts`
- Create: `src/main/domain/events/eventTypes.ts`
- Create: `src/main/domain/events/eventRepository.ts`
- Create: `tests/main/domainUnitOfWork.test.ts`
- Create: `tests/main/identityRepository.test.ts`
- Create: `tests/main/eventRepository.test.ts`
- Create: `tests/main/eventImmutability.test.ts`

**Interfaces:**
- Consumes: schema 0002 and the existing raw prepared-SQL/Zod pattern from `JobRepository`.
- Produces: deterministic clocks/IDs, one immediate transaction boundary, identity persistence, and append-only event APIs used by every later service.

- [ ] **Step 1: Write RED unit-of-work and repository tests**

Assert `immediate` commits all writes or rolls all back, nested transactions are rejected, every read row is Zod-parsed, one Person can link two LLCs/properties without a second Prospect, provider duplicates return the existing Activity, and all update/delete attempts against immutable events fail.

- [ ] **Step 2: Run RED tests**

Run:

```bash
npx vitest run tests/main/domainUnitOfWork.test.ts tests/main/identityRepository.test.ts tests/main/eventRepository.test.ts tests/main/eventImmutability.test.ts
```

Expected: FAIL because `src/main/domain` does not exist.

- [ ] **Step 3: Add deterministic support contracts**

Use exact interfaces:

```ts
export interface Clock { now(): string; }
export interface IdGenerator { next(): string; }

export class DomainUnitOfWork {
  constructor(readonly database: AppDatabase) {}
  immediate<T>(operation: () => T): T {
    return this.database.raw.transaction(operation).immediate();
  }
}
```

Production clock uses `new Date().toISOString()`; production IDs use `randomUUID()`. Tests inject a fixed clock and sequence IDs.

- [ ] **Step 4: Implement focused identity repositories**

`IdentityRepository` exposes:

```ts
createPerson(input: CreatePersonInput): Person;
addContactMethod(input: AddContactMethodInput): ContactMethod;
createCanonicalProspect(input: CreateProspectInput): Prospect;
linkOrganization(input: LinkOrganizationInput): void;
linkProperty(input: LinkPropertyInput): void;
findPeopleByNormalizedHandle(kind: 'phone' | 'email', value: string): Person[];
getCanonicalProspect(personId: string): Prospect | null;
```

Methods contain SQL and parsing only. They do not open transactions, choose sources, advance lifecycle, or suppress database errors.

- [ ] **Step 5: Implement append-only event repository**

`EventRepository` exposes:

```ts
appendActivity(input: AppendActivityInput): Activity;
appendActivityAmendment(input: AppendActivityAmendmentInput): ActivityAmendment;
appendStageEvent(input: AppendStageEventInput): StageEvent;
appendConsentPolicyRecord(input: AppendConsentPolicyRecordInput): ConsentPolicyRecord;
getActivity(id: string): Activity | null;
listCycleStageEvents(salesCycleId: string): StageEvent[];
```

For provider idempotency, catch only the named unique constraint, query the canonical row by `(adapter, providerIdempotencyKey)`, and return it. Re-throw every other database error.

- [ ] **Step 6: Run GREEN tests and refactor row parsers**

Run:

```bash
npx vitest run tests/main/domainUnitOfWork.test.ts tests/main/identityRepository.test.ts tests/main/eventRepository.test.ts tests/main/eventImmutability.test.ts
npm run typecheck
npm run lint
```

Expected: all focused tests PASS. Keep Zod schemas next to the repository that owns the row; do not create a universal row parser.

- [ ] **Step 7: Commit repository foundation**

Run:

```bash
git add src/main/domain/support src/main/domain/identity src/main/domain/events tests/main/domainUnitOfWork.test.ts tests/main/identityRepository.test.ts tests/main/eventRepository.test.ts tests/main/eventImmutability.test.ts
git commit -m "feat: add domain repositories and immutable events"
```

### Task 7: Add Source Attribution and Canonical Prospect Intake

**Files:**
- Create: `src/main/domain/source/sourceTypes.ts`
- Create: `src/main/domain/source/sourceRepository.ts`
- Create: `src/main/domain/source/sourceService.ts`
- Create: `tests/main/sourceRepository.test.ts`
- Create: `tests/main/sourceService.test.ts`

**Interfaces:**
- Consumes: Unit of Work, IdentityRepository, immutable SourceEvent schema, injected clock/IDs.
- Produces: immutable original and activation source attribution before lifecycle creates an Unreviewed cycle.

- [ ] **Step 1: Write RED source tests**

Cover all source enums, required evidence, direct referral with known/unknown referrer, self-referral rejection, RIREIG kept distinct, immutable original source, later appended source event, and one Person/two listings returning one canonical Prospect.

- [ ] **Step 2: Run RED tests**

Run:

```bash
npx vitest run tests/main/sourceRepository.test.ts tests/main/sourceService.test.ts
```

Expected: FAIL because source repository/service modules are absent.

- [ ] **Step 3: Implement source contracts and repository**

Use:

```ts
export type SourceChannel =
  | 'frbo' | 'registry' | 'rireig' | 'referral'
  | 'inbound_demo' | 'community' | 'custom';

export type AppendSourceEventInput = {
  id: string;
  personId: string;
  channel: SourceChannel;
  observedAt: string;
  sourceRecordJson: unknown;
  referredByPersonId?: string;
  referrerUnknownReason?: string;
};
```

Repository inserts and reads immutable SourceEvents only.

- [ ] **Step 4: Implement transactional intake**

`SourceService.createPersonProspect` performs one immediate transaction:

1. Normalize/find or create Person.
2. Append original SourceEvent.
3. Create exactly one canonical Prospect referencing that event.
4. Link all organization/property context.
5. Return IDs and `created`/`merged` disposition.

`appendSourceInteraction` appends an event and never changes `prospects.original_source_event_id`.

- [ ] **Step 5: Run GREEN tests**

Run:

```bash
npx vitest run tests/main/sourceRepository.test.ts tests/main/sourceService.test.ts tests/main/identityRepository.test.ts tests/main/domainConstraints.test.ts
npm run typecheck
npm run lint
```

Expected: tests PASS and two listings never create a second queue-eligible Prospect.

- [ ] **Step 6: Commit source attribution**

Run:

```bash
git add src/main/domain/source tests/main/sourceRepository.test.ts tests/main/sourceService.test.ts
git commit -m "feat: preserve source attribution"
```

### Task 8: Add Versioned Cadence Catalog, Scheduling, and Pure Planning

**Files:**
- Create: `src/main/domain/cadence/cadenceTypes.ts`
- Create: `src/main/domain/cadence/builtinCadences.ts`
- Create: `src/main/domain/cadence/cadenceRepository.ts`
- Create: `src/main/domain/cadence/cadenceScheduler.ts`
- Create: `src/main/domain/cadence/cadencePlanner.ts`
- Create: `tests/main/builtinCadences.test.ts`
- Create: `tests/main/cadenceRepository.test.ts`
- Create: `tests/main/cadenceScheduler.test.ts`
- Create: `tests/main/cadencePlanner.test.ts`

**Interfaces:**
- Consumes: versioned cadence schema, workspace timezone, injected clock. Performs no lifecycle writes.
- Produces pure `CadencePlan` values and idempotently installed built-in definitions for Task 9.

- [ ] **Step 1: Write RED catalog tests for exact V1 definitions**

Assert stable IDs, versions, content hashes, step offsets, channels, compound branches, breakup flags, and attempt caps for Cadence A, B, C, Post-Interview, Post-Offer, and Won Onboarding. Assert reinstallation is idempotent and edited content requires a new version ID.

- [ ] **Step 2: Write RED scheduler/planner tests**

Cover fixed-anchor day offsets, DST, Sunday 1–5 p.m., different-time-window selection, Warm Day-1 scheduling/Day-2 SLA, unavailable channel resolution, failed delivery remaining incomplete, B→A and A/B→C upgrades, no automatic downgrade, bounded total attempts across an upgrade, next-future October 1 resolution, and idempotent event-matched resurrection defaults.

- [ ] **Step 3: Run RED cadence tests**

Run:

```bash
npx vitest run tests/main/builtinCadences.test.ts tests/main/cadenceRepository.test.ts tests/main/cadenceScheduler.test.ts tests/main/cadencePlanner.test.ts
```

Expected: FAIL because cadence modules are absent.

- [ ] **Step 4: Define pure planning contracts**

```ts
export type CadenceOutcome =
  | 'answered' | 'no_answer' | 'voicemail_left'
  | 'accepted' | 'failed' | 'replied' | 'opted_out'
  | 'channel_unavailable' | 'marked_impossible';

export type CadencePlan =
  | { kind: 'next_component'; componentId: string; dueAt: string; timezone: string }
  | { kind: 'next_step'; stepId: string; componentId: string; dueAt: string; timezone: string }
  | { kind: 'exhausted'; reactivationDefaults: ReactivationRuleDraft[] }
  | { kind: 'stop'; reason: 'replied' | 'opted_out' | 'upgraded' };

export function planCadenceStart(input: CadenceStartInput): CadencePlan;
export function planActionOutcome(input: CadenceOutcomeInput): CadencePlan;
```

- [ ] **Step 5: Implement fixed-anchor scheduling**

Every enrollment stores `anchor_at`; every labeled day calculates `anchor local date + day_offset`. Late completion makes an already-due next component due immediately at the next allowed window; it never slides the later labeled days. Calls use the exact Morning/Afternoon/Evening rules; texts/emails use their policy window.

- [ ] **Step 6: Implement catalog persistence and pure outcome graph**

Repository installs immutable definitions/steps/components. Planner consumes plain definition/enrollment/action inputs and returns one plan without SQL. A compound Day 0 uses call → conditional voicemail → conditional text as separate components while counting one scheduled cadence step and multiple Activities.

- [ ] **Step 7: Run GREEN cadence verification**

Run:

```bash
npx vitest run tests/main/builtinCadences.test.ts tests/main/cadenceRepository.test.ts tests/main/cadenceScheduler.test.ts tests/main/cadencePlanner.test.ts
npm run typecheck
npm run lint
```

Expected: tests PASS with deterministic timestamps under the injected clock.

- [ ] **Step 8: Commit cadence planning**

Run:

```bash
git add src/main/domain/cadence tests/main/builtinCadences.test.ts tests/main/cadenceRepository.test.ts tests/main/cadenceScheduler.test.ts tests/main/cadencePlanner.test.ts
git commit -m "feat: add fixed founder sales cadences"
```

### Task 9: Implement Lifecycle, Cadence Persistence, and the Current-Action Invariant

**Files:**
- Create: `src/main/domain/lifecycle/lifecycleTypes.ts`
- Create: `src/main/domain/lifecycle/salesCycleRepository.ts`
- Create: `src/main/domain/lifecycle/nextActionRepository.ts`
- Create: `src/main/domain/lifecycle/lifecycleService.ts`
- Create: `src/main/domain/lifecycle/invariantAudit.ts`
- Create: `tests/main/salesCycleRepository.test.ts`
- Create: `tests/main/lifecycleService.test.ts`
- Create: `tests/main/nextActionInvariant.test.ts`
- Create: `tests/integration/concurrentCycleInvariant.test.ts`
- Create: `tests/support/domainWriteWorker.ts`

**Interfaces:**
- Consumes: Unit of Work, Identity/Event/Source repositories, cadence repository/planner, fixed transition table.
- Produces: all legal lifecycle commands and atomic pointer replacement. Task 10 uses `closeForOptOut`; Task 12 reads the resulting cycle/action projection.

- [ ] **Step 1: Write RED tests for every valid and invalid transition**

Cover:

```text
Unreviewed -> Ready | Lost-Nurture
Ready -> Contacted | Interviewed | Lost-Nurture
Contacted -> Interviewed | Lost-Nurture
Interviewed -> Offered | Lost-Nurture
Offered -> Won/onboarding | Lost-Nurture
Won/onboarding -> Won/closed
```

Assert every unlisted transition fails without writes. Include inbound `Unreviewed → Ready → Contacted`, founder-confirmed Interviewed/Offered, backfilled mechanical stages, effective versus confirmation time, design-partner fitness rejected before Interviewed, and Won terms in integer USD cents.

- [ ] **Step 2: Write RED atomicity and concurrent-connection tests**

Use `tests/support/domainWriteWorker.ts` with `worker_threads` so both independent encrypted connections attempt `BEGIN IMMEDIATE` writes against the same temporary database. Assert:

- active/onboarding creation always installs its first action in the same transaction;
- action completion without replacement/closure fails;
- replacement insert → pointer move → old completion succeeds;
- failed StageEvent append rolls back pointer/action changes;
- two connections racing to create open cycles for one Person leave exactly one committed cycle;
- reactivation is idempotent and does not create a cycle when one is already open.

- [ ] **Step 3: Run RED lifecycle tests**

Run:

```bash
npx vitest run tests/main/salesCycleRepository.test.ts tests/main/lifecycleService.test.ts tests/main/nextActionInvariant.test.ts tests/integration/concurrentCycleInvariant.test.ts
```

Expected: FAIL because lifecycle modules are absent.

- [ ] **Step 4: Implement persistence-only cycle/action repositories**

Use exact repository operations:

```ts
insertCycleWithDeferredAction(input: InsertCycleInput): SalesCycle;
insertNextAction(input: InsertNextActionInput): NextAction;
moveCurrentAction(input: { cycleId: string; expectedVersion: number; nextActionId: string }): SalesCycle;
closeWorkflow(input: { cycleId: string; expectedVersion: number }): SalesCycle;
completeAction(input: CompleteActionInput): NextAction;
getOperationalCycleForPerson(personId: string): SalesCycle | null;
assertCurrentActionPostcondition(cycleId: string): void;
```

Optimistic updates include `WHERE id = ? AND version = ?` and increment `version`; zero updated rows throw `StaleDomainWriteError`.

- [ ] **Step 5: Implement the lifecycle command surface**

```ts
createUnreviewedCycle(input: CreateUnreviewedCycleInput): SalesCycle;
reviewToReady(input: ReviewToReadyInput): SalesCycle;
recordQualifyingContact(input: RecordContactInput): SalesCycle;
confirmInterviewed(input: ConfirmInterviewedInput): SalesCycle;
confirmOffered(input: ConfirmOfferedInput): SalesCycle;
confirmWon(input: ConfirmWonInput): SalesCycle;
completeCurrentAction(input: CompleteCurrentActionInput): SalesCycle;
closeLostNurture(input: CloseLostNurtureInput): SalesCycle;
completeOnboarding(input: CompleteOnboardingInput): SalesCycle;
closeForOptOut(input: CloseForOptOutInput): SalesCycle | null;
```

Every method performs one `DomainUnitOfWork.immediate` transaction and calls `assertCurrentActionPostcondition` immediately before returning.

- [ ] **Step 6: Implement pointer-safe action replacement**

Use this exact order inside the open transaction:

```ts
const replacement = nextActions.insertNextAction(draft);
cycles.moveCurrentAction({
  cycleId,
  expectedVersion,
  nextActionId: replacement.id,
});
nextActions.completeAction({
  actionId: current.id,
  completionActivityId,
  completedAt,
});
cycles.assertCurrentActionPostcondition(cycleId);
```

Closing clears the pointer and changes workflow status before completing/cancelling the old action. This ordering satisfies the schema trigger and prevents a committed gap.

- [ ] **Step 7: Integrate cadence start/advance/exhaustion**

`reviewToReady` selects Warm over Hot-FRBO over Cold-Registry and starts the catalog version. Interviewed stops prospecting and starts Post-Interview; Offered starts Post-Offer; Won starts ordered onboarding. `completeCurrentAction` asks the pure planner for the next component/step. Exhaustion closes Lost-Nurture with versioned default reactivation rules.

- [ ] **Step 8: Implement startup invariant audit**

`auditDomainInvariants()` returns typed violations without modifying data. It checks canonical Prospect count, open-cycle count, pointer ownership/status, cadence multiplicity, P0 reachability, and opted-out open cadence. Later composition exposes the count to health/Review.

- [ ] **Step 9: Run GREEN lifecycle verification**

Run:

```bash
npx vitest run tests/main/salesCycleRepository.test.ts tests/main/lifecycleService.test.ts tests/main/nextActionInvariant.test.ts tests/integration/concurrentCycleInvariant.test.ts tests/main/cadencePlanner.test.ts tests/main/domainConstraints.test.ts
npm run typecheck
npm run lint
npm run test
```

Expected: all lifecycle and invariant tests PASS; failed commands leave byte-for-byte equivalent domain rows.

- [ ] **Step 10: Commit lifecycle foundation**

Run:

```bash
git add src/main/domain/lifecycle tests/main/salesCycleRepository.test.ts tests/main/lifecycleService.test.ts tests/main/nextActionInvariant.test.ts tests/integration/concurrentCycleInvariant.test.ts
git commit -m "feat: enforce lifecycle next actions"
```

### Task 10: Enforce Person-Wide Opt-Out and Source-Preserving Closure

**Files:**
- Create: `src/main/domain/optOut/optOutTypes.ts`
- Create: `src/main/domain/optOut/optOutRepository.ts`
- Create: `src/main/domain/optOut/optOutService.ts`
- Create: `src/main/domain/optOut/outboundPermissionService.ts`
- Create: `tests/main/optOutRepository.test.ts`
- Create: `tests/main/optOutService.test.ts`
- Create: `tests/integration/optOutPersistence.test.ts`
- Modify: `src/main/domain/lifecycle/lifecycleService.ts`
- Modify: `tests/main/lifecycleService.test.ts`

**Interfaces:**
- Consumes: contact handles, immutable evidence, lifecycle closure, cadence/action repositories.
- Produces: an indefinite tombstone and the only database-level outbound permission API.

- [ ] **Step 1: Write RED opt-out tests**

Cover explicit application, repeated idempotent application, all known handles, attempted tombstone deletion, deletion/re-import, Person merge, restore, manual past-touch logging, pre-Won closure, and Won/onboarding behavior. The critical Won assertion is:

```ts
expect(result.cycle).toMatchObject({ stage: 'won', workflowStatus: 'closed' });
expect(result.cycle).not.toMatchObject({ stage: 'lost_nurture' });
```

Also assert every outbound permission check throws after opt-out while append-only audit logging remains available.

- [ ] **Step 2: Run RED opt-out tests**

Run:

```bash
npx vitest run tests/main/optOutRepository.test.ts tests/main/optOutService.test.ts tests/integration/optOutPersistence.test.ts
```

Expected: FAIL because opt-out modules are absent.

- [ ] **Step 3: Implement tombstone persistence**

Repository operations are:

```ts
insertTombstone(input: InsertOptOutTombstoneInput): OptOutTombstone;
insertBlockedHandle(input: InsertOptOutHandleInput): OptOutHandle;
findByHandle(kind: 'phone' | 'email', normalizedValue: string): OptOutTombstone | null;
findForPerson(personId: string): OptOutTombstone | null;
markPersonProjectionOptedOut(personId: string, at: string): void;
```

Blocked handles are normalized values inside the encrypted database so exact re-import matching remains deterministic.

- [ ] **Step 4: Implement one atomic opt-out command**

`OptOutService.apply` performs:

1. Append/retain source Activity evidence.
2. Insert or load canonical tombstone.
3. Add every known normalized phone/email handle.
4. Mark Person projection opted out.
5. Stop active cadence enrollment.
6. Clear current action, then cancel future outbound actions.
7. Close pre-Won cycle as Lost-Nurture with reason `opt_out` and sole reactivation `never`.
8. Preserve Won and close onboarding with `onboarding_stop_reason=opt_out`.
9. Run lifecycle/action postconditions.

- [ ] **Step 5: Implement outbound permission service**

```ts
export class OutboundPermissionService {
  assertMayContactPerson(personId: string): void;
  assertMayContactHandle(kind: 'phone' | 'email', normalizedValue: string): void;
}
```

It queries tombstones at command time and never trusts a cached Today result. Adapter freshness gating remains in the later communication integration plan.

- [ ] **Step 6: Run GREEN opt-out verification**

Run:

```bash
npx vitest run tests/main/optOutRepository.test.ts tests/main/optOutService.test.ts tests/integration/optOutPersistence.test.ts tests/main/lifecycleService.test.ts tests/main/domainConstraints.test.ts
npm run typecheck
npm run lint
npm run test
```

Expected: all tests PASS; opted-out Person has no active cadence or outbound next action, while a Won outcome remains Won.

- [ ] **Step 7: Commit opt-out enforcement**

Run:

```bash
git add src/main/domain/optOut src/main/domain/lifecycle/lifecycleService.ts tests/main/optOutRepository.test.ts tests/main/optOutService.test.ts tests/integration/optOutPersistence.test.ts tests/main/lifecycleService.test.ts
git commit -m "feat: enforce permanent person opt-out"
```

### Task 11: Implement Two-Axis Fit, Timing, Triggers, and Priority Projection

**Files:**
- Create: `src/main/domain/prioritization/prioritizationTypes.ts`
- Create: `src/main/domain/prioritization/builtinPrioritizationRules.ts`
- Create: `src/main/domain/prioritization/qualificationEngine.ts`
- Create: `src/main/domain/prioritization/triggerMath.ts`
- Create: `src/main/domain/prioritization/priorityMatrix.ts`
- Create: `src/main/domain/prioritization/prioritizationRepository.ts`
- Create: `src/main/domain/prioritization/prioritizationService.ts`
- Create: `tests/main/qualificationEngine.test.ts`
- Create: `tests/main/builtinPrioritizationRules.test.ts`
- Create: `tests/main/triggerMath.test.ts`
- Create: `tests/main/priorityMatrix.test.ts`
- Create: `tests/main/prioritizationRepository.test.ts`
- Create: `tests/main/prioritizationService.test.ts`
- Create: `tests/main/noBlendedScore.test.ts`

**Interfaces:**
- Consumes: Prospect/property facts, immutable Source/TriggerEvents, rule versions, explicit evaluation time.
- Produces: one immutable evaluation and one mutable current projection with separate Fit and Timing values.

- [ ] **Step 1: Write the hard-ban RED regression first**

`noBlendedScore.test.ts` scans schema SQL, domain types, engine output keys, and Today ordering source. Reject these case-insensitive tokens outside the test itself:

```ts
const forbidden = [
  'lead_score',
  'overall_score',
  'combined_score',
  'blended_score',
  'weighted_score',
  'fit_weight',
  'timing_weight',
  'order by score',
];
```

Also assert the public result contains `fitPoints`, `fitBand`, `timingMilliPoints`, `timingBand`, `priority`, and no generic `score` property.

- [ ] **Step 2: Write RED pure-engine tests**

Cover qualification gates, exact Fit bands 0–9/10–19/20–30, all nine matrix cells, Direct-gated P0 fallback to P1/Find Direct Line, Verify First below confidence 7, trigger strongest-per-type, one-event/one-trigger, verification multiplier, 40-point cap, half-life boundaries, approaching interpolation, half-open windows, and expiration below 1.0.

- [ ] **Step 3: Run RED priority tests**

Run:

```bash
npx vitest run tests/main/noBlendedScore.test.ts tests/main/builtinPrioritizationRules.test.ts tests/main/qualificationEngine.test.ts tests/main/triggerMath.test.ts tests/main/priorityMatrix.test.ts tests/main/prioritizationRepository.test.ts tests/main/prioritizationService.test.ts
```

Expected: FAIL because prioritization modules are absent.

- [ ] **Step 4: Define types that make blending impossible**

```ts
export type FitBand = 'low' | 'medium' | 'high';
export type TimingBand = 'cold' | 'warm' | 'hot';
export type Priority = 'p0' | 'p1' | 'p2' | 'p3';
export type Reachability = 'direct' | 'indirect' | 'none';

export type PrioritizationEvaluation = {
  id: string;
  prospectId: string;
  ruleVersionId: string;
  evaluatedAt: string;
  fitPoints: number;
  fitBand: FitBand;
  timingMilliPoints: number;
  timingBand: TimingBand;
  reachability: Reachability;
  dataConfidence: number;
  priority: Priority;
  earliestTriggerExpiresAt: string | null;
  verifyFirst: boolean;
  explanation: PrioritizationReason[];
};
```

Do not define a type alias or helper called Score.

`builtinPrioritizationRules.ts` exports one immutable V1 rule document with stable ID/content hash, exact Fit contributions/bands, trigger functions/bands, matrix cells, reachability fallback, confidence threshold 7, and lexicographic ordering fields. Installation rejects a content change under the same ID.

- [ ] **Step 5: Implement exact trigger math with integer ordering precision**

```ts
const raw = base * 2 ** (-ageSeconds / halfLifeSeconds);
const effective = raw * strengthMultiplier * verificationMultiplier;
const milliPoints = Math.round(effective * 1_000);
```

Use UTC instants for decay and workspace-local boundaries for calendar windows. Sum strongest active milli-points per trigger type, cap at `40_000`, and preserve all contributing reason records.

- [ ] **Step 6: Implement matrix and lexicographic prospect tuple**

Matrix output follows the spec exactly. The ordering tuple is:

```ts
[
  priorityOrder,
  earliestTriggerExpirationNullLast,
  -timingMilliPoints,
  -fitPoints,
  reachabilityOrder,
  -dataConfidence,
  lastContactNullFirst,
  stableId,
]
```

This tuple is compared lexicographically and is never reduced to a number.

- [ ] **Step 7: Persist immutable evaluation then update projection**

`PrioritizationService.recalculateProspect({ prospectId, evaluatedAt, ruleVersionId })` runs one transaction: load facts/triggers, compute pure result, insert immutable evaluation, replace `prospect_priority_projection` with optimistic versioning, return the evaluation. Overrides retain computed values and require reason/expiration.

- [ ] **Step 8: Run GREEN prioritization verification**

Run:

```bash
npx vitest run tests/main/noBlendedScore.test.ts tests/main/builtinPrioritizationRules.test.ts tests/main/qualificationEngine.test.ts tests/main/triggerMath.test.ts tests/main/priorityMatrix.test.ts tests/main/prioritizationRepository.test.ts tests/main/prioritizationService.test.ts
npm run typecheck
npm run lint
npm run test
```

Expected: all tests PASS; the no-blended-score test reports zero forbidden production tokens and no generic score property.

- [ ] **Step 9: Commit two-axis prioritization**

Run:

```bash
git add src/main/domain/prioritization tests/main/builtinPrioritizationRules.test.ts tests/main/qualificationEngine.test.ts tests/main/triggerMath.test.ts tests/main/priorityMatrix.test.ts tests/main/prioritizationRepository.test.ts tests/main/prioritizationService.test.ts tests/main/noBlendedScore.test.ts
git commit -m "feat: add two-axis lead prioritization"
```

### Task 12: Build the Promise-First Capacity-Bounded Today Read Model

**Files:**
- Create: `src/main/domain/today/todayTypes.ts`
- Create: `src/main/domain/today/todayRepository.ts`
- Create: `src/main/domain/today/todayOrdering.ts`
- Create: `src/main/domain/today/todayService.ts`
- Create: `tests/main/todayRepository.test.ts`
- Create: `tests/main/todayOrdering.test.ts`
- Create: `tests/main/todayService.test.ts`

**Interfaces:**
- Consumes: operational cycles/current actions, cadence/stage state, current priority projection, opt-out service, injected clock/capacity.
- Produces one explained, deterministic TodayQueue without exposing bare Prospects.

- [ ] **Step 1: Write RED one-lane and ordering tests**

Create fixtures that simultaneously qualify for several lanes and assert first-match assignment exactly once:

1. Won onboarding.
2. Fresh inbound demo/direct referral inside SLA.
3. Overdue primary action.
4. Due Post-Interview/Post-Offer.
5. Other due cadence action.
6. New P0 Ready cycle.
7. P1 Ready cycle.
8. Exploration.
9. Later beyond capacity.

Assert lanes 1–5 use promise/due/stage ordering, lanes 6–8 use the Task 11 lexicographic tuple, and stable ID is final tie-breaker.

- [ ] **Step 2: Write RED capacity, opt-out, and explanation tests**

Assert onboarding/inbound/overdue/promised work is never suppressed, only call rows consume the 40-dial budget, conversation target does not truncate, two exploration slots remain, Pin to Top stays within its lane, expired pin is ignored, opted-out rows are excluded, inbound-demo SLA breaches after fifteen permitted minutes, direct-referral SLA breaches after forty-eight elapsed hours, three-day re-surface suppression never hides due work, and every row explains lane/triggers/cadence/action/last activity/Verify First.

- [ ] **Step 3: Run RED Today tests**

Run:

```bash
npx vitest run tests/main/todayRepository.test.ts tests/main/todayOrdering.test.ts tests/main/todayService.test.ts
```

Expected: FAIL because Today modules are absent.

- [ ] **Step 4: Define Today types and lane assignment**

```ts
export type TodayLane =
  | 'won_onboarding' | 'inbound_interrupt' | 'overdue'
  | 'post_interview_offer' | 'due_cadence' | 'new_p0'
  | 'p1' | 'exploration' | 'later';

export type TodayQueue = {
  generatedAt: string;
  dialCapacity: number;
  dialCount: number;
  lanes: ReadonlyArray<{ lane: TodayLane; items: TodayItem[] }>;
};
```

`assignLane(candidate, asOf)` is a pure first-match function. A candidate is always an operationally open SalesCycle with a valid current action.

- [ ] **Step 5: Implement repository prefilter and service guards**

Repository joins SalesCycle, current NextAction, active cadence, Person, Prospect, and current priority projection. SQL excludes closed workflows and Person opt-out projection. `TodayService.build` rechecks `OutboundPermissionService` before including outbound rows; invariant failures become typed diagnostics instead of queue items.

- [ ] **Step 6: Implement stable sorting and capacity**

Apply lane assignment first, then lane-specific comparator, then stable ID. Pin only precedes peers inside the same lane. Walk sorted discretionary call rows against dial capacity; move overflow to Later without suppressing texts/emails or promised work.

- [ ] **Step 7: Run GREEN Today verification**

Run:

```bash
npx vitest run tests/main/todayRepository.test.ts tests/main/todayOrdering.test.ts tests/main/todayService.test.ts tests/main/noBlendedScore.test.ts tests/main/optOutService.test.ts tests/main/nextActionInvariant.test.ts
npm run typecheck
npm run lint
npm run test
```

Expected: all tests PASS; every candidate appears once or is represented by an invariant diagnostic.

- [ ] **Step 8: Commit Today domain model**

Run:

```bash
git add src/main/domain/today tests/main/todayRepository.test.ts tests/main/todayOrdering.test.ts tests/main/todayService.test.ts
git commit -m "feat: add promise-first Today queue"
```

### Task 13: Compose Domain Services, Install Built-Ins, and Run Startup Audits

**Files:**
- Create: `src/main/domain/createDomainServices.ts`
- Create: `src/main/domain/domainRuntime.ts`
- Create: `tests/main/createDomainServices.test.ts`
- Create: `tests/integration/domainRuntime.test.ts`
- Modify: `src/main/foundation/foundationRuntime.ts`
- Modify: `src/main/health/healthService.ts`
- Modify: `src/shared/healthContract.ts`
- Modify: `src/renderer/App.tsx`
- Modify: corresponding runtime/health/renderer tests
- Modify: `README.md`

**Interfaces:**
- Consumes: encrypted schema 2 and all Tasks 6–12.
- Produces one main-process-only service graph, deterministic startup installation/audits, and health diagnostics. No domain object crosses preload in this plan.

- [ ] **Step 1: Write RED composition and restart tests**

Assert one initialized database creates one shared Unit of Work/repository graph, installs built-in cadence/rule versions once, recovers background jobs, audits invariants, reuses the graph for concurrent health requests, closes once, and repeats deterministically after restart.

- [ ] **Step 2: Run RED composition tests**

Run:

```bash
npx vitest run tests/main/createDomainServices.test.ts tests/integration/domainRuntime.test.ts tests/main/foundationRuntime.test.ts tests/main/healthService.test.ts
```

Expected: FAIL because composition modules and health fields are absent.

- [ ] **Step 3: Create one explicit service graph**

```ts
export type DomainServices = {
  unitOfWork: DomainUnitOfWork;
  identities: IdentityRepository;
  events: EventRepository;
  sources: SourceService;
  lifecycle: LifecycleService;
  optOut: OptOutService;
  outboundPermission: OutboundPermissionService;
  prioritization: PrioritizationService;
  today: TodayService;
  auditInvariants(): DomainInvariantViolation[];
};

export function createDomainServices(input: {
  database: AppDatabase;
  clock: Clock;
  ids: IdGenerator;
}): DomainServices;
```

Construct each repository once around the same `AppDatabase`. Services share the one Unit of Work; no service starts a nested transaction.

- [ ] **Step 4: Add deterministic domain startup**

After migration and before health becomes ready:

1. Install built-in cadence definitions and initial prioritization rule version idempotently.
2. Recover interrupted jobs using existing behavior.
3. Audit schema/domain invariants.
4. Enqueue idempotent recalculation jobs for missing/stale priority projections.
5. Retain violations for health/Review without silently repairing evidence.

- [ ] **Step 5: Extend health with safe domain diagnostics**

Add:

```ts
domainReady: z.boolean(),
domainInvariantViolationCount: z.number().int().nonnegative(),
pendingProjectionRebuilds: z.number().int().nonnegative(),
```

Render only counts/status. Do not expose contacts, sources, activities, keys, SQL, or evidence through health IPC.

- [ ] **Step 6: Run full GREEN verification**

Run:

```bash
npx vitest run tests/main/createDomainServices.test.ts tests/integration/domainRuntime.test.ts tests/main/foundationRuntime.test.ts tests/main/healthService.test.ts
npm run typecheck
npm run lint
npm run test
npm run verify:e2e
npm run verify:package
```

Expected: every test PASS; packaged diagnostics show encrypted schema 2, domain ready, zero invariant violations, FTS5, and stable restart persistence.

- [ ] **Step 7: Run the plan-level self-review checks**

Run:

```bash
rg -n -i "lead_score|overall_score|combined_score|blended_score|weighted_score|fit_weight|timing_weight|order by score" src/main src/shared
rg -n "better-sqlite3(?!-multiple-ciphers)" --pcre2 package.json package-lock.json src tests test scripts forge.config.ts vite.main.config.ts README.md
git status --short
```

Expected: first search returns no production matches; second returns only intentional type-package or historical research references; git status shows only intended Task 13 changes before commit.

- [ ] **Step 8: Commit composition and documentation**

Run:

```bash
git add src/main/domain/createDomainServices.ts src/main/domain/domainRuntime.ts src/main/foundation/foundationRuntime.ts src/main/health/healthService.ts src/shared/healthContract.ts src/renderer/App.tsx tests README.md
git commit -m "feat: initialize encrypted domain foundation"
```

- [ ] **Step 9: Record final verification evidence**

Run:

```bash
git log --oneline -13
git status --short
```

Expected: the dependency-ordered task commits are visible, Gate 0 decision is PASS, and the worktree is clean.

## Plan Self-Review

- Spec coverage: encryption/key recovery, migration safety, schema 0002, canonical identity, immutable evidence, source attribution, lifecycle, current action, reactivation, cadence mechanics, opt-out, Fit/Timing, priority matrix, overrides, Today capacity, jobs, startup audits, and packaging are each owned by a numbered task.
- Deferred by design: renderer feature UI, Apple/Gmail adapters, outbound adapter freshness, recording/media encryption, transcript analysis, Learnings, Friday UI, portable backup UI, and existing-product integration require separate approved implementation plans.
- Type consistency: Tasks 6–13 share `AppDatabase`, `DomainUnitOfWork`, `Clock`, `IdGenerator`, `WorkspaceKey`, `SalesCycle.current_next_action_id`, immutable event IDs, and the exact separate Fit/Timing types.
- Placeholder scan: implementation steps name concrete files, interfaces, data flow, test commands, expected failures, expected passes, and commit commands. Gate 0 explicitly blocks downstream work on failure.
