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
- Modify: `src/main/db/migrations/0002DomainFoundation.ts`
- Modify: `src/main/db/domainSchema.ts`
- Modify: `src/main/domain/support/domainErrors.ts`
- Modify: `src/main/domain/events/eventTypes.ts`
- Modify: `src/main/domain/events/eventRepository.ts`
- Modify: `src/main/domain/identity/identityTypes.ts`
- Modify: `src/main/domain/identity/identityRepository.ts`
- Create: `src/main/domain/lifecycle/lifecycleTypes.ts`
- Create: `src/main/domain/lifecycle/salesCycleRepository.ts`
- Create: `src/main/domain/lifecycle/nextActionRepository.ts`
- Create: `src/main/domain/lifecycle/cadenceEnrollmentRepository.ts`
- Create: `src/main/domain/lifecycle/reactivationRepository.ts`
- Create: `src/main/domain/lifecycle/lifecycleReviewRepository.ts`
- Create: `src/main/domain/lifecycle/lifecycleTransactionWriter.ts`
- Create: `src/main/domain/lifecycle/lifecycleService.ts`
- Create: `src/main/domain/lifecycle/invariantAudit.ts`
- Modify: `tests/main/domainConstraints.test.ts`
- Modify: `tests/main/eventRepository.test.ts`
- Modify: `tests/main/identityRepository.test.ts`
- Modify: `tests/support/domainSchemaScenario.ts`
- Create: `tests/main/salesCycleRepository.test.ts`
- Create: `tests/main/cadenceEnrollmentRepository.test.ts`
- Create: `tests/main/reactivationRepository.test.ts`
- Create: `tests/main/lifecycleReviewRepository.test.ts`
- Create: `tests/main/lifecycleService.test.ts`
- Create: `tests/main/nextActionInvariant.test.ts`
- Create: `tests/main/invariantAudit.test.ts`
- Create: `tests/integration/concurrentCycleInvariant.test.ts`
- Create: `tests/support/domainWriteWorker.ts`

**Interfaces:**
- Consumes: the exact `AppDatabase` and `DomainUnitOfWork`, Identity/Event/Source repositories, Task 8's final `CadenceRepository`, `TransitionRecipe`, `planCadenceStart`, `planActionOutcome`, `planCadenceUpgrade`, and `planReactivationDefaults` exports, injected `Clock`/`IdGenerator`, and the fixed transition table. Task 9 must not copy, narrow, or reinterpret Task 8's planner result into the obsolete `CadencePlan` union.
- Produces: strict lifecycle types; persistence-only cycle/action/enrollment/reactivation repositories; a transaction-scoped `LifecycleTransactionWriter`; transaction-owning `LifecycleService` wrappers; legal lifecycle commands; atomic pointer replacement; idempotent rule/inbound resurrection; and a read-only invariant audit. Task 10 uses the scoped writer's `closeForOptOut` inside its own exact-UoW transaction; Task 12 reads the resulting projection.
- Boundary: repository mutations require the active exact-UoW scope; reads may run outside it. Constructors reject mixed databases or different UoW instances by identity. Event and Task 8 cadence repositories expose `assertBoundTo(database, unitOfWork)` just like Identity/Source. Lifecycle SQL never reads `now`; all timestamps, IDs, policy snapshots, and planner `evaluationAt` values are injected and strictly parsed.
- Product lock: at most one operationally open SalesCycle exists per Person; stages are fixed; Contacted requires delivered/answered evidence; Interviewed and Offered are founder-confirmed suggestions; every active/onboarding cycle points to exactly one own pending current action with a due date; every closed cycle points to none; Lost-Nurture has a reason and exact resurrection semantics; and no lifecycle type, column, query, or sort introduces a blended 0-100 score.

Task 8 binding is exact:

```ts
new CadenceRepository({ database, unitOfWork, clock });
cadences.assertBoundTo(database, unitOfWork);
cadences.installBuiltins(): CadenceAggregate[];
cadences.getById(id: string): CadenceAggregate | null;
cadences.getByFamilyVersion(
  family: CadenceFamily,
  version: number,
): CadenceAggregate | null;
planCadenceStart(input: CadenceStartInput): TransitionRecipe;
planActionOutcome(input: CadenceOutcomeInput): TransitionRecipe;
planCadenceUpgrade(input: CadenceUpgradeInput): CadenceUpgradePlan;
planReactivationDefaults(input: {
  salesCycleId: string;
  family: CadenceFamily;
  evaluationAt: string;
  timezone: string;
  manualDueAt: string | null;
}): ReactivationRuleDraft[];
```

`TransitionRecipe` is Task 8's exclusive `{ nextAction: NextActionInstruction; terminal: null } | { nextAction: null; terminal: CadenceTerminal }` intersection with `currentAction`, `enrollment`, and `reactivationDrafts`. `NextActionInstruction` includes both `create` and `reschedule_current`; lifecycle persistence must handle both.

- [ ] **Step 1: Write RED schema and strict persistence-contract tests**

Extend migration/schema tests before repository code. Require:

- `stage_events.transition_sequence INTEGER NOT NULL CHECK (transition_sequence > 0)` with `UNIQUE (sales_cycle_id, transition_sequence)`; immutable-event triggers also block `UPDATE`, `DELETE`, and raw `INSERT OR REPLACE`;
- `reactivation_rules` exposes `UNIQUE (id, sales_cycle_id)` for an exact composite receipt FK and retains only `seasonal:heating-oct1`, `new-frbo-listing`, `lead-cert-expiry-window`, and `manual`;
- a new immutable `cycle_reactivation_receipts` table stores deterministic `activation_key`, `activation_kind: rule | inbound_response`, Person, source closed cycle, exactly one rule/source-event key, new cycle, strict version-1 canonical command/result JSON, and `created_at`;
- a durable `lifecycle_review_items` table stores one open/resolved Review item per blocked activation key, exact Person/Prospect/source ownership, a versioned reason/payload envelope, timestamps, and an optimistic version; blocked work must survive restart rather than exist only as an in-memory union;
- composite FKs prove receipt source-cycle/new-cycle Person ownership, rule ownership by the source cycle, and inbound SourceEvent ownership; rule, source-event, and new-cycle keys are individually unique where present;
- receipt checks reject wrong source cardinality; raw ghost, cross-Person, cross-cycle, duplicate-result, `UPDATE`, `DELETE`, same-PK `OR REPLACE`, and non-PK-unique `OR REPLACE` paths fail closed;
- `cadence_enrollments` persists Task 8's `mode`, canonical `allowed_step_ids_json`, and a positive projection `version`; `sales_cycle_close_readiness` also gains a positive projection `version`;
- `next_actions` persists immutable `work_intent` (`internal_review`, `inbound_response`, `promised_follow_up`, or `discretionary_prospecting`), Task 8's nullable canonical cadence `sla_due_at`, a separate strict nullable inbound-SLA kind/due/provenance union, plus `version`/`updated_at`, so `reschedule_current` can CAS the same pending action without falsely settling or replacing it;
- inbound-SLA storage is an all-or-none union separate from Task 8's cadence SLA: ordinary actions have `inbound_sla_kind`, `inbound_sla_due_at`, `inbound_sla_source_event_id`, and `inbound_sla_provenance_json` all null; inbound demo uses `inbound_sla_kind='inbound_demo_permitted_minutes'`, a same-Person SourceEvent, and strict V1 provenance `{ version: 1, sourceEventId, sourceObservedAt, calculation: 'permitted_minutes', minutes: 15, policyId, computedDueAt }`; direct referral uses `inbound_sla_kind='direct_referral_elapsed'` and `{ version: 1, sourceEventId, sourceObservedAt, calculation: 'elapsed_hours', hours: 48, policyId: null, computedDueAt }`; relational columns and JSON must agree exactly;
- raw INSERT/UPDATE/OR REPLACE tests prove `work_intent` and inbound-SLA kind/source/provenance cannot be changed after insert, the SLA SourceEvent belongs to the cycle Person, and partial or cross-Person SLA unions fail closed;
- settled `next_actions` persist a strict versioned settlement envelope containing outcome, reason/evidence references, and planner-transition identity; pending actions have no settlement and settled evidence cannot be silently rewritten;
- Task 8's composite cadence owner-graph constraints remain intact; and
- migration manifest, schema-version-last behavior, rollback, and packaged schema scenario include the new table/columns without weakening Task 4's pre-migration backup gate.

Use this relational receipt shape:

```text
activation_key PK = "rule:" + rule_id | "inbound:" + source_event_id
activation_kind = rule | inbound_response
person_id
source_cycle_id              -- a closed cycle for the same Person
reactivation_rule_id NULL/UNIQUE
source_event_id NULL/UNIQUE
new_cycle_id NOT NULL/UNIQUE -- stable command input; never generated on replay
command_json/result_json     -- canonical strict { version: 1, ... } envelopes
created_at
```

- [ ] **Step 2: Write RED repository CAS, parsing, and event-order tests**

Test every mutator outside a transaction, under another UoW, and with a repository bound to another database. Test reads outside a transaction. Corrupt each stored enum, canonical UTC timestamp, 0/1 boolean, integer, and JSON envelope through raw SQL and assert strict Zod parsing fails on every read path.

Define and test these persistence-only operations:

```ts
insertCycleWithDeferredAction(input: InsertCycleInput): SalesCycle;
transitionOpenProjection(input: {
  cycleId: string;
  expectedVersion: number;
  expectedStage: LifecycleStage;
  expectedWorkflowStatus: 'active' | 'onboarding';
  expectedCurrentActionId: string;
  nextStage: LifecycleStage;
  nextWorkflowStatus: 'active' | 'onboarding';
  nextActionId: string;
  stageEnteredAt: UtcTimestamp;
}): SalesCycle;
closeProjection(input: {
  cycleId: string;
  expectedVersion: number;
  expectedStage: LifecycleStage;
  expectedWorkflowStatus: 'active' | 'onboarding';
  expectedCurrentActionId: string;
  finalStage: 'won' | 'lost_nurture';
  closedAt: UtcTimestamp;
  closeReason: LostNurtureReason | null;
  closeNotes: string | null;
  onboardingStopReason: string | null;
}): SalesCycle;
insertNextAction(input: InsertNextActionInput): NextAction;
reschedulePendingAction(input: {
  actionId: string;
  salesCycleId: string;
  expectedVersion: number;
  expectedDueAt: UtcTimestamp;
  dueAt: UtcTimestamp;
  timezone: string;
  allowedWindow: string;
  slaDueAt: UtcTimestamp | null;
  cadenceDefinitionId: string;
  cadenceStepId: string;
  cadenceComponentId: string;
}): NextAction;
settleAction(input: SettleActionInput & {
  expectedStatus: 'pending';
  settlement: ActionSettlement;
}): NextAction;
getOperationalCycleForPerson(personId: string): SalesCycle | null;
assertCurrentActionPostcondition(cycleId: string): void;
```

`InsertNextActionInput` includes the immutable fields below. The repository
strictly cross-checks JSON provenance against relational columns and never
derives work intent from stage, due date, or cadence after persistence:

```ts
export type NextActionWorkIntent =
  | 'internal_review'
  | 'inbound_response'
  | 'promised_follow_up'
  | 'discretionary_prospecting';

export type InboundSla =
  | { kind: 'none'; dueAt: null; sourceEventId: null; provenance: null }
  | {
      kind: 'inbound_demo_permitted_minutes';
      dueAt: string;
      sourceEventId: string;
      provenance: {
        version: 1;
        sourceEventId: string;
        sourceObservedAt: string;
        calculation: 'permitted_minutes';
        minutes: 15;
        policyId: string;
        computedDueAt: string;
      };
    }
  | {
      kind: 'direct_referral_elapsed';
      dueAt: string;
      sourceEventId: string;
      provenance: {
        version: 1;
        sourceEventId: string;
        sourceObservedAt: string;
        calculation: 'elapsed_hours';
        hours: 48;
        policyId: null;
        computedDueAt: string;
      };
    };
```

Every projection update includes the shown expected predicates, increments `version`, and throws `StaleDomainWriteError` when zero rows change. Never broadly suppress constraints or parse SQLite error messages. Exact successful retry may return an already-persisted canonical result only after comparing every supplied field; changed evidence or expected state is a typed conflict.

`EventRepository.appendStageEvent` requires an explicit positive `transitionSequence`; `listCycleStageEvents` orders by it and validates a contiguous chain. Initial creation emits sequence 1 as `null -> unreviewed`. A backfilled Contacted immediately followed by founder Interviewed gets consecutive sequences even with identical effective/confirmation timestamps. Add `EventRepository.assertBoundTo`.

- [ ] **Step 3: Write RED tests for every valid and invalid transition**

Cover:

```text
Unreviewed -> Ready | Lost-Nurture
Ready -> Contacted | Interviewed | Lost-Nurture
Contacted -> Interviewed | Lost-Nurture
Interviewed -> Offered | Lost-Nurture
Offered -> Won/onboarding | Lost-Nurture
Won/onboarding -> Won/closed
```

Assert every unlisted transition fails without writes. Include:

- initial `null -> Unreviewed` StageEvent and review action in one commit;
- `reviewToReady` atomically moving the Prospect from `unreviewed` to `eligible`, rejecting `merge_review`, disqualified, deleted, or opted-out Persons/Prospects;
- Unreviewed rejection and Lost-Nurture reasons `not_qualified`/`disqualified` atomically CAS-updating Prospect qualification to `disqualified`; other closure never silently changes qualification;
- inbound `Unreviewed -> Ready -> Contacted` and `Ready -> Interviewed` with the mechanical Contacted StageEvent immediately before the founder event;
- Contacted only from an existing immutable Activity with exact Person/Prospect/Cycle ownership or the explicitly allowed pre-cycle inbound evidence path; accepted outbound text/Gmail email, answered call, confirmed voicemail, and associated inbound qualify, while no-answer, failed, opened, copied, and unconfirmed outcomes do not;
- five-minute call/transcript and price-said evidence only creating suggestions; neither Interviewed nor Offered changes until founder confirmation;
- `effectiveAt <= confirmedAt`, nondecreasing ordinary effective times, the documented inbound-approval exception, `stage_entered_at = effectiveAt`, and separate confirmation time;
- Interviewed only from Ready/Contacted, Offered only from Interviewed, Won only from Offered, and founder/backfill events carrying evidence/provenance;
- design-partner fitness 0-5 accepted only after immutable Interviewed history; and
- Won/onboarding to Won/closed completing or explicitly waiving the final component without appending a second Won StageEvent, so Friday wins count the first Offered -> Won event once.

- [ ] **Step 4: Write RED cadence-recipe and current-action invariant tests**

Import Task 8's final `TransitionRecipe` type and test every recipe variant without reconstructing planner logic in Task 9. Require exactly one `nextAction` or one `terminal` result, never neither/both. Cover:

- Ready cadence precedence Warm/C over Hot-FRBO/A over Cold-Registry/B;
- Post-Interview, Post-Offer, and Onboarding swaps;
- compound-component advancement, resolver actions, retry branches, failed delivery, impossible dispositions, required breakup, and exhaustion;
- Task 8 `reschedule_current` keeping the same authoritative pointer and pending status while CAS-updating due/window/SLA/action version;
- scheduled-step count incrementing once on entry to a scheduled step and zero for another component, resolver, or retry in that step;
- B -> A and A/B -> C upgrades stopping the old enrollment with `upgraded`, preserving completed Activities and total prospecting count, using the highest cap rather than a sum, skipping a just-completed duplicate communication, and never automatically downgrading;
- no prospecting upgrade after Interviewed; and
- `replied`/inbound interrupts installing an actionable response/book-conversation action rather than leaving an open cycle without one.
- exact work-intent assignment and inheritance: the Unreviewed review action is `internal_review`; the first untouched Ready A/B/C or rule-reactivation action is `discretionary_prospecting`; inbound activation/reply is `inbound_response`; onboarding, Post-Interview, Post-Offer, and every later A/B/C step are `promised_follow_up`; resolver/retry/reschedule retains the blocked action's intent; and no command may relabel an existing action to evade Today capacity;
- inbound demo SLA uses exactly fifteen accumulated permitted minutes under the injected text-policy snapshot from SourceEvent `observed_at`, direct referral uses exactly forty-eight elapsed hours, and exact-deadline/replay/policy-boundary/DST tests preserve stored kind/due/provenance.

Every Activity/action/enrollment definition, step, and component ID must form one Task 8 owner graph. Unknown or uninstalled catalog versions and structurally impossible recipes fail before writes.

- [ ] **Step 5: Write RED reactivation, readiness, and Won-terms tests**

Add command tests for:

```ts
type ReactivationResult =
  | { kind: 'reactivated'; cycle: SalesCycle }
  | { kind: 'review_required'; reviewItem: LifecycleReviewItem };

reactivateFromRule(input: ReactivateFromRuleInput): ReactivationResult;
reactivateFromInboundResponse(input: ReactivateFromInboundInput): ReactivationResult;
setDesignPartnerFitness(input: SetDesignPartnerFitnessInput): SalesCycle;
setCloseReadiness(input: SetCloseReadinessInput): CloseReadiness;
```

Reactivation requires no operationally open cycle, an eligible non-deleted Prospect/Person, no opt-out/tombstone, a valid entry SourceEvent, and a planner result with a valid pending action. Otherwise it atomically persists/reuses typed `ReviewRequired` work and does not consume the rule. Test:

- `UPDATE reactivation_rules SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL` and receipt/new-cycle creation in one transaction;
- exact retry reading and comparing the immutable receipt before consuming a generated ID or default clock value;
- changed Person, source cycle, rule/source event, entry source, cadence choice, or new-cycle ID returning a typed idempotency conflict;
- two rules for one Person racing so one commits and the loser's consumption/receipt/new cycle all roll back;
- explicit inbound response using `activation_key = inbound:<sourceEventId>` for an eligible non-opted-out closed Person, without inserting a fifth rule type;
- unknown inbound handle returning unmatched communication Review rather than creating outreach;
- blocked activation retry returning the same durable Review item without consuming IDs/default clock values, while a changed blocked command conflicts; and
- SourceEvents already existing and matching the Person/Prospect; Task 9 never updates immutable `source_events.sales_cycle_id` to manufacture a reciprocal link.

Apply the exact stored default ruling:

```text
Cadence A: seasonal:heating-oct1 + new-frbo-listing
Cadence B: seasonal:heating-oct1 + lead-cert-expiry-window
Cadence C/Post-Offer: no automatic row; optional exact-future manual rule only
inbound_response: lifecycle entry reason, never a stored rule_type
never: zero stored rules, never a row
```

Validate next-future October 1 in workspace timezone, exact future manual `due_at`, strict versioned matcher JSON, and no consumption on Review. Non-opt-out Lost-Nurture requires at least one stored rule after founder override/default resolution; opt-out requires zero. Cadence C/Post-Offer exhaustion therefore requires the caller's exact-future manual rule in the terminal command; missing it fails without settling the breakup/current action or creating a zombie workflow.

When the blocker later clears, an exact activation command CAS-resolves its open Review item and proceeds to the receipt/new-cycle transaction. While unchanged, it returns the canonical open item; a changed command never hijacks that item.

Close readiness is a strict founder-confirmed versioned envelope for demonstrated pain, active timeline, decision authority, willingness to try/pay, and concrete next-step commitment. Each value is `unknown | weak | moderate | strong` with evidence references. Derive scalar columns; pain-confirmed means demonstrated pain is moderate/strong. CAS its projection version.

Won input is a strict discriminated union. For integer USD cents, compute rather than trust the projection:

```text
per_door_monthly: doors_committed * unit_rate_cents
flat_monthly: unit_rate_cents
manual_projected_monthly: caller amount + nonblank reason
```

Persist formula version, founding flag, and effective date in the Offered -> Won transaction. Exact retry compares terms; changed terms conflict.

- [ ] **Step 6: Write RED atomicity, stale-writer, fault-injection, and concurrent-connection tests**

Use `tests/support/domainWriteWorker.ts` with `worker_threads` so both independent encrypted connections attempt `BEGIN IMMEDIATE` writes against the same temporary database. Assert:

- active/onboarding creation always installs its first action in the same transaction;
- action completion without replacement/closure fails;
- replacement insert → pointer move → old completion succeeds;
- failed StageEvent append rolls back pointer/action changes;
- two connections racing to create open cycles for one Person leave exactly one committed cycle;
- two completions of one expected current-action ID yield one success and one `StaleDomainWriteError`, with no orphan replacement;
- replacement versus close, Won versus Lost-Nurture, reactivation versus manual/open-cycle creation, and two different reactivation rules preserve one open cycle and one authoritative pointer;
- same-rule and same-inbound exact retries return the canonical receipt result, while different-command retries conflict;
- an opt-out transaction racing action replacement cannot commit an opted-out active cadence/action;
- configured busy timeout prevents raw `SQLITE_BUSY` from leaking as a domain outcome; and
- no path depends on SQLite message parsing.

Each worker opens and keys its own production `openDatabase` connection. Use a barrier so attempts overlap. If native teardown makes `worker_threads` unreliable, use the existing compiled child-process contender pattern, while retaining truly independent connections.

Inject a deterministic failure after each phase and compare stable ordered snapshots of every affected table before/after: cycle insert/CAS, enrollment insert/update/stop, replacement action insert, terms/rules/receipt insert, StageEvent append, old-action settlement, and final postcondition. Every failure leaves byte-for-byte equivalent rows and no consumed rule, orphan receipt, pending replacement, partial qualification change, or source mutation.

- [ ] **Step 7: Run the complete RED lifecycle slice**

Run:

```bash
npx vitest run \
  tests/main/domainConstraints.test.ts \
  tests/main/eventRepository.test.ts \
  tests/main/identityRepository.test.ts \
  tests/main/salesCycleRepository.test.ts \
  tests/main/cadenceEnrollmentRepository.test.ts \
  tests/main/reactivationRepository.test.ts \
  tests/main/lifecycleReviewRepository.test.ts \
  tests/main/lifecycleService.test.ts \
  tests/main/nextActionInvariant.test.ts \
  tests/main/invariantAudit.test.ts \
  tests/integration/concurrentCycleInvariant.test.ts
```

Expected: FAIL because lifecycle modules are absent.

- [ ] **Step 8: Harden schema/types and implement persistence-only repositories**

Add the schema changes proven in Steps 1-2, including rollback statements in exact reverse dependency order and the new table in the typed schema/manifest. Because no later migration has shipped, amend `0002DomainFoundation`; do not add `0003` or weaken Task 4's backup gate. Add `StaleDomainWriteError` and typed lifecycle/idempotency/eligibility/evidence conflicts to `domainErrors.ts`.

Implement the exact Step 2 repository methods and durable Review persistence using plain `INSERT`, targeted CAS `UPDATE`, strict Zod parsing of inputs and every stored row/JSON value, injected clock/IDs, stable read ordering, and targeted conflict handling. Reads may run outside a transaction; every mutator starts with `unitOfWork.assertWriteScope()`.

Add IdentityRepository's optimistic Prospect qualification mutation. It requires expected Person/Prospect/version/state and never rewrites original attribution. Add EventRepository and Task 8 CadenceRepository binding assertions; lifecycle construction fails before writes for every database/UoW permutation that does not use the same objects.

Before plain cycle insertion, read the canonical Prospect and operational cycle under the same `BEGIN IMMEDIATE` lock. A second contender therefore observes the first commit and returns a typed already-open conflict; the partial unique index remains defense in depth and is never translated by message parsing.

- [ ] **Step 9: Implement transaction-scoped and transaction-owning lifecycle surfaces**

Define one synchronous `LifecycleTransactionWriter` whose methods require the caller's already-active exact-UoW scope. Define `LifecycleService` as thin wrappers that each call `unitOfWork.immediate(() => writer.command(input))` exactly once. Runtime and TypeScript reject PromiseLike callbacks through the existing UoW contract.

```ts
export interface LifecycleCommands {
  createUnreviewedCycle(input: CreateUnreviewedCycleInput): SalesCycle;
  reviewToReady(input: ReviewToReadyInput): SalesCycle;
  recordQualifyingContact(input: RecordContactInput): SalesCycle;
  confirmInterviewed(input: ConfirmInterviewedInput): SalesCycle;
  confirmOffered(input: ConfirmOfferedInput): SalesCycle;
  confirmWon(input: ConfirmWonInput): SalesCycle;
  completeCurrentAction(input: CompleteCurrentActionInput): SalesCycle;
  closeLostNurture(input: CloseLostNurtureInput): SalesCycle;
  completeOnboarding(input: CompleteOnboardingInput): SalesCycle;
  reactivateFromRule(input: ReactivateFromRuleInput): ReactivationResult;
  reactivateFromInboundResponse(input: ReactivateFromInboundInput): ReactivationResult;
  setDesignPartnerFitness(input: SetDesignPartnerFitnessInput): SalesCycle;
  setCloseReadiness(input: SetCloseReadinessInput): CloseReadiness;
}

export interface LifecycleTransactionCommands extends LifecycleCommands {
  closeForOptOut(input: CloseForOptOutInput): SalesCycle | null;
}

export class LifecycleService implements LifecycleCommands {
  scopedWriter(): LifecycleTransactionCommands; // asserts active exact-UoW scope
}
```

The public service does not expose a transaction-owning `closeForOptOut` that Task 10 could accidentally nest. Task 10 owns one immediate transaction, obtains `scopedWriter()`, stops/closes/cancels first, and only then inserts the permanent tombstone. Every scoped command asserts the active UoW again and calls the full postcondition before returning.

- [ ] **Step 10: Implement legal transitions and deterministic event projection**

Encode the fixed transition table as data and reject every unlisted edge before allocating IDs or reading the clock. `createUnreviewedCycle` accepts only the canonical unreviewed Prospect and a pre-existing Person-owned entry SourceEvent, then creates a review action and initial StageEvent atomically. `reviewToReady` qualifies the Prospect, resolves the Task 8 catalog version, starts A/B/C, and installs the first cadence action.

Every new action receives its immutable work intent at creation. The initial
Unreviewed action is `internal_review`; the initial untouched Ready A/B/C action
and rule-reactivation entry are `discretionary_prospecting`; inbound demo,
direct-referral, and reply interrupts are `inbound_response`; onboarding,
Post-Interview, Post-Offer, and later prospecting steps are
`promised_follow_up`. A replacement, resolver, retry, or reschedule cannot infer
or rewrite intent after the fact. Inbound creation computes and persists its
strict SLA union once from the owned SourceEvent and injected policy snapshot;
Task 12 reads that evidence and never recomputes the deadline.

`recordQualifyingContact` validates the immutable Activity and outcome before mechanically emitting Contacted. Already-Contacted cycles advance the cadence without duplicating Contacted. Founder-confirmed Interviewed/Offered commands validate suggestions/evidence but never accept an automatic transition. When Contacted was skipped, append its backfill event at sequence N followed by the founder target at N+1 with the same business timestamp and explicit provenance.

Won persists calculated terms, stops Post-Offer, starts Onboarding, installs its first action, emits one Offered -> Won event, and changes workflow to onboarding. Completing or explicitly waiving the final onboarding component with a nonblank reason stops onboarding, clears the pointer, and closes Won without emitting Won -> Won.

- [ ] **Step 11: Implement exact cyclic creation, action replacement, and closure order**

For a new cycle without a cadence, use:

```text
allocate stable cycle/action/event IDs
insert sales_cycle pointing to the future pending action
insert pending next_action
append initial StageEvent sequence 1
assert full postcondition
commit deferred cycle/action FKs
```

For a new Ready/onboarding cycle with a cadence, insert the cycle first, then enrollment, then referenced action. The source event pre-exists. Never insert a SourceEvent/cycle pair that depends on the immediate reciprocal `source_events.sales_cycle_id` FK; `entry_source_event_id` is the activation authority.

For a Task 8 `reschedule_current` result, CAS-update the same pending current action using its expected version/status/due date, keep the pointer unchanged, record the required failure Activity, apply the zero-count enrollment retry mutation, and assert the postcondition. Do not create or settle an action.

The reschedule CAS includes expected immutable `work_intent`, inbound-SLA kind,
due, source, and canonical provenance predicates and leaves them byte-identical;
Task 8's independent cadence `sla_due_at` remains governed by its recipe.

For replacement inside an existing cycle, use:

```text
validate input/evidence and pure TransitionRecipe
insert or CAS the required enrollment state
insert the replacement pending action
CAS cycle stage/workflow/current pointer using expected version/stage/action
append consecutive StageEvent rows when the stage changes
complete/cancel/mark-impossible the old action only after pointer movement
assert full postcondition
```

`CompleteCurrentActionInput` always includes `expectedCycleVersion`, `expectedCurrentActionId`, exact Task 8 outcome, and immutable Activity/evidence when applicable. It never completes "whatever is current." Failed delivery follows Task 8's retry recipe; unavailable channel creates `resolve_contact_method` tied to the same definition/step/component; impossible requires reason/evidence; breakup is never skipped except by explicit impossible disposition.

For closure, use:

```text
stop the active enrollment
insert Won terms or exact reactivation rules/receipt as applicable
CAS final stage/workflow/current pointer to closed/null
append the terminal StageEvent or onboarding system evidence
settle the old action only after pointer clearance
assert full postcondition
```

All generated rows roll back if any later write, event append, settlement, postcondition, or deferred-FK commit fails.

- [ ] **Step 12: Apply Task 8 TransitionRecipe and reactivation semantics**

Task 9 passes strict stored catalog/enrollment/action data, injected evaluation time/timezone/policy snapshot, total prospecting scheduled-step count, highest cap, and last completed communication into Task 8. It validates the returned `TransitionRecipe` but never recalculates its schedule or outcome branch. The recipe atomically controls old-action disposition, enrollment current step/count/status, stop/upgrade reason, exactly one next-action draft or terminal result, resolver/retry state, and reactivation drafts.

Cadence exhaustion may close Lost-Nurture only after the required breakup is delivered or explicitly impossible and the attempt cap is exhausted. Persist Task 8's exact A/B defaults or a valid founder replacement. A `stop: replied` recipe is not terminal lifecycle closure: it enters the inbound response/booking lane with a replacement action. Opt-out delegates to Task 10's scoped transaction path.

Rule reactivation and inbound-response activation use their deterministic receipt key and caller-supplied stable new-cycle ID. Read, parse, and compare a pre-existing receipt or blocked-activation Review item before calling `ids.next()` or the default clock. On first execution, create Ready/Contacted as required, start the appropriate cadence/inbound interrupt, create a valid current action, CAS rule consumption when applicable, and insert the receipt atomically. If eligibility/open-cycle/opt-out conditions fail, persist/reuse typed Review work and leave the rule unconsumed.

- [ ] **Step 13: Implement the full read-only invariant audit**

`auditDomainInvariants()` must not mutate, stop at the first malformed row, or throw because one row is corrupt. It returns every typed violation in stable kind/record-ID order and checks:

- exactly one canonical Prospect per Person and at most one active/onboarding cycle per Person;
- open/closed stage-workflow compatibility, closed timestamp/reason/notes, and current-pointer nullability;
- a non-null pointer owns the cycle, references a pending due-dated action, and has parseable timezone/window data;
- every current action has a supported immutable work intent; inbound-response actions have one ownership-valid strict SLA union; non-inbound actions have no inbound SLA; and resolver/retry/reschedule actions retain their originating intent and SLA evidence;
- initial/contiguous StageEvent sequence, exact from/to chain, legal edges, and projection stage/`stage_entered_at` matching the final event;
- Unreviewed has no active cadence and a review action; Ready/Contacted has one active A/B/C; Interviewed has Post-Interview; Offered has Post-Offer; Won/onboarding has Onboarding; closed has none;
- enrollment definition/current-step/count/status and current action definition/step/component share one Task 8 graph and obey attempt caps;
- Lost-Nurture reason/`other` notes and exact reactivation cardinality; one-way consumption and receipt ownership/canonical envelopes;
- blocked reactivation has one durable, ownership-valid, canonical Review item and no consumed rule/new cycle;
- Won terms/formula projection, close-readiness strict envelope/version, and design-fitness history;
- opted-out/tombstoned Persons have no open outbound workflow, active cadence, or current outbound action; and
- P0 projections/overrides still require Direct reachability.

Only the authoritative pointer drives Today. Unreferenced pending supplemental tasks may coexist and are not silently promoted. The audit and lifecycle queries preserve separate Fit/Timing/priority fields and never compute or sort by a blended score.

- [ ] **Step 14: Run GREEN lifecycle verification and scope regression checks**

Run:

```bash
npx vitest run \
  tests/main/domainConstraints.test.ts \
  tests/main/eventRepository.test.ts \
  tests/main/identityRepository.test.ts \
  tests/main/salesCycleRepository.test.ts \
  tests/main/cadenceEnrollmentRepository.test.ts \
  tests/main/reactivationRepository.test.ts \
  tests/main/lifecycleReviewRepository.test.ts \
  tests/main/lifecycleService.test.ts \
  tests/main/nextActionInvariant.test.ts \
  tests/main/invariantAudit.test.ts \
  tests/integration/concurrentCycleInvariant.test.ts \
  tests/main/builtinCadences.test.ts \
  tests/main/cadenceRepository.test.ts \
  tests/main/cadenceScheduler.test.ts \
  tests/main/cadencePlanner.test.ts
npm run typecheck
npm run lint
npm run test
npm run package
```

Expected: schema, event, identity, cadence, lifecycle, invariant, concurrency, full-suite, and packaged verification PASS. Failed/stale commands leave byte-for-byte equivalent domain rows. Re-scan the Task 9 implementation diff for newly introduced `score`, `0-100`, raw `Date.now`, SQL `now`, nested `immediate`, broad `ON CONFLICT`, or error-message parsing and find none.

- [ ] **Step 15: Commit lifecycle foundation**

Run:

```bash
git add \
  src/main/db/migrations/0002DomainFoundation.ts \
  src/main/db/domainSchema.ts \
  src/main/domain/support/domainErrors.ts \
  src/main/domain/events \
  src/main/domain/identity \
  src/main/domain/lifecycle \
  tests/main/domainConstraints.test.ts \
  tests/main/eventRepository.test.ts \
  tests/main/identityRepository.test.ts \
  tests/main/salesCycleRepository.test.ts \
  tests/main/cadenceEnrollmentRepository.test.ts \
  tests/main/reactivationRepository.test.ts \
  tests/main/lifecycleReviewRepository.test.ts \
  tests/main/lifecycleService.test.ts \
  tests/main/nextActionInvariant.test.ts \
  tests/main/invariantAudit.test.ts \
  tests/integration/concurrentCycleInvariant.test.ts \
  tests/support/domainSchemaScenario.ts \
  tests/support/domainWriteWorker.ts
git commit -m "feat: enforce lifecycle next actions"
```

### Task 10: Enforce Person-Wide Opt-Out and Source-Preserving Closure

**Files:**
- Modify: `src/main/db/migrations/0002DomainFoundation.ts`
- Modify: `src/main/db/domainSchema.ts`
- Modify: `src/main/domain/support/domainErrors.ts`
- Modify: `src/main/domain/identity/identityRepository.ts`
- Modify: `src/main/domain/lifecycle/lifecycleTypes.ts`
- Modify: `src/main/domain/lifecycle/lifecycleTransactionWriter.ts`
- Modify: `src/main/domain/lifecycle/lifecycleService.ts`
- Create: `src/main/domain/optOut/optOutTypes.ts`
- Create: `src/main/domain/optOut/optOutRepository.ts`
- Create: `src/main/domain/optOut/optOutService.ts`
- Create: `src/main/domain/optOut/outboundPermissionService.ts`
- Modify: `tests/main/domainConstraints.test.ts`
- Modify: `tests/main/domainSchema.test.ts`
- Modify: `tests/main/identityRepository.test.ts`
- Modify: `tests/main/lifecycleService.test.ts`
- Modify: `tests/support/domainSchemaScenario.ts`
- Modify: `tests/support/domainWriteWorker.ts`
- Create: `tests/main/optOutRepository.test.ts`
- Create: `tests/main/optOutService.test.ts`
- Create: `tests/integration/optOutPersistence.test.ts`
- Create: `tests/integration/concurrentOptOutInvariant.test.ts`

**Interfaces:**
- Consumes: the exact Task 9 `LifecycleService`, its transaction-scoped
  `LifecycleTransactionCommands`, Identity/Event repositories bound to the same
  `AppDatabase` and `DomainUnitOfWork`, canonical Task 7 phone/email
  normalization, injected `Clock`/`IdGenerator`, and immutable Activity
  evidence.
- Produces: an indefinite Person tombstone, immutable blocked handles, one
  atomic application/propagation service, and the only database-level outbound
  permission API. Task 12 uses the read-only inspection result while every
  future typed outbound execution command uses the transaction-required check.
- Boundary: Task 10 owns exactly one synchronous `unitOfWork.immediate` per
  public mutation. It never calls a transaction-owning lifecycle method;
  instead it obtains `lifecycle.scopedWriter()` inside its active transaction.
  All constructors reject mixed database/UoW instances before reads or ID/clock
  consumption. SQL never reads current time and no method parses SQLite error
  text or broadly suppresses a constraint.
- Product lock: opt-out is Person-wide, permanent, and most restrictive. It
  blocks the Person and every retained/current phone/email handle. It never
  rewrites or deletes Activity, SourceEvent, Prospect attribution, historical
  cycles, Won terms, or other evidence.
- Reactivation lock: `never` is a semantic terminal policy, not a database row.
  The four stored rule types remain exactly `seasonal:heating-oct1`,
  `new-frbo-listing`, `lead-cert-expiry-window`, and `manual`. An opt-out closure
  creates zero reactivation rows; historical immutable rules remain evidence
  but can never reactivate a tombstoned Person.
- Communication boundary: Task 10 supplies the authoritative transaction-time
  database gate but does not claim to serialize an asynchronous Messages,
  Phone, or Gmail handoff. The communication integration plan must implement
  the shared outbound-readiness barrier and define the provider-handoff
  linearization point. It must recheck this gate under that barrier. Holding the
  synchronous domain UoW open across an async adapter call is forbidden.

- [ ] **Step 1: Write RED schema hardening tests**

Extend schema/migration tests before repository or service code. Require:

- `opt_out_tombstones.source_activity_id` is required and references an exact
  same-Person immutable Activity; `requested_at`/`created_at` are canonical UTC;
  observed channel is exactly `manual | imessage | gmail | call |
  identity_propagation`; policy version is nonblank;
- blocked phone/email values are nonblank canonical values at the repository
  boundary and stable lookup remains non-unique globally because one handle may
  conservatively appear under more than one immutable tombstone;
- inserting a tombstone fails while the Person has any active/onboarding cycle,
  active cadence enrollment, current action, or other pending outbound action;
- inserting or owner-moving a SalesCycle into `active`/`onboarding` fails when
  either the Person projection or tombstone is opted out;
- inserting or owner-moving a pending NextAction whose `channel IS NOT NULL`
  fails for an opted-out/tombstoned cycle owner; internal channel-null Review or
  audit work remains representable;
- inserting or owner-moving a contact method onto an opted-out/tombstoned
  Person requires the exact `(kind, normalized_value)` to be retained under
  that Person's tombstone first, so future relinking cannot introduce an
  unretained handle;
- active-cadence insert/update guards from Task 5 and the Task 8 owner graph
  remain intact; and
- tombstones and handles reject `UPDATE`, `DELETE`, same-primary-key
  `INSERT OR REPLACE`, unique-Person `INSERT OR REPLACE`, and unique-handle
  `INSERT OR REPLACE` with `recursive_triggers=ON`.

Add exact trigger names to the manifest and mutation matrix. Prove a late
schema-2 failure rolls back to the prior exact schema and a clean retry creates
all guards.

- [ ] **Step 2: Write RED strict repository and binding tests**

Define these persistence contracts in the tests:

```ts
export type OptOutObservedChannel =
  | 'manual' | 'imessage' | 'gmail' | 'call' | 'identity_propagation';

export type OptOutTombstone = {
  id: string;
  personId: string;
  requestedAt: string;
  observedChannel: OptOutObservedChannel;
  sourceActivityId: string;
  evidenceRef: string | null;
  policyVersion: string;
  createdAt: string;
};

export type OptOutHandle = {
  id: string;
  tombstoneId: string;
  kind: 'phone' | 'email';
  normalizedValue: string;
  createdAt: string;
};

export type InsertOptOutTombstoneInput = OptOutTombstone;
export type InsertOptOutHandleInput = OptOutHandle;

export class OptOutRepository {
  constructor(input: {
    database: AppDatabase;
    unitOfWork: DomainUnitOfWork;
  });
  assertBoundTo(database: AppDatabase, unitOfWork: DomainUnitOfWork): void;
  insertTombstone(input: InsertOptOutTombstoneInput): OptOutTombstone;
  insertBlockedHandle(input: InsertOptOutHandleInput): OptOutHandle;
  getForPerson(personId: string): OptOutTombstone | null;
  getById(tombstoneId: string): OptOutTombstone | null;
  listBlocksForHandle(
    kind: 'phone' | 'email',
    normalizedValue: string,
  ): OptOutTombstone[];
  listHandles(tombstoneId: string): OptOutHandle[];
}
```

Mutations require the repository's active exact-UoW scope; reads are allowed
outside it. Constructor and `assertBoundTo` reject every database/UoW
permutation by identity. Parse every stored ID, enum, canonical UTC
timestamp, policy string, and phone/email normalized value on every read.
`listBlocksForHandle` returns every match in stable `requested_at, id` order;
permission treats any match as blocked rather than choosing an arbitrary row.

Exact same-ID/same-content insert retries may return the canonical stored row.
Same-ID changed content, same-Person changed tombstone content, and same
tombstone/kind/value with a changed row ID throw typed persistence conflicts.
Do not use `INSERT OR IGNORE`, broad `ON CONFLICT`, or SQLite-message matching.
Add `IdentityRepository.listContactMethodsForPerson(personId)` as a strict,
stable kind/value/ID-ordered read so the service never trusts a caller-supplied
subset of handles.

- [ ] **Step 3: Write RED lifecycle-before-tombstone service tests**

Use strict discriminated evidence and result types:

```ts
export type OptOutEvidence =
  | { kind: 'existing_activity'; activityId: string }
  | {
    kind: 'append_activity';
    activity: AppendActivityInput & { id: string; occurredAt: string };
  };

export type ApplyOptOutInput = {
  personId: string;
  tombstoneId: string;
  requestedAt: string;
  policyVersion: 'founder_opt_out_v1';
  decision:
    | { kind: 'structured_written'; channel: 'imessage' | 'gmail' }
    | { kind: 'founder_confirmed'; channel: 'manual' | 'call' };
  evidence: OptOutEvidence;
  terminalStageEventId: string | null;
};

export type ApplyOptOutResult = {
  tombstone: OptOutTombstone;
  handles: OptOutHandle[];
  cycle: SalesCycle | null;
  alreadyApplied: boolean;
};

export type OptOutFaultPoint =
  | 'after_activity'
  | 'after_lifecycle_close'
  | 'after_tombstone'
  | 'after_handle'
  | 'after_postcondition';

export class OptOutService {
  constructor(input: {
    database: AppDatabase;
    unitOfWork: DomainUnitOfWork;
    identities: IdentityRepository;
    events: EventRepository;
    optOuts: OptOutRepository;
    lifecycle: LifecycleService;
    clock: Clock;
    ids: IdGenerator;
    faultInjector?: (point: OptOutFaultPoint) => void;
  });
  apply(input: ApplyOptOutInput): ApplyOptOutResult;
  propagateMostRestrictiveOptOut(
    input: PropagateOptOutInput,
  ): ApplyOptOutResult;
  recordPastOffAppTouch(input: RecordPastOffAppTouchInput): Activity;
}
```

An existing/appended Activity must belong to the exact Person, represent a
received or founder-recorded opt-out, and retain its original
Prospect/SalesCycle ownership. Exact structured iMessage/Gmail opt-out applies
without model interpretation. Transcript/LLM inference alone is rejected;
`call` requires the founder-confirmed branch. The separate temporary quarantine
and Review flow for ambiguous language remains in the communication/analysis
plan.

Task 10 consumes this exact transaction-scoped lifecycle seam:

```ts
export type CloseForOptOutInput = {
  personId: string;
  evidenceActivityId: string;
  effectiveAt: string;
  terminalStageEventId: string | null;
};

export type CloseForOptOutResult = {
  cycle: SalesCycle | null;
  stoppedEnrollmentIds: string[];
  cancelledActionIds: string[];
};

interface LifecycleTransactionCommands {
  closeForOptOut(input: CloseForOptOutInput): CloseForOptOutResult;
}
```

`LifecycleService.assertBoundTo(database, unitOfWork)` is required so
`OptOutService` rejects mixed composition before appending evidence.
`closeForOptOut` asserts the already-active scope and, for the one operational
cycle, performs this exact order:

```text
stop active enrollment
CAS stage/workflow/current pointer to the terminal projection
append a terminal StageEvent only for pre-Won -> Lost-Nurture
settle/cancel the former current action after pointer clearance
cancel every other pending channel-nonnull outbound action for the Person
assert lifecycle/action/enrollment postconditions
```

Pre-Won means Unreviewed through Offered and closes as
Lost-Nurture/`opt_out`, with zero reactivation rows. Won/onboarding remains Won,
closes with `onboarding_stop_reason=opt_out`, preserves Won terms/metrics, and
does not append a second Won StageEvent. Closed historical cycles and their
sources/events remain unchanged.

Test no-cycle application, every pre-Won stage, Won/onboarding, a compound
cadence action, an unreferenced supplemental outbound action, no active cadence
on Unreviewed, and already-closed history. Assert the lifecycle writer completes
before the tombstone insert and the schema would reject the reverse order.

`terminalStageEventId` is required exactly when an operational pre-Won cycle
will transition to Lost-Nurture. It must be null for no-cycle, already-closed,
and Won/onboarding closure. Reject the opposite cardinality before writes.

The critical Won assertion remains:

```ts
expect(result.cycle).toMatchObject({ stage: 'won', workflowStatus: 'closed' });
expect(result.cycle).not.toMatchObject({ stage: 'lost_nurture' });
```

- [ ] **Step 4: Write RED atomic application, replay, and handle-capture tests**

`OptOutService.apply` owns exactly one immediate transaction and performs:

```text
1. strictly parse/normalize the complete command before writes
2. append or load immutable source Activity evidence
3. re-read Person, canonical tombstone, all current handles, and operational
   lifecycle state under BEGIN IMMEDIATE
4. call lifecycle.scopedWriter().closeForOptOut(...)
5. insert or load the canonical tombstone
6. let the tombstone trigger set persons.opted_out/opted_out_at/version
7. insert/compare every missing handle in stable kind/value order
8. assert the full opt-out/lifecycle/source/Won postcondition
```

There is no direct `markPersonProjectionOptedOut` repository API. The tombstone
trigger is the only projection mutation, preventing an opted-out projection
from temporarily coexisting with an active workflow and preventing a double
version increment.

Repeated exact provider evidence returns canonical Activity/tombstone/handle
rows without consuming default IDs or clock values. A later legitimate opt-out
observation appends its own immutable Activity, retains the earliest canonical
tombstone, captures any newly known handles, and reasserts terminal
postconditions. All known normalized phone/email handles are retained regardless
of current validation, reachability, primary, or Contacts metadata.

Test failure on every ownership mismatch, malformed timestamp, unsupported
policy version, missing Activity, model-only verbal inference, and changed
same-ID evidence. Compare SourceEvents, original Prospect attribution,
historical Activities, StageEvents, and Won terms before/after to prove
source-preserving closure.

- [ ] **Step 5: Write RED permission, render, and audit-logging tests**

Use separate inspection and authoritative execution APIs:

```ts
export type OutboundPermission =
  | { kind: 'allowed' }
  | {
    kind: 'blocked';
    tombstoneIds: string[];
    matchedHandles: Array<{
      kind: 'phone' | 'email';
      normalizedValue: string;
    }>;
  };

export class OutboundPermissionService {
  constructor(input: {
    database: AppDatabase;
    unitOfWork: DomainUnitOfWork;
    identities: IdentityRepository;
    optOuts: OptOutRepository;
  });
  assertBoundTo(database: AppDatabase, unitOfWork: DomainUnitOfWork): void;
  inspectPerson(personId: string): OutboundPermission;
  assertMayContactPerson(personId: string): void;
  assertMayContactHandle(
    kind: 'phone' | 'email',
    normalizedValue: string,
  ): void;
  assertMayExecuteOutbound(input: {
    personId: string;
    target: { kind: 'phone' | 'email'; normalizedValue: string };
  }): void;
}
```

Construction and `assertBoundTo` require the service, both repositories, and
the active transaction scope to share the exact `AppDatabase` and
`DomainUnitOfWork`; mixed composition fails before any permission read.
`inspectPerson` and the two read assertions query the Person tombstone and every
current handle on each call; they never trust `persons.opted_out`, a cached Today
row, or only the requested Person ID. They normalize and fail closed on invalid
targets. `assertMayExecuteOutbound` additionally requires the service's active
exact-UoW scope and checks both Person and exact target handle immediately before
the future typed outbound command creates/hands off work. A block throws typed
`OutboundContactBlockedError` containing only stable IDs/reason codes, never
contact values.

Task 12 must call `inspectPerson` while building Today and omit a blocked row;
SQL projection filtering is only the first safeguard. A stale Today click or
other call/text/email entry point must call `assertMayExecuteOutbound` again.

A call selected from Task 12's discretionary lanes carries this strict receipt
through the authoritative execution boundary and into the resulting immutable
Activity metadata:

```ts
export type TodaySelectedCallReceiptV1 = {
  version: 1;
  kind: 'discretionary_call';
  currentActionId: string;
  queueGeneratedAt: string;
  queueTimezone: string;
  queueLocalDate: string; // YYYY-MM-DD in queueTimezone
};
```

The receipt is forbidden for promise/onboarding/inbound rows and for non-call
actions. Its action must still be the Person-owned pending authoritative
current action at execution time. Provider/idempotency replay returns the same
Activity and receipt; changed action, queue instant/timezone/date, or receipt
kind conflicts. This Activity is Task 12's durable evidence that one daily
discretionary dial slot was consumed. Retrospective evidence after opt-out may
record what happened but never fabricates this selection receipt.

Distinguish execution from evidence: scheduling, sending, or a combined
log-and-execute command hard-blocks. A deliberately named retrospective
`recordPastOffAppTouch` path may append an immutable outbound Activity after
opt-out, because suppressing a prohibited touch would destroy audit truth; it
must mark strict metadata such as `{ reportedAfterOptOut: true,
prohibitedTouchReported: true }` and never invoke an adapter or create a pending
outbound action. Its exact contract is:

```ts
export type RecordPastOffAppTouchInput = {
  personId: string;
  reportedAt: string;
  activity: AppendActivityInput & {
    id: string;
    occurredAt: string;
    direction: 'outbound';
  };
};
```

The service requires `occurredAt <= reportedAt`, overwrites rather than trusts
the two audit metadata flags, and owns one immediate transaction that only
appends/loads the immutable Activity. Future-dated records are rejected.

- [ ] **Step 6: Write RED permanence and propagation-boundary tests**

Opt-out data is retained indefinitely. Physical Person deletion remains
foreign-key blocked while a tombstone exists; V1 deletion is soft/minimizing
and retains the minimal Person stub, tombstone, handles, source Activity, request
time, observed channel, evidence reference, and policy version. Startup audit
must report rather than silently repair any tombstone/Person projection
mismatch. Database reopen with the same key must retain the block.

Add the narrow future-identity hook now, without inventing a merge engine:

```ts
export type PropagateOptOutInput = {
  sourceTombstoneId: string;
  targetPersonId: string;
  targetTombstoneId: string;
  evidenceActivity: AppendActivityInput & { id: string; occurredAt: string };
  terminalStageEventId: string | null;
};

OptOutService.propagateMostRestrictiveOptOut(
  input: PropagateOptOutInput,
): ApplyOptOutResult;
```

The hook runs in one transaction, requires an internal same-target-Person
`identity_propagation` Activity, preserves the source tombstone, copies the
source's earliest request/policy semantics, unions source and target known
handles under the target tombstone, and closes target workflow through the same
scoped writer before target tombstone insertion. If the target already has any
tombstone, retain that canonical target row regardless of chronology; the
immutable source row still preserves any earlier request, and the command only
adds missing handles/evidence.

Test the hook directly for both source-opted/target-clean and both-opted cases.
Full Person merge, identity-relink orchestration, and portable encrypted restore
remain outside this foundation because those commands do not exist yet; their
future transactions must call this hook before finalizing identity projection
changes. Task 10 acceptance instead proves close/reopen persistence and
delete/re-import safety: a fresh Person with a handle retained by any old
tombstone is blocked by `inspectPerson`/execution permission even before a
propagation command materializes its Person projection.

Extend Task 9's result union in Task 10 with:

```ts
type ReactivationResult =
  | { kind: 'reactivated'; cycle: SalesCycle }
  | { kind: 'review_required'; reviewItem: LifecycleReviewItem }
  | { kind: 'permanently_blocked'; tombstoneId: string };
```

An attempted reactivation of a tombstoned Person returns
`permanently_blocked`, never consumes a historical rule, and never creates a
Review item, cycle, or action. It does not insert a fifth rule type or a `never`
row.

- [ ] **Step 7: Write RED independent-connection and fault-injection tests**

Use Task 9's compiled worker/child contender with two separately keyed
production database connections and an exact barrier. Cover both serializations
of:

- two exact opt-out applications for one Person: one canonical tombstone,
  unioned handles, canonical results, no raw uniqueness error;
- opt-out versus current-action replacement: if opt-out wins, replacement sees
  the tombstone and fails; if replacement wins, opt-out re-reads and cancels the
  replacement; both end closed with no pending outbound action;
- opt-out versus Ready/open-cycle creation or rule/inbound reactivation: no
  operational cycle or consumed rule survives the opt-out linearization;
- opt-out versus a new contact/re-import on the same normalized handle: either
  the handle is captured before the identity write or the permission lookup
  blocks the new Person by the prior tombstone; and
- two Persons independently retaining the same handle: both tombstones remain
  immutable and every permission path blocks deterministically.

The configured busy timeout must serialize contenders; raw `SQLITE_BUSY`,
constraint-message parsing, a zombie cycle, and an orphan pending action are not
domain outcomes.

Inject deterministic failures at:

```text
after source Activity
after lifecycle scoped-writer return
after tombstone insert/Person projection trigger
after each blocked-handle insert
after final postcondition
```

For each point compare stable ordered snapshots of Persons, contact methods,
Activities, SourceEvents, Prospects, SalesCycles, StageEvents,
CadenceEnrollments, NextActions, ReactivationRules, Won terms, tombstones, and
handles. Failure, including deferred-FK commit failure, leaves byte-equivalent
state with no partial block, consumed rule, changed source attribution, lost Won
metric, or orphan workflow. Task 9 already proves the writer's internal
stop/pointer/event/settlement fault points; Task 10 must invoke those configured
faults through `closeForOptOut` to prove the outer transaction also rolls back
its evidence.

Do not mislabel this database race as the external provider send race. The
communication integration plan owns a shared outbound-readiness barrier that
serializes fresh inbound delta sync, this transaction-time permission gate, and
the synchronous provider handoff boundary. It must cover an opt-out received
while Callie was closed and an opt-out concurrent with handoff. If handoff was
already linearized externally, later evidence records the truth rather than
rewriting history.

For a Today-selected discretionary call, that same barrier validates the strict
`TodaySelectedCallReceiptV1` against the still-current action immediately before
handoff. Once the provider accepts the handoff, the communication path appends
or idempotently recovers the immutable call Activity with the exact receipt and
provider key. A failed permission/current-action check consumes no receipt; a
crash after external acceptance is recovered by the same caller-stable Activity
ID/provider key, so refresh/restart cannot reset or double-count daily capacity.

- [ ] **Step 8: Run the complete RED opt-out slice**

Run:

```bash
npx vitest run \
  tests/main/domainConstraints.test.ts \
  tests/main/domainSchema.test.ts \
  tests/main/identityRepository.test.ts \
  tests/main/lifecycleService.test.ts \
  tests/main/optOutRepository.test.ts \
  tests/main/optOutService.test.ts \
  tests/integration/optOutPersistence.test.ts \
  tests/integration/concurrentOptOutInvariant.test.ts
```

Expected: focused failures for absent opt-out modules, insufficient schema
guards, missing lifecycle binding/closure result, and missing permission and
propagation contracts. Record the exact RED evidence before production changes.

- [ ] **Step 9: Implement schema and lifecycle guardrails**

Add the tested schema checks/triggers and exact Kysely types. Keep tombstone and
handle immutability append-only. The tombstone insert trigger must require
lifecycle closure before the AFTER INSERT Person synchronization trigger runs.
The Person projection remains derived from the canonical tombstone.

Finish the Task 9 scoped seam exactly as tested: add
`LifecycleService.assertBoundTo`; return `CloseForOptOutResult`; use repository
CAS methods and the pointer-before-settlement order; cancel all remaining
pending channel-nonnull actions for the Person; run the full lifecycle
postcondition. Do not add a public transaction-owning `closeForOptOut` wrapper.

- [ ] **Step 10: Implement strict tombstone persistence**

Implement `optOutTypes.ts` and `OptOutRepository` exactly to the Step 2
contracts. Reuse Task 7's exported `normalizePhone`/`normalizeEmail` and require
stored normalized bytes to equal their normalized form. Return new arrays/plain
objects so callers cannot mutate repository state. Exact retry comparison covers
every supplied field.

- [ ] **Step 11: Implement atomic application and propagation**

Implement `OptOutService.apply` in the exact Step 4 order and
`propagateMostRestrictiveOptOut` in the exact Step 6 order. Constructor binding
checks run before any replay read. All mutations use the service's one immediate
transaction. A fault callback receives only the enumerated Step 7 points.

The final postcondition independently queries the authoritative database. It
requires the canonical Person/tombstone timestamp pair, every current handle,
zero operational cycles, zero active enrollments, zero pending channel-nonnull
actions, zero newly created opt-out reactivation rules, retained evidence and
sources, and unchanged Won terms. Any malformed stored row fails closed.

- [ ] **Step 12: Implement the permission boundary**

Implement `OutboundPermissionService` exactly to Step 5. Stable block results
sort/deduplicate tombstone IDs and matched handle facts. Errors expose only
stable IDs/reason codes. `assertMayExecuteOutbound` calls
`unitOfWork.assertWriteScope()` before reads. Add the explicit retrospective
audit helper or service command; do not weaken `EventRepository.appendActivity`
globally because append-only truth must remain recordable.

- [ ] **Step 13: Run GREEN opt-out verification and scope scans**

Run:

```bash
npx vitest run \
  tests/main/domainConstraints.test.ts \
  tests/main/domainSchema.test.ts \
  tests/main/identityRepository.test.ts \
  tests/main/lifecycleService.test.ts \
  tests/main/nextActionInvariant.test.ts \
  tests/main/invariantAudit.test.ts \
  tests/main/optOutRepository.test.ts \
  tests/main/optOutService.test.ts \
  tests/integration/optOutPersistence.test.ts \
  tests/integration/concurrentOptOutInvariant.test.ts
npm run typecheck
npm run lint
npm run test
```

Expected: schema, repository, lifecycle, permission, retention, reopen,
concurrency, fault, full-suite, typecheck, and lint PASS. Opted-out Persons have
no operational workflow or pending outbound action; Won remains Won; zero
`never` rows exist.

Run `git diff --check`. Scan the Task 10 diff for blended score/0-100 ranking,
raw `Date.now`, SQL current-time functions, nested `immediate`, broad
`ON CONFLICT`/`OR IGNORE`, SQLite error-message parsing, adapter/UI imports, and
production deletion/update of tombstones or handles; find none. Packaged
verification may remain omitted because Task 10 is uncomposed until Task 13 and
does not implement the deferred communication barrier or a native boundary.

- [ ] **Step 14: Commit opt-out enforcement**

Run:

```bash
git add \
  src/main/db/migrations/0002DomainFoundation.ts \
  src/main/db/domainSchema.ts \
  src/main/domain/support/domainErrors.ts \
  src/main/domain/identity/identityRepository.ts \
  src/main/domain/lifecycle/lifecycleTypes.ts \
  src/main/domain/lifecycle/lifecycleTransactionWriter.ts \
  src/main/domain/lifecycle/lifecycleService.ts \
  src/main/domain/optOut \
  tests/main/domainConstraints.test.ts \
  tests/main/domainSchema.test.ts \
  tests/main/identityRepository.test.ts \
  tests/main/lifecycleService.test.ts \
  tests/main/nextActionInvariant.test.ts \
  tests/main/invariantAudit.test.ts \
  tests/main/optOutRepository.test.ts \
  tests/main/optOutService.test.ts \
  tests/integration/optOutPersistence.test.ts \
  tests/integration/concurrentOptOutInvariant.test.ts \
  tests/support/domainSchemaScenario.ts \
  tests/support/domainWriteWorker.ts
git commit -m "feat: enforce permanent person opt-out"
```

### Task 11: Implement Two-Axis Fit, Timing, Triggers, and Priority Projection

**Files:**
- Modify: `src/main/db/migrations/0002DomainFoundation.ts`
- Modify: `src/main/db/domainSchema.ts`
- Modify: `src/main/domain/support/domainErrors.ts`
- Create: `src/main/domain/prioritization/prioritizationTypes.ts`
- Create: `src/main/domain/prioritization/builtinPrioritizationRules.ts`
- Create: `src/main/domain/prioritization/qualificationEngine.ts`
- Create: `src/main/domain/prioritization/triggerMath.ts`
- Create: `src/main/domain/prioritization/priorityMatrix.ts`
- Create: `src/main/domain/prioritization/priorityOrdering.ts`
- Create: `src/main/domain/prioritization/prioritizationRepository.ts`
- Create: `src/main/domain/prioritization/prioritizationService.ts`
- Modify: `tests/main/domainConstraints.test.ts`
- Modify: `tests/main/domainSchema.test.ts`
- Modify: `tests/main/migrations.test.ts`
- Modify: `tests/support/domainSchemaScenario.ts`
- Create: `tests/main/qualificationEngine.test.ts`
- Create: `tests/main/builtinPrioritizationRules.test.ts`
- Create: `tests/main/triggerMath.test.ts`
- Create: `tests/main/priorityMatrix.test.ts`
- Create: `tests/main/priorityOrdering.test.ts`
- Create: `tests/integration/priorityOrderingSqlParity.test.ts`
- Create: `tests/integration/concurrentPrioritization.test.ts`
- Create: `tests/main/prioritizationRepository.test.ts`
- Create: `tests/main/prioritizationService.test.ts`
- Create: `tests/main/noBlendedScore.test.ts`

**Interfaces:**
- Consumes: the canonical eligible Prospect, Person-owned source/property/contact facts, immutable TriggerEvents, one immutable rule version, and an explicit UTC evaluation time.
- Produces: either an immutable gated decision with no numeric axes and no current projection, or an immutable two-axis evaluation plus one optimistic current projection. Preview never mutates either projection or manual controls.
- Provides Task 12 with an `EffectivePrioritySnapshot` and one canonical JS/SQLite lexicographic ordering contract. Task 11 does not create SalesCycles, NextActions, Today lanes, or capacity rules.

- [ ] **Step 1: Freeze the public unions and hard bans in RED tests**

Define the public contract before implementation:

```ts
export type GateReason =
  | 'out_of_area'
  | 'no_relevant_decision_relationship'
  | 'institutional_outside_icp'
  | 'harmful_operator'
  | 'non_paying_operator'
  | 'unresolved_duplicate';

export type QualificationResult =
  | {
      kind: 'qualified';
      prospectId: string;
      evidenceIds: readonly string[];
    }
  | {
      kind: 'gated';
      prospectId: string;
      reasons: readonly [GateReason, ...GateReason[]];
      evidenceIds: readonly string[];
    }
  | {
      kind: 'pending_review';
      prospectId: string;
      qualificationState: 'unreviewed';
      evidenceIds: readonly string[];
    }
  | {
      kind: 'operationally_blocked';
      prospectId: string;
      reason: 'person_deleted' | 'person_opted_out';
      evidenceIds: readonly string[];
    };

export type RecalculationResult =
  | {
      kind: 'evaluated';
      evaluation: QualifiedPrioritizationEvaluation;
      projection: ProspectPriorityProjection;
    }
  | {
      kind: 'not_prioritizable';
      evaluation: NotPrioritizableEvaluation;
      projection: null;
      qualification: Exclude<QualificationResult, { kind: 'qualified' }>;
    };

export type PriorityPlay =
  | 'contact_immediately'
  | 'find_direct_line'
  | 'contact_today'
  | 'quick_fit_check'
  | 'qualify_this_week'
  | 'nurture'
  | 'watch_for_trigger'
  | 'archive_candidate';

export type QualifiedPrioritizationEvaluation = {
  decisionKind: 'evaluated';
  id: string;
  prospectId: string;
  ruleVersionId: string;
  evaluatedAt: string;
  fitPoints: number;
  fitBand: 'low' | 'medium' | 'high';
  timingMilliPoints: number;
  timingBand: 'cold' | 'warm' | 'hot';
  reachability: 'direct' | 'indirect' | 'none';
  dataConfidence: number;
  priority: 'p0' | 'p1' | 'p2' | 'p3';
  play: PriorityPlay;
  earliestTriggerExpiresAt: string | null;
  verifyFirst: boolean;
  explanation: readonly PrioritizationReason[];
};

export type NotPrioritizableEvaluation = {
  decisionKind: 'not_prioritizable';
  id: string;
  prospectId: string;
  ruleVersionId: string;
  evaluatedAt: string;
  qualification: Exclude<QualificationResult, { kind: 'qualified' }>;
  explanation: readonly PrioritizationReason[];
};
```

`qualification_state='eligible'` on the one canonical Prospect is the only state that can enter Fit/Timing evaluation, and its Person must be undeleted and consistently not opted out in both Person/tombstone state. `merge_review` maps only to `unresolved_duplicate`; `disqualified` requires an exact `GateReason` in `qualification_reason`; `unreviewed` returns `pending_review`; and deletion/opt-out returns the exact operational block. Blank, unknown, or contradictory stored qualification/opt-out values are corruption, not silently qualified records. Gate evidence is the stable Prospect/original SourceEvent/tombstone evidence used by the decision. Hard gates and operational blocks execute before contact, property, trigger, matrix, or confidence calculation.

`noBlendedScore.test.ts` scans Task 11 production files, typed schema, migration SQL, and the Task 12 ordering glob (which may be empty until Task 12 lands). It rejects case-insensitive generic aliases (`lead_score`, `overall_score`, `combined_score`, `blended_score`, `weighted_score`, `fit_weight`, `timing_weight`, `order by score`), a public property named `score`, a 0-100 priority range, any helper that arithmetically combines Fit and Timing, and any SQL expression that orders by such a combination. It asserts the qualified result has `fitPoints`, `fitBand`, `timingMilliPoints`, `timingBand`, `priority`, and no generic numeric ranking field. Test names and explanatory comments may name the forbidden concept; production identifiers may not.

Also fail the test if pure engine files import the database, clock, lifecycle stage, SalesCycle, Activity, close-readiness, pain, or offer modules, or call ambient time/randomness (`Date.now`, zero-argument `new Date`, `Math.random`, random UUID generation, or SQLite `now`). Post-contact pain and outstanding offers never enter Prospect Fit, Timing, priority, or ordering.

- [ ] **Step 2: Specify exact V1 Fit, reachability, and confidence contracts**

All pure inputs are strict, versioned structures made from stored rows. Normalize, deduplicate by stable ID, and sort property/contact/evidence inputs before calculating. Duplicate IDs with different facts are typed corruption. Missing or unknown evidence contributes zero; the engine never estimates a fact from name, prose, segment, source channel, engagement, contactability, LLM output, or record order.

V1 Fit is exactly:

| Stable pre-contact fact | Points |
|---|---:|
| Sum of known `door_count` across unique linked Properties is 5-30 | 15 |
| Sum is 2-4 or 31-50 | 6 |
| Sum is 0-1, greater than 50, or no linked Property has a known count | 0 |
| Strict `maintenance_profile_json` V1 says `management='self_managed'` | 8 |
| Management says `third_party` or is absent/unknown | 0 |
| At least two linked Properties have `verified_at` and the same normalized `(country_code, region, locality)` | 4 |
| No normalized locality group contains two verified linked Properties | 0 |
| Strict profile V1 says `relevant_profile=true` | 3 |
| Relevant profile is false, absent, or unknown | 0 |

`maintenance_profile_json` V1 is strict `{ formatVersion: 1, management: 'self_managed' | 'third_party' | 'unknown', relevantProfile: boolean | 'unknown', evidenceRefs: string[] }`; unknown keys or malformed JSON fail closed. If several Properties supply management/profile facts, award a category only when all non-unknown claims agree; conflicting claims are corruption/Review, not first-row-wins. Door counts are non-negative integers enforced at input and storage. Route grouping applies NFKC, trim, internal-whitespace collapse, and locale-independent lowercase to locality/region, with uppercase country code, matching Task 7 canonical context values. Fit is clamped by construction to 0-30 and maps Low 0-9, Medium 10-19, High 20-30. More than 50 doors is Fit 0 unless an independent explicit qualification decision already records `institutional_outside_icp`; size alone never invents a hard gate.

Reachability is derived independently:

- Direct requires a `validation_state='valid'`, `kind='phone'`, `reachability='direct'` ContactMethod for this Person.
- Indirect applies when Direct is absent and there is a valid email or valid indirect phone/office number. A valid email marked `direct` is still Indirect for this rule.
- Invalid/unverified methods do not count; no qualifying method is None.

V1 data confidence is an integer 0-10 and uses only these independent components:

| Evidence | Points |
|---|---:|
| Original registry SourceEvent with nonblank `evidence_ref` | 4 |
| Other supported original SourceEvent with nonblank `evidence_ref` | 3 |
| Supported original SourceEvent without `evidence_ref` | 1 |
| Source age 0-30 elapsed days at `evaluatedAt` | 2 |
| Source age greater than 30 through 180 elapsed days | 1 |
| At least one linked Property has a youngest verification age 0-180 elapsed days | 2 |
| Linked verified Properties exist but all are older than 180 elapsed days | 1 |
| At least one valid ContactMethod exists | 1 |
| At least one nonzero management/profile Fit fact has nonblank strict V1 evidence refs | 1 |

Sum and cap at 10. Each absent/unknown component is zero. Future `observed_at`/`verified_at`, invalid canonical timestamps, malformed original source evidence, or inconsistent ownership fail closed. Confidence never changes Fit or Timing. `verifyFirst` is true only when final priority is P0/P1 and confidence is 0-6; it is false at 7-10 and for P2/P3.

- [ ] **Step 3: Specify exact trigger rules, evidence, and boundaries**

Define a strict `TriggerEvidenceV1` discriminated union. Every envelope is `{ formatVersion: 1, evidenceRefs: string[], ... }` plus exactly one function shape:

```ts
type TriggerEvidenceV1 =
  | {
      formatVersion: 1;
      authoredUnderRuleVersionId: string;
      function: 'decaying';
      evidenceRefs: string[];
    }
  | {
      formatVersion: 1;
      authoredUnderRuleVersionId: string;
      function: 'approaching';
      deadlineAt: string;
      evidenceRefs: string[];
    }
  | {
      formatVersion: 1;
      authoredUnderRuleVersionId: string;
      function: 'windowed';
      startsAt: string;
      endsAt: string;
      evidenceRefs: string[];
    };
```

`TriggerEvent.effective_at` is the observation/activation instant. Calendar-window authoring resolves founder-configured workspace-local boundaries to canonical UTC `startsAt`/`endsAt` before persistence; the pure evaluator receives no timezone clock. Evidence function must match the active rule entry. Require canonical UTC millisecond timestamps, `startsAt < endsAt`, at least one nonblank unique sorted evidence ref, Person/Prospect/Source ownership, and `effective_at < endsAt` for a window. A window is active only on `[max(effective_at, startsAt), endsAt)`, so evidence observed mid-window never backdates priority. `source_event_id` remains unique, so one external source event cannot create multiple trigger types.

Treat stored `expires_at` only as an immutable source-evidence hard stop, never as the calculated rule expiration: it must be canonical and later than `effective_at`; a window/approaching event must store the same terminal instant as its strict evidence envelope, while a decay event may leave it null or provide an earlier source-specific stop such as a removed listing. A hard stop is exclusive. Recompute the rule threshold under the selected immutable rule version on every evaluation and take the earlier of that threshold and any source hard stop. This preserves reproducibility when a later rule version changes a half-life without rewriting TriggerEvent history.

The immutable V1 rule document contains these exact stored trigger keys and defaults:

| Stored key | Base | Function |
|---|---:|---|
| `live_vacancy` | 15 | decay, 14-day half-life |
| `recent_acquisition` | 15 | decay, 180-day half-life |
| `compliance_deadline` | 10 | approaching control points below |
| `recent_permit_maintenance` | 5 | decay, 30-day half-life |
| `heating_season` | 5 | strict event-supplied window |
| `student_turnover` | 5 | strict event-supplied window |
| `post_storm` | 5 | decay, 10-day half-life |
| `tax_season` | 3 | strict event-supplied window |
| `inbound_demo` | 30 | decay, 2-day half-life |
| `direct_referral` | 25 | decay, 7-day half-life |
| `rireig_connection` | 15 | decay, 7-day half-life |
| `recent_lead_engagement` | 15 | decay, 7-day half-life |
| `nurture_resurrection` | 10 | `[effective_at, effective_at + 14 days)` window |
| `custom:<lowercase-slug>` | rule-defined 0-40 | strict versioned decay/approach/window parameters |

Custom slugs match `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`. Founder-configured seasonal/tax windows contribute zero unless a valid absolute window event exists; V1 does not guess dates. Compliance is zero before `deadlineAt - 90 days`, exactly 25% of base at 90 days, linearly interpolates to 100% at 30 days, remains 100% through the deadline and until but excluding `deadlineAt + 14 days`, then expires. Custom half-lives are one hour through 730 days; custom approaching factors are sorted unique control points in 0-1; custom strength remains 0-2. A built-in key cannot be shadowed by a custom rule. A syntactically valid historical custom key absent from the evaluation rule contributes zero with `custom_not_configured`; a malformed key or unknown built-in-like key is corruption.

For each event:

```ts
raw = base * 2 ** (-ageSeconds / halfLifeSeconds); // decay only
effective = raw * strengthMultiplier * (verified ? 1 : 0.6);
```

Evaluation before an event's effective instant is zero. Apply the `< 1.0` threshold to the unrounded effective value, then round an active event to integer thousandths. At exactly 1.0 it contributes; below 1.0 it does not. On the canonical millisecond time domain, decay expiration is `floor(exact threshold instant to milliseconds) + 1 ms`, the first representable instant below 1.0. Windows are half-open. Use decimal/rational control-point tests so floating drift cannot move a boundary.

Select only the strongest active event for each full stored trigger key. Break equal-thousandth ties by earliest non-null recomputed expiration (null last), then earliest `effective_at`, then stable TriggerEvent ID. Sum selected thousandths and cap at 40,000. Map 0-7,999 to Cold, 8,000-19,999 to Warm, and 20,000-40,000 to Hot before display rounding. `earliestTriggerExpiresAt` is the earliest expiration among all selected positive contributors even if the cap truncates the displayed sum. Explanations retain every parsed active event: selected records include their uncapped contribution; suppressed same-key records include `contributed=false` and the winning event ID. Stable-sort all reasons by stored trigger key, selected first, then event ID.

- [ ] **Step 4: Lock the matrix, plays, nurture exception, and effective controls**

The pure matrix is exactly:

| Timing / Fit | High | Medium | Low |
|---|---|---|---|
| Hot | P0 `contact_immediately` | P1 `contact_today` | P2 `quick_fit_check` |
| Warm | P1 `contact_today` | P2 `qualify_this_week` | P3 `nurture` |
| Cold | P3 `watch_for_trigger` | P3 `nurture` | P3 `archive_candidate` |

High/Hot without Direct is P1 `find_direct_line`, never P0. If `nurture_resurrection` is the only selected positive trigger key, computed priority cannot exceed P1 and explanation contains `nurture_only_p0_block`; any other selected positive key restores the ordinary matrix. This exception applies only to computed priority. A founder priority override may still select P0 when current reachability is Direct.

Define `EffectivePrioritySnapshot` with both computed and effective priority, current projection version/evaluation ID, active priority/pin/snooze/dismiss control IDs, explicit `asOf`, and all tuple fields. New manual controls use `[created_at, expires_at)`, require canonical times, `expires_at > created_at`, a nonblank reason, and one active control per kind. A retired row may end at `expires_at = created_at`; the repository never inserts that zero-length form. Overlap is a typed conflict under `BEGIN IMMEDIATE`, never newest-row-wins. Semantics are:

- priority override changes only effective priority; computed fields remain visible; P0 requires the current projection to be Direct at write and render time;
- pin is a boolean Task 12 may use only inside the already-assigned lane and is not part of the prospect-priority tuple;
- snooze and dismiss are explicit suppression hints for Task 12 and cannot suppress onboarding, inbound-SLA, overdue, or promised/due work;
- retiring a control only shortens `expires_at` with an exact expected-old-expiration CAS; the row and reason remain retained;
- gate/removal first retires every effective P0 override at `evaluatedAt`, then all other effective controls, before projection deletion, preserving the existing raw P0 deletion defense.

V1 preference learning is append-only, not model fitting. Add immutable `prioritization_preference_events` with caller-stable ID, optional unique `control_id` plus `controlled_prospect_id`, action kind (`acted_out_of_order`, `snoozed`, `dismissed`, `reordered`, `priority_overridden`, `pinned`), distinct winner/loser Prospect IDs, the exact immutable qualified evaluation ID for each side, `observed_at`, strict canonical V1 context JSON, and `created_at`. Add `UNIQUE(id, prospect_id, decision_kind)` support on evaluations and constant `decision_kind='evaluated'` columns/composite foreign keys so each comparison uses an evaluated row belonging to its named Prospect. Control action kinds require their matching `(control_id, controlled_prospect_id)`; favoring controls require the controlled Prospect be the winner, snooze/dismiss require it be the loser, and reorder/out-of-order kinds require both control columns null. Creating a priority/pin/snooze/dismiss control atomically appends its required comparison. A UI action without both current comparison snapshots is rejected rather than stored as fake pairwise evidence. Reordering/acting out of order may append a preference event without a control. V1 never fits Bradley-Terry, changes rules, or activates a proposal.

- [ ] **Step 5: Write RED pure, metamorphic, and boundary tests**

Cover every gate/state mapping; malformed/conflicting profile facts; all door, Fit-band, Timing-band, confidence, Verify First, and timestamp boundaries; equivalent input permutations; all nine matrix cells; Direct fallback; nurture-only downgrade and nurture-plus-other restoration; built-in rule constants/hash; every trigger function; multipliers; `<1.0` expiration; strongest-per-key ties; cap behavior; window edges; custom bounds; and stable full explanations.

Add metamorphic/property tests proving:

- changing only a Fit fact cannot alter Timing, trigger selection, or Timing explanations;
- changing only trigger evidence/evaluation time cannot alter Fit;
- contact changes affect only reachability/confidence/P0 eligibility, never Fit/Timing;
- confidence changes only its tie-break/Verify First value;
- input order and duplicate exact facts cannot affect serialized output;
- unknown data contributes zero and cannot improve a band;
- two axis pairs in different matrix cells cannot be made equivalent through a hidden arithmetic combination; and
- pure calls with identical explicit inputs produce byte-identical canonical output and mutate no inputs.

- [ ] **Step 6: Amend schema 0002 for durable unions, idempotency, ownership, and preference evidence**

Because no later migration has shipped, amend `0002DomainFoundation`; do not create `0003` and do not weaken Task 4's backup gate. Update Kysely types, rollback statements in exact reverse dependency order, schema manifest, raw invariant probes, and packaged scenario together.

Make the existing structures enforce:

- `prioritization_rule_versions.version` is unique; ID/version/content hash/canonical `rules_json` are immutable; same ID or version with different canonical content conflicts;
- evaluations add immutable `decision_kind` (`evaluated` or `not_prioritizable`), canonical `command_json`, canonical `input_snapshot_json`, canonical `result_json`, and `qualification_json`; the input snapshot is the strict gate-only snapshot for an excluded record or the complete normalized property/contact/source/trigger fact snapshot for an evaluated record, making every historical result reproducible after mutable facts change;
- evaluated rows require all existing Fit/Timing/reachability/confidence/priority columns and null exclusion reasons; `not_prioritizable` rows require every numeric/band/priority/expiration/Verify First column to be null and a nonempty typed qualification result;
- evaluations expose composite uniqueness needed to prove Prospect/result ownership; projection has a constant evaluated decision discriminator plus a composite FK and trigger so it can reference only a same-Prospect `evaluated` row and still faithfully copy every computed field;
- `priority_overrides` permits only expiration-shortening updates (`created_at <= new expires_at <= old expires_at`), blocks owner/kind/value/reason/creation mutation and deletion, and retains raw P0 insert/update/projection-update/delete defenses including `INSERT OR REPLACE` with `recursive_triggers=ON`;
- `priority_overrides` exposes `UNIQUE(id, prospect_id)` for ownership; preference events are immutable under UPDATE, DELETE, same-primary-key replace, and non-primary UNIQUE replace, own both Prospects/qualified evaluations through composite FKs, own an optional exact control through `(control_id, controlled_prospect_id)`, require winner != loser, and use strict supported action/control combinations; and
- workspace active-rule replacement is guarded by an existing immutable rule row; only the repository CAS activation path may change the pointer.

Add exact typed errors for malformed/corrupt evidence, repository composition, immutable rule-version conflict, idempotency conflict, stale projection/control/rule CAS, overlapping manual controls, and invalid P0 reachability. No caller branches on SQLite text.

On every read, strict schemas cross-check evaluation command/input/result/qualification envelopes against relational ID, owner, rule, decision, timestamp, and every nullable/non-null computed column; preference context against its action/control/comparison columns; and projection against its immutable evaluation. A well-shaped JSON envelope that names a different Prospect, rule, evaluation, trigger, comparison, or computed value is corruption.

Raw SQL tests attempt NULL/case/type loopholes, forged cross-Person evaluation/control/preference ownership, gated projections, projection/evaluation divergence, owner moves, exact/non-primary `OR REPLACE`, rule mutation, priority-control widening, control deletion, P0 creation without Direct, reachability loss/deletion under effective P0, and malformed canonical JSON through repository reads. Migration rollback removes new triggers/indexes/table before referenced structures and restores an empty schema.

- [ ] **Step 7: Define the exact immutable V1 rule document and installation contract**

`builtinPrioritizationRules.ts` exports a deeply frozen `BUILTIN_PRIORITIZATION_RULE_V1` with stable ID `founder-priority-v1`, version `1`, all Step 2-4 constants, and a SHA-256 over canonical JSON. Hashing recursively sorts object keys while retaining array order and never includes the hash field itself. Tests assert the full canonical document and hash, not selected fields or snapshots that can be casually updated.

Rule installation preselects both ID and version. An exact ID/version/hash/canonical-document replay returns the stored row before consuming the clock; same ID or same version with any changed content conflicts. Activation updates the singleton pointer only with `WHERE active_prioritization_rule_version_id IS expected`, treating null explicitly; zero changed rows is a typed stale-rule conflict.

`PrioritizationRepository` is constructed with `{ database, unitOfWork, clock }`, exposes `assertBoundTo(database, unitOfWork)`, strictly Zod-parses every row and JSON envelope, and provides:

```ts
installRuleVersion(input: PrioritizationRuleDocument): PrioritizationRuleVersion;
getRuleVersion(id: string): PrioritizationRuleVersion | null;
getRuleVersionByVersion(version: number): PrioritizationRuleVersion | null;
getActiveRuleVersion(): PrioritizationRuleVersion | null;
activateRuleVersion(input: {
  ruleVersionId: string;
  expectedActiveRuleVersionId: string | null;
}): PrioritizationRuleVersion;
getTriggerEventById(id: string): TriggerEvent | null;
getTriggerEventBySourceEvent(sourceEventId: string): TriggerEvent | null;
listTriggerEvents(prospectId: string): TriggerEvent[];
appendTriggerEvent(input: TriggerEvent): TriggerEvent;
loadQualificationInputs(prospectId: string): QualificationInputSnapshot;
loadQualifiedEvaluationInputs(prospectId: string): QualifiedInputSnapshot;
getEvaluationById(id: string): PrioritizationEvaluation | null;
appendEvaluation(input: PrioritizationEvaluation): PrioritizationEvaluation;
insertProjection(input: ProspectPriorityProjection): ProspectPriorityProjection;
updateProjectionCas(input: ProjectionCasUpdate): ProspectPriorityProjection;
deleteProjectionCas(input: ProjectionCasDelete): void;
createOverride(input: PriorityOverride): PriorityOverride;
listActiveOverrides(prospectId: string, asOf: string): PriorityOverride[];
expireOverrideCas(input: OverrideExpirationCas): PriorityOverride;
appendPreferenceEvent(input: PrioritizationPreferenceEvent): PrioritizationPreferenceEvent;
```

Reads may run outside a transaction. Every mutator requires the active token of the exact supplied UoW and database. Installation/activation/service wrappers own one `BEGIN IMMEDIATE`; scoped variants reuse that exact active scope and never nest. Use plain INSERT for immutable rows, targeted CAS/declared-key handling only, no broad conflict suppression or SQLite error-message parsing. Stable reads order Properties/contacts/TriggerEvents by ID, controls by `(override_kind, created_at, id)`, preference events by `(observed_at, id)`, evidence refs lexically, and computed reasons by the Step 3 key before parsing/return.

`PrioritizationService` receives the same `{ database, unitOfWork, clock, repository }`, calls `repository.assertBoundTo(database, unitOfWork)` at construction, and rejects every mixed-database/different-UoW permutation before reads, writes, or clock access.

- [ ] **Step 8: Implement the pure engines without SQL, time, IDs, or mutation**

`qualificationEngine`, Fit/confidence derivation, `triggerMath`, and `priorityMatrix` are pure functions over strict parsed inputs and the immutable rule document. Every function receives `evaluatedAt`; none can read a repository or allocate an ID. Freeze/clone returned rule/result arrays so callers cannot mutate catalog state.

The trigger evaluator uses integer milliseconds and integer thousandths at all comparison/output boundaries. It rejects unsupported rule/evidence versions and invalid function/evidence combinations with typed errors. It returns selected/suppressed evidence, uncapped/capped totals, expiration, and reason codes sufficient to explain the public result without rereading mutable rows.

- [ ] **Step 9: Define one canonical JS and SQLite prospect-priority tuple**

Export `buildProspectPriorityTuple`, `compareProspectPriority`, and one fixed-column SQLite order helper/fragment consumed unchanged by Task 12. The tuple is never reduced to a scalar:

```ts
[
  effectivePriorityRank,             // p0, p1, p2, p3 ascending
  earliestExpirationIsNull,          // 0 non-null, 1 null
  earliestExpirationEpochMillis,     // ascending; sentinel only when null
  -timingMilliPoints,
  -fitPoints,
  reachabilityRank,                   // direct, indirect, none ascending
  -dataConfidence,
  lastContactIsNonNull,               // 0 null/never, 1 contacted
  lastContactEpochMillis,             // oldest ascending; sentinel only when null
  stableProspectId,
]
```

Canonical timestamps are parsed before comparison; invalid values throw. Fixed-width canonical UTC text has the same temporal ordering as the JS epoch value. The SQL expression uses explicit `CASE` ranks/null flags, `COLLATE BINARY` for stable IDs, and the same ascending/descending directions, including the actual expiration and last-contact timestamps. It never relies on enum text ordering, SQLite default NULL ordering, collation-dependent booleans, or an omitted stable-ID tie-break.

Generate boundary-heavy and randomized fixtures, compute their order in JS, insert the same rows into a temporary encrypted database, order with the shared SQL contract, and require identical Prospect-ID sequences. Include effective priority overrides, equal bands/different raw axes, null/equal expirations, every reachability/confidence value, null/equal last contact, and stable-ID ties. Pin is intentionally absent; Task 12 applies it only after lane assignment.

- [ ] **Step 10: Implement idempotent preview and transaction-owning recalculation**

Expose:

```ts
recordTriggerEvent(input: RecordTriggerEventInput): TriggerEvent;

evaluatePreview(input: {
  prospectId: string;
  ruleVersionId: string;
  evaluatedAt: string;
}): PrioritizationPreview;

recalculateProspect(input: {
  evaluationId: string; // caller-stable idempotency key
  prospectId: string;
  ruleVersionId: string;
  evaluatedAt: string;
  expectedProjectionVersion: number | null;
}): RecalculationResult;
```

`evaluatePreview` may use any installed rule version. It rejects an already-active raw transaction, opens one synchronous deferred read transaction on the exact database, loads and parses one coherent snapshot, computes, and closes without invoking the write UoW. It writes no evaluation, projection, override, preference, rule pointer, ID, timestamp, temp table, or pragma. Repeated preview calls over identical explicit inputs are byte-identical. Trace/total-change tests prove the preview issues only reads and sees either the before-commit or after-commit snapshot during an independent writer, never a torn mixture.

`recordTriggerEvent` is a separate transaction-owning command with caller-stable TriggerEvent ID, Prospect/SourceEvent IDs, stored key, explicit effective/source-expiration times, multiplier, verification state, and canonical evidence. It verifies the authoring rule exists, function/evidence compatibility, and exact Person ownership before INSERT. It preselects both ID and unique SourceEvent ID: an exact logical replay returns the stored row before reading the clock, while same ID/different source, same source/different ID, or any changed field is a typed idempotency conflict. Independent same-source contenders serialize to the same canonical result or a typed conflict; no broad suppression or error-text parsing is allowed.

`recalculateProspect` owns exactly one `unitOfWork.immediate`. Before loading mutable facts, allocating defaults, or reading the injected clock, preselect `evaluationId`. An existing row must match the canonical V1 command envelope byte-for-byte (`evaluationId`, Prospect, rule, explicit evaluation time, expected projection version, and mode); exact replay returns the stored strict canonical result. Any changed field is a typed idempotency conflict. The caller supplies the evaluation ID/time, so replay consumes neither generated IDs nor default clocks. On first execution only, reject `evaluatedAt` later than the injected clock, earlier than the current projection evaluation, or earlier than any effective control's creation time; preview may intentionally evaluate a future explicit time because it cannot mutate state.

On first execution, use this order:

```text
assert repository/database/exact-UoW composition
load and require the workspace active rule pointer equals ruleVersionId
load canonical Prospect/Person/source/tombstone gate facts and run qualification
only when qualified, load one stable ownership-checked property/contact/trigger snapshot
build canonical command/result envelopes
insert one immutable evaluated-or-gated evaluation
if evaluated:
  if the new reachability is not Direct, CAS-retire every effective P0 override at evaluatedAt
  expectedProjectionVersion=null -> plain INSERT requiring absence and no effective controls
  expectedProjectionVersion=N -> CAS UPDATE WHERE prospect_id/version=N
  require current evaluated_at <= requested evaluatedAt; increment version once
if gated/pending review:
  require expected projection state/version exactly
  CAS-shorten every active P0 control, then other active controls, to evaluatedAt
  CAS-delete the projection when present; leave all historical rows intact
read strict postcondition and commit
```

Projection writes copy exactly from the qualified evaluation. There is no upsert/replace. A missing row with expected N, existing row with expected null, stale/future projection, changed active rule, or failed override retirement rolls back the evaluation and every mutation. Gated exact retry returns the original immutable gated result after projection removal without reapplying CAS mutations. A later fresh evaluation uses a new ID and current expected projection version.

Inject a deterministic failure after evaluation insert, each control retirement, projection insert/update/delete, and postcondition. Compare ordered snapshots before/after: every failed path is byte-equivalent and leaves no consumed ID, orphan evaluation, stale projection, widened control, or partial preference record.

- [ ] **Step 11: Implement manual-control and V1 preference commands**

Expose:

```ts
type PairwiseComparisonSnapshot = {
  winner: { prospectId: string; evaluationId: string; projectionVersion: number };
  loser: { prospectId: string; evaluationId: string; projectionVersion: number };
};

type ManualControlCommand = {
  controlId: string;
  preferenceEventId: string;
  controlledProspectId: string;
  comparison: PairwiseComparisonSnapshot;
  reason: string;
  asOf: string;
  expiresAt: string;
};

type PairwisePreferenceCommand = {
  preferenceEventId: string;
  comparison: PairwiseComparisonSnapshot;
  reason: string;
  asOf: string;
};

createPriorityOverride(
  input: ManualControlCommand & { priority: 'p0' | 'p1' | 'p2' | 'p3' },
): EffectivePrioritySnapshot;
pinProspect(input: ManualControlCommand): EffectivePrioritySnapshot;
snoozeProspect(input: ManualControlCommand): EffectivePrioritySnapshot;
dismissProspect(input: ManualControlCommand): EffectivePrioritySnapshot;
recordOutOfOrderChoice(input: PairwisePreferenceCommand): PrioritizationPreferenceEvent;
recordReorder(input: PairwisePreferenceCommand): PrioritizationPreferenceEvent;
expireControl(input: {
  controlId: string;
  expectedExpiresAt: string;
  newExpiresAt: string;
}): PriorityOverride;
getEffectivePrioritySnapshot(input: {
  prospectId: string;
  asOf: string;
}): EffectivePrioritySnapshot;
```

These are transaction-owning commands with caller-stable override/preference IDs and explicit `asOf`/expiration. Validate and canonicalize the complete command, then preselect either stable ID before reading defaults or the injected clock. On first execution require `asOf <= clock.now()`, set control `created_at` and preference `observed_at` to `asOf`, and require expiration after `asOf`. Priority/pin require the controlled Prospect be the comparison winner; snooze/dismiss require it be the loser. Each command inserts the control and immutable preference event atomically. `recordOutOfOrderChoice`/`recordReorder` append only the pairwise event. Stale comparison snapshots fail before writes. Exact event/override replay returns the original canonical result without consuming clock/IDs; same ID with any changed command conflicts.

`expireControl` uses `(id, expectedExpiresAt)` and only permits `newExpiresAt <= expectedExpiresAt`; rows never delete. `getEffectivePrioritySnapshot({ prospectId, asOf })` strictly parses current projection and all controls, rejects overlaps/corruption, enforces the render-time P0 Direct gate, and returns computed and effective values separately. No control rewrites immutable evaluation/result JSON or activates a new rule. Preference ordering/model fitting is explicitly deferred to V1.1.

- [ ] **Step 12: Write repository, raw-bypass, replay, fault, and independent-connection tests**

Test every repository DB/UoW mismatch permutation, reads outside/write inside scope, strict input/stored-row/JSON/0-1/timestamp parsing, stable ordering, canonical rule hash/install/activation CAS, and inactive-rule preview versus active-rule projection. Test exact replay and every changed-command field for trigger recording, qualified/gated recalculation, controls, and preference events; verify no generated ID/default-clock consumption on replay.

Using two independently keyed production `openDatabase` connections and a barrier, race:

- same SourceEvent/same trigger command and same SourceEvent/different trigger commands;
- first projection insert against first projection insert;
- two updates with one expected projection version;
- evaluated update against gated deletion;
- rule activation against recalculation;
- two overlapping controls of the same kind;
- P0 override against loss of Direct reachability/projection replacement; and
- same-ID same-command and same-ID different-command evaluation/control/preference writes.

Each race yields one canonical success/replay or one typed stale/idempotency conflict, never raw `SQLITE_BUSY`, duplicate active controls, cross-Person evidence, partial rows, or message-parsed outcomes. Verify Task 4 busy timeout and `recursive_triggers=ON` remain active.

Inject failures after TriggerEvent insert, evaluation insert, each control retirement, projection insert/update/delete, manual-control insert, preference-event insert, rule install, pointer activation, and every final postcondition. Each failed command rolls back to byte-equivalent ordered rows and consumes no logical idempotency result.

- [ ] **Step 13: Prove the Task 11 -> Task 12 boundary**

Contract-test that Task 11 exports only qualification/evaluation, `EffectivePrioritySnapshot`, controls, explanations, and the canonical comparator/SQL ordering helper. It must not query or mutate SalesCycles, NextActions, cadence enrollment/stage, queue lanes, daily capacity, or exploration slots.

Document for Task 12 tests:

- lanes 1-5 remain promise-first and ignore snooze/dismiss suppression;
- lanes 6-8 use effective priority plus the exact Task 11 tuple;
- pin applies only within the lane Task 12 already assigned and cannot cross onboarding/inbound/overdue/promised boundaries;
- snooze/dismiss may suppress only discretionary prospecting/exploration when no due promise exists;
- capacity truncates discretionary call work only; and
- Task 12 must surface typed missing/corrupt projections under Review rather than recompute priority.

No capacity selection is implemented in Task 11.

- [ ] **Step 14: Run the complete RED priority slice**

Run before production implementation:

```bash
npx vitest run \
  tests/main/domainConstraints.test.ts \
  tests/main/domainSchema.test.ts \
  tests/main/migrations.test.ts \
  tests/main/noBlendedScore.test.ts \
  tests/main/builtinPrioritizationRules.test.ts \
  tests/main/qualificationEngine.test.ts \
  tests/main/triggerMath.test.ts \
  tests/main/priorityMatrix.test.ts \
  tests/main/priorityOrdering.test.ts \
  tests/main/prioritizationRepository.test.ts \
  tests/main/prioritizationService.test.ts \
  tests/integration/priorityOrderingSqlParity.test.ts \
  tests/integration/concurrentPrioritization.test.ts
```

Expected: FAIL because Task 11 schema/modules are absent. Preserve the RED output.

- [ ] **Step 15: Implement the schema, pure engine, repository, service, and controls in that order**

Make only the behavior specified above pass. Keep rule documents and pure calculations independent of persistence. Keep repository writes scoped and service transactions owning. Do not add a generic ranking number, customizable lifecycle stage, automatic outreach, calibration activation, capacity queue, close-readiness input, or post-contact timing signal.

- [ ] **Step 16: Run GREEN verification, packaging, and hard-ban scans**

Run fresh:

```bash
npx vitest run \
  tests/main/domainConstraints.test.ts \
  tests/main/domainSchema.test.ts \
  tests/main/migrations.test.ts \
  tests/main/noBlendedScore.test.ts \
  tests/main/builtinPrioritizationRules.test.ts \
  tests/main/qualificationEngine.test.ts \
  tests/main/triggerMath.test.ts \
  tests/main/priorityMatrix.test.ts \
  tests/main/priorityOrdering.test.ts \
  tests/main/prioritizationRepository.test.ts \
  tests/main/prioritizationService.test.ts \
  tests/integration/priorityOrderingSqlParity.test.ts \
  tests/integration/concurrentPrioritization.test.ts \
  tests/main/identityRepository.test.ts \
  tests/main/sourceService.test.ts \
  tests/main/lifecycleService.test.ts \
  tests/main/invariantAudit.test.ts
npm run typecheck
npm run lint
npm run test
npm run package
git diff --check
```

Expected: focused schema/engine/repository/service/parity/concurrency tests, upstream identity/intake/lifecycle regressions, full suite, typecheck, lint, and packaged verification PASS. Re-run the hard-ban scanner over the final production diff and verify no public generic ranking property, weighted combination, post-contact input, ambient time/randomness, nested transaction, broad conflict suppression, SQLite message parsing, or Task 12 capacity behavior was introduced.

- [ ] **Step 17: Commit two-axis prioritization**

Stage the exact Task 11 schema, domain, test, and support files; inspect the staged file list before committing:

```bash
git add \
  src/main/db/migrations/0002DomainFoundation.ts \
  src/main/db/domainSchema.ts \
  src/main/domain/support/domainErrors.ts \
  src/main/domain/prioritization \
  tests/main/domainConstraints.test.ts \
  tests/main/domainSchema.test.ts \
  tests/main/migrations.test.ts \
  tests/main/noBlendedScore.test.ts \
  tests/main/builtinPrioritizationRules.test.ts \
  tests/main/qualificationEngine.test.ts \
  tests/main/triggerMath.test.ts \
  tests/main/priorityMatrix.test.ts \
  tests/main/priorityOrdering.test.ts \
  tests/main/prioritizationRepository.test.ts \
  tests/main/prioritizationService.test.ts \
  tests/integration/priorityOrderingSqlParity.test.ts \
  tests/integration/concurrentPrioritization.test.ts \
  tests/support/domainSchemaScenario.ts
git diff --cached --name-only
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
- Create: `tests/integration/todayOrderingSqlParity.test.ts`
- Create: `tests/integration/todaySnapshot.test.ts`

**Interfaces:**
- Consumes: one coherent read snapshot of operational SalesCycles and only their authoritative current NextActions; Task 9 immutable action work intent and inbound-SLA evidence; active cadence/stage state; Task 11 `EffectivePrioritySnapshot`, comparator, and fixed SQL tuple; Task 10 render-time permission inspection; immutable selected-call Activity receipts; and injected Clock, workspace timezone, frozen channel policies, and capacity.
- Produces: one recursively frozen, byte-deterministic `TodayQueue` whose lanes, Later items, suppressed candidates, and diagnostics account for every base operational cycle exactly once without exposing bare Prospects or computing a blended ranking value.
- Boundary: Task 12 is read-only. It neither recalculates prioritization, mutates controls, completes actions, appends Activities, nor performs provider handoff. Task 13/the background refresh path must supply same-local-day Task 11 projections; communication execution owns the selected-call receipt and the final Task 10 send barrier.

The persisted `work_intent` is load-bearing. Never infer promise versus
discretionary work from `due_at`: the first Ready A/B/C action is due promptly
but remains capacity-bounded discretionary prospecting, while a later cadence
step is an owed promise even when both rows otherwise look identical.

- [ ] **Step 1: Write RED authoritative-pointer, strict-read, and once-only tests**

Drive the repository from every `sales_cycles.workflow_status IN
('active','onboarding')` row and LEFT JOIN the exact
`sales_cycles.current_next_action_id` on both action ID and cycle ID. Never scan
all pending actions: unreferenced supplemental pending rows may coexist and do
not enter Today. Add RED tests for:

- an operational cycle with one authoritative and several older/newer
  supplemental pending actions returning only the authoritative action;
- missing, settled, cross-cycle, or malformed pointer/action rows producing one
  typed diagnostic instead of disappearing through an inner join;
- a valid Unreviewed cycle with `work_intent='internal_review'`, no cadence, and
  no priority projection remaining actionable rather than being dropped;
- active cadence, enrollment, definition, step, and component ownership being
  loaded when present, with zero or more absent optional joins represented
  explicitly rather than row multiplication;
- missing/corrupt/stale priority projections leaving lanes 1-5 visible with an
  inline diagnostic, while discretionary rows become Review diagnostics and
  are never silently rescored;
- malformed work intent, inbound-SLA union, UTC timestamp, timezone, policy
  window, stored JSON, 0/1 boolean, control interval, Activity receipt, and
  last-Activity row producing strict typed diagnostics; and
- the set of cycle IDs across lane items, Later, suppressed, and diagnostics
  being disjoint and exactly equal to the base operational-cycle set, except
  that a Person already excluded by the SQL opted-out projection is outside the
  candidate universe. Only cycle-keyed diagnostics participate in this set;
  receipt diagnostics that cannot identify a cycle use `cycleId=null` and are
  additional queue-level evidence.

The repository query orders raw base rows only by
`sales_cycles.id COLLATE BINARY`. It must not use priority arithmetic, semantic
lane ordering, capacity `LIMIT`, or a join shape that duplicates a cycle.

- [ ] **Step 2: Define strict immutable Today types and diagnostics in RED**

Define the public types before implementation:

```ts
export type TodayLane =
  | 'won_onboarding'
  | 'inbound_interrupt'
  | 'overdue'
  | 'post_interview_offer'
  | 'due_primary'
  | 'new_p0'
  | 'p1'
  | 'exploration'
  | 'later';

export type TodayCapacity = {
  dialBudget: number;             // default 40
  conversationTarget: number;    // default 5; metric only
  explorationSlots: number;      // default 2
  resurfacingWindowSeconds: number; // default 259200
};

export type TodayLaneReason =
  | 'won_onboarding'
  | 'inbound_inside_sla'
  | 'non_discretionary_overdue'
  | 'inbound_sla_breached'
  | 'post_stage_due_today'
  | 'other_non_discretionary_due_today'
  | 'ready_p0'
  | 'ready_p1'
  | 'ready_p2'
  | 'ready_p3'
  | 'future_promise'
  | 'capacity_overflow'
  | 'exploration_quota_overflow';

export type TodayDiagnosticKind =
  | 'missing_current_action'
  | 'invalid_current_action'
  | 'current_action_owner_mismatch'
  | 'cadence_owner_graph_mismatch'
  | 'invalid_work_intent'
  | 'invalid_inbound_sla'
  | 'missing_priority_projection'
  | 'stale_priority_projection'
  | 'corrupt_priority_projection'
  | 'outbound_permission_blocked'
  | 'duplicate_candidate'
  | 'invalid_last_activity'
  | 'invalid_last_contact'
  | 'invalid_timestamp'
  | 'invalid_timezone'
  | 'invalid_channel_policy'
  | 'invalid_control'
  | 'invalid_selected_call_receipt';

export type TodayDiagnostic = {
  cycleId: string | null;
  personId: string | null;
  kind: TodayDiagnosticKind;
  relatedIds: readonly string[];
};

export type TodayItem = {
  cycleId: string;
  personId: string;
  prospectId: string;
  lane: TodayLane;
  deferredFrom: Exclude<TodayLane, 'later'> | null;
  laneReason: TodayLaneReason;
  action: {
    id: string;
    workIntent: NextActionWorkIntent;
    actionType: string;
    channel: string | null;
    dueAt: string;
    timezone: string;
    allowedWindow: string | null;
    inboundSla: InboundSla;
  };
  cadence: {
    enrollmentId: string;
    definitionId: string;
    family: CadenceFamily;
    stepId: string;
    stepSequence: number;
    componentId: string;
  } | null;
  priority: EffectivePrioritySnapshot | null;
  selectedTriggerReasons: readonly PrioritizationReason[];
  verifyFirst: boolean | null;
  pinned: boolean;
  lastActivity: {
    id: string;
    kind: ActivityKind;
    occurredAt: string;
    observedOutcome: string | null;
  } | null;
  stageEnteredAt: string;
  inlineDiagnostics: readonly TodayDiagnosticKind[];
};

export type TodayQueue = {
  generatedAt: string;
  timezone: string;
  localDate: string;
  capacity: TodayCapacity;
  completedDiscretionaryDialCount: number;
  queuedDiscretionaryDialCount: number;
  dialCount: number;
  remainingDiscretionaryDialCount: number;
  lanes: ReadonlyArray<{ lane: TodayLane; items: readonly TodayItem[] }>;
  suppressed: readonly {
    cycleId: string;
    reason: 'snoozed' | 'dismissed' | 'recently_contacted';
  }[];
  diagnostics: readonly TodayDiagnostic[];
};

type ActiveTodayControl = {
  createdAt: string;
  expiresAt: string;
};

export type ParsedTodayCandidate =
  Omit<TodayItem, 'lane' | 'deferredFrom' | 'laneReason' | 'pinned'> & {
    stage: SalesStage;
    workflowStatus: 'active' | 'onboarding';
    priorityState: 'current' | 'missing' | 'stale' | 'corrupt';
    controls: {
      pin: ActiveTodayControl | null;
      snooze: ActiveTodayControl | null;
      dismiss: ActiveTodayControl | null;
    };
    lastContactAt: string | null;
  };

export type TodayEvaluationContext = {
  generatedAt: string;
  timezone: string;
  localDayStartAt: string;
  localDayEndAt: string;
  capacity: TodayCapacity;
};

export type TodayPreCapacityDisposition =
  | {
      kind: 'lane';
      lane: Exclude<TodayLane, 'later'>;
      item: TodayItem;
    }
  | { kind: 'later'; item: TodayItem }
  | {
      kind: 'suppressed';
      cycleId: string;
      reason: 'snoozed' | 'dismissed' | 'recently_contacted';
    }
  | { kind: 'diagnostic'; diagnostic: TodayDiagnostic };

export type TodayCandidateLoadResult =
  | { kind: 'candidate'; candidate: ParsedTodayCandidate }
  | { kind: 'diagnostic'; diagnostic: TodayDiagnostic };
```

All public inputs and outputs are strict, recursively readonly, and recursively
frozen. Diagnostics contain stable IDs/reason codes only, never phone/email
values, arbitrary SQL text, or malformed raw JSON. Serialization of two calls
over identical explicit candidates/configuration is byte-identical and neither
call mutates its inputs.

- [ ] **Step 3: Write RED first-match lane and promise/discretionary tests**

`classifyTodayCandidate(candidate, context)` is pure and assigns one first match
in this exact order:

1. `won_onboarding`: workflow is `onboarding`; due time, suppression, priority,
   and capacity cannot displace it.
2. `inbound_interrupt`: `work_intent='inbound_response'` and
   `asOf < inboundSla.dueAt`.
3. `overdue`: a non-discretionary action has `dueAt < asOf`, or an inbound SLA
   is breached at `asOf >= inboundSla.dueAt`.
4. `post_interview_offer`: a `promised_follow_up` at Interviewed/Offered is due
   in founder-local Today but is not yet overdue.
5. `due_primary`: any other non-discretionary/internal authoritative action is
   due in founder-local Today; this includes Unreviewed review and
   resolve-contact work and does not require an active cadence.
6. `new_p0`: a `discretionary_prospecting` Ready action with effective P0.
7. `p1`: a `discretionary_prospecting` Ready action with effective P1.
8. `exploration`: a `discretionary_prospecting` Ready action with effective
   P2/P3.
9. `later`: a future promise, capacity overflow, or exploration-quota overflow,
   retaining its original lane/reason.

Build fixtures that qualify for several conditions simultaneously and prove the
first match. In particular, prove a Day-0 Ready call marked
`discretionary_prospecting` remains in P0/P1/exploration even though its due time
is now or earlier; due time never lets that action evade capacity. Prove
resolver/retry/reschedule inherits its stored intent, onboarding outranks an
overdue action, fresh inbound outranks overdue action time until its SLA
deadline, and the exact SLA deadline enters Overdue.

An active snooze/dismiss and the re-surface interval
`[lastContactAt, lastContactAt + resurfacingWindowSeconds)` suppress only rows
that would enter lanes 6-8. They never suppress lanes 1-5. At the exact end of
the interval the row may reappear; a future or malformed last contact is a
diagnostic. Suppressed rows use the separate `suppressed` disposition and are
not relabeled Later.

- [ ] **Step 4: Write RED local-calendar and inbound-SLA boundary tests**

`TodayService.build` reads its injected Clock exactly once into canonical
`generatedAt`. It accepts one strict IANA founder/workspace timezone and frozen
policy/capacity snapshots. Compute local Today as the DST-safe half-open
wall-clock interval `[localMidnight, nextLocalMidnight)`, independent of
`process.env.TZ`. The founder workspace timezone decides Today membership;
stored action timezone is still strictly validated and displayed but does not
silently move a row between founder-local dates.

Overdue is strict `dueAt < generatedAt`; equality is due now. A non-overdue row
is due today when `dueAt` lies in the local-day interval. Test exact now, both
midnights, spring-forward/fall-back days, Sunday policy boundaries, invalid
zones/timestamps, and identical output under at least two process timezones.

Task 12 validates rather than recomputes persisted inbound SLA. Use direct
Task 9 tests plus Today render tests for inbound demo at 14:59.999 versus
15:00.000 accumulated permitted minutes and direct referral at 47:59:59.999
versus 48 elapsed hours. Validate SourceEvent owner, observed time, policy ID,
calculation constants, JSON/column due equality, and half-open boundary.

- [ ] **Step 5: Write RED exact ordering, pin, and SQL-parity tests**

Apply pin only after lane assignment. It never crosses onboarding, inbound,
overdue, promised, or discretionary lane boundaries. An active interval is
`createdAt <= generatedAt < expiresAt`; equality at expiration is inactive.

For lanes 1, 3, 4, and 5, order by:

```text
pin first within lane
due_at ascending
stage_entered_at ascending (oldest stage first)
cadence step sequence ascending, NULL last
current action ID COLLATE BINARY
cycle ID COLLATE BINARY
```

Inbound orders by pin, SLA due, action due, stage age, action ID, cycle ID. In
fixed-priority P0/P1 lanes, order by pin then Task 11's exact exported tuple. In
Exploration, P2 always precedes P3; within each effective priority, pin precedes
then the remainder of the exact Task 11 tuple. A pinned P3 therefore cannot
jump any P2. Later orders by deferred-from lane rank, original within-lane
ordinal, then stable cycle ID.

Task 12 never copies, reduces, or adds arithmetic to Task 11's tuple. The V1
repository uses stable-cycle SQL ordering only and lets pure JS own semantic
lane order/capacity. `todayOrderingSqlParity.test.ts` inserts randomized and
boundary-heavy snapshots in shuffled orders, uses Task 11's shared fixed SQL
fragment for the discretionary suborder, and requires the same Prospect-ID
sequence as the Task 11 JS comparator before Today adds lane/pin. Add a static
ban on blended/generic score fields, SQL priority arithmetic, enum text ordering,
omitted stable IDs, and any capacity `LIMIT` before classification.

- [ ] **Step 6: Write RED durable capacity and exploration tests**

Validate all capacity fields as safe nonnegative integers. Conversation target
is reported only and never truncates any lane. Determine the founder-local day
start/end and count immutable outbound call Activities in that interval whose
strict `TodaySelectedCallReceiptV1` names a discretionary call. Reject or
diagnose malformed receipts, wrong action/cycle ownership, non-call Activities,
promise/inbound/onboarding actions carrying the receipt, and receipt
timezone/local-date disagreement. Provider/idempotency replay counts once.

Apply capacity exactly:

```text
remaining = max(0, dialBudget - completedDiscretionaryDialCount)
select up to explorationSlots from ordered P2 then P3 candidates
retain as many selected exploration calls as remaining permits
retain every selected exploration non-call without consuming remaining
subtract retained exploration calls from remaining
retain every P0/P1 discretionary non-call without consuming remaining
retain P0 discretionary calls, then P1 discretionary calls, up to remaining
move only overflow discretionary calls and exploration-quota overflow to Later
```

This reserves learning capacity without allowing exploration to exceed the
remaining daily dial budget. Promise/onboarding/inbound call rows are always
visible and do not increment the discretionary dial counters. The queue reports
completed, queued, sum, and remaining separately. Test budgets 0, 1, and 40;
completed counts below/at/above budget; more than forty promise calls; unlimited
discretionary text/email/resolve work; fewer/more than two exploration
candidates; mixed call/non-call exploration; P2 before P3; refresh/restart after
Activity persistence; exact provider replay; and capacity overflow retaining
the original relative order in Later.

- [ ] **Step 7: Write RED opt-out, coherent-snapshot, and binding tests**

Construct `TodayRepository` and `TodayService` around the exact same
`AppDatabase`/`DomainUnitOfWork`; require repository, Task 11 priority reader,
and Task 10 permission service binding assertions before clock access or reads.
Reads reject an already-active raw write transaction, then execute one
synchronous deferred read transaction. Candidate/action/cadence/projection,
controls, last Activity, selected-call counts, and `inspectPerson` must see one
coherent before-or-after snapshot.

SQL `persons.opted_out=0` is only the cheap first filter. Call
`OutboundPermissionService.inspectPerson` for every candidate inside the read
snapshot. A blocked result produces no actionable item and only a sanitized
`outbound_permission_blocked` diagnostic. Test independent connections where
opt-out commits before Today begins (row omitted) and after Today's snapshot
linearizes (the returned snapshot may be stale, but Task 10's mandatory
`assertMayExecuteOutbound` blocks a later click/handoff). Never claim the read
model can close that unavoidable post-render race.

Race a priority/control/Activity writer against build and prove the queue sees
the complete before or after state, never torn fields, duplicate cycles, a
partially consumed dial receipt, or raw `SQLITE_BUSY`. Trace and
`total_changes()` assertions prove Task 12 performs zero writes, consumes no
IDs, changes no pragma, and starts no immediate/nested transaction.

- [ ] **Step 8: Run the complete RED Today slice**

Run:

```bash
npx vitest run \
  tests/main/todayRepository.test.ts \
  tests/main/todayOrdering.test.ts \
  tests/main/todayService.test.ts \
  tests/integration/todayOrderingSqlParity.test.ts \
  tests/integration/todaySnapshot.test.ts \
  tests/main/noBlendedScore.test.ts \
  tests/main/optOutService.test.ts \
  tests/main/nextActionInvariant.test.ts
```

Expected: FAIL because Today modules are absent.

- [ ] **Step 9: Implement the pure Today planner and ordering first**

```ts
export function classifyTodayCandidate(
  candidate: ParsedTodayCandidate,
  context: TodayEvaluationContext,
): TodayPreCapacityDisposition;

export function compareTodayItems(left: TodayItem, right: TodayItem): number;

export function planTodayQueue(input: {
  candidates: readonly ParsedTodayCandidate[];
  generatedAt: string;
  timezone: string;
  capacity: TodayCapacity;
  completedDiscretionaryDialCount: number;
}): TodayQueue;
```

These functions import no database, repository, Clock, ID generator, lifecycle
service, permission service, or ambient time/randomness. They strictly parse
inputs, use Task 11's exported comparator, return recursively frozen outputs,
and do not mutate caller arrays/objects. Static scans reject `Date.now()`,
zero-argument `new Date`, `Math.random`, SQL imports, generic score fields, or a
locally reimplemented Fit/Timing combination.

- [ ] **Step 10: Implement strict read-only repository APIs**

Expose:

```ts
export class TodayRepository {
  constructor(input: {
    database: AppDatabase;
    unitOfWork: DomainUnitOfWork;
  });
  assertBoundTo(database: AppDatabase, unitOfWork: DomainUnitOfWork): void;
  listOperationalCandidates(): readonly TodayCandidateLoadResult[];
  loadCompletedDiscretionaryDialUsage(input: {
    dayStartAt: string;
    dayEndAt: string;
    timezone: string;
    localDate: string;
  }): {
    activityIds: readonly string[];
    count: number;
    diagnostics: readonly {
      activityId: string;
      cycleId: string | null;
      kind: 'invalid_selected_call_receipt';
    }[];
  };
}
```

The base query LEFT JOINs only the authoritative action, optional active
enrollment/catalog graph, Prospect/Person, current projection/evaluation, and a
correlated last Activity ordered by `(occurred_at DESC, id DESC)`. Load active
controls and immutable evaluation explanations without row multiplication.
Strict row/JSON parsers return valid parsed candidates or typed diagnostics in
stable cycle-ID order. Missing/corrupt data never makes the entire queue throw
and never causes priority recomputation.

- [ ] **Step 11: Implement the read-only Today service and snapshot guard**

Expose:

```ts
export class TodayService {
  constructor(input: {
    database: AppDatabase;
    unitOfWork: DomainUnitOfWork;
    clock: Clock;
    repository: TodayRepository;
    priorities: PrioritizationService;
    outboundPermission: OutboundPermissionService;
  });
  build(input: {
    timezone: string;
    capacity: TodayCapacity;
    channelPolicies: ChannelPolicySnapshots;
  }): TodayQueue;
}
```

Validate exact composition before reading the Clock. Read it once, enter one
deferred transaction, load the repository snapshot, obtain each strict Task 11
effective snapshot at the same `generatedAt`, inspect permission, count durable
selected-call receipts in the local day, and pass plain parsed data to
`planTodayQueue`. A discretionary projection whose `evaluatedAt` is not in the
same founder-local day is `stale_priority_projection`; Task 12 does not mutate
it. A promise item remains visible with the diagnostic because a prioritization
refresh failure cannot erase owed work.

- [ ] **Step 12: Run focused GREEN and upstream regression verification**

Run:

```bash
npx vitest run \
  tests/main/todayRepository.test.ts \
  tests/main/todayOrdering.test.ts \
  tests/main/todayService.test.ts \
  tests/integration/todayOrderingSqlParity.test.ts \
  tests/integration/todaySnapshot.test.ts \
  tests/main/noBlendedScore.test.ts \
  tests/main/optOutService.test.ts \
  tests/main/prioritizationRepository.test.ts \
  tests/main/prioritizationService.test.ts \
  tests/main/lifecycleService.test.ts \
  tests/main/nextActionInvariant.test.ts \
  tests/main/invariantAudit.test.ts
npm run typecheck
npm run lint
npm run test
git diff --check
```

Expected: focused and full suites PASS; Task 12 performs zero writes; every
operational candidate has one disposition; promise work survives capacity and
suppression; daily discretionary usage survives refresh/restart; Task 11 order
parity and Task 10 execution barriers remain intact; and no blended score,
ambient time, early SQL limit, or bare-Prospect queue path appears.

- [ ] **Step 13: Commit the Today read model**

Run:

```bash
git add \
  src/main/domain/today \
  tests/main/todayRepository.test.ts \
  tests/main/todayOrdering.test.ts \
  tests/main/todayService.test.ts \
  tests/integration/todayOrderingSqlParity.test.ts \
  tests/integration/todaySnapshot.test.ts
git diff --cached --name-only
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
