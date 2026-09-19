import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { REPLY_TEMPLATE_SEEDS } from '../../src/main/outreach/templates/replyTemplateSeeds';
import { cutoverExportFileName, CutoverExportRefusedError, performCutoverExport,
  type CutoverExportDependencies } from '../../src/main/cutoverExport';
import { parseCutoverExport } from '../../src/shared/contracts/cutoverExportContract';
import { resolveApplicationPaths } from '../../src/main/applicationPaths';
import { createTempDatabase, createTestWorkspaceKey } from '../fixtures/tempDatabase';

/**
 * The one-off Mac export (slice S6), on a fixture database only. It never opens David's live database, and the
 * export code itself never writes to whatever database it does open: the connection is read-only.
 */

const NOW = '2026-09-19T11:00:00.000Z';
const SEED = REPLY_TEMPLATE_SEEDS[0]!;

/** A migrated fixture database with two firms, a promised callback, a never-call mark and one edited template. */
async function fixtureWorkspace() {
  const userData = mkdtempSync(join(tmpdir(), 'callie-cutover-export-'));
  const destination = join(userData, 'exports');
  const paths = resolveApplicationPaths(userData);
  const temp = createTempDatabase();
  const key = createTestWorkspaceKey(0x5c);
  const database = openDatabase({ path: paths.databasePath, key: createTestWorkspaceKey(0x5c) });
  await migrateToLatest(database, { backupDirectory: `${paths.databasePath}.backups`, workspaceKey: createTestWorkspaceKey(0x5c) });
  const raw = database.raw;
  const insertAccount = raw.prepare('INSERT INTO pm_accounts(id,name,domain,version,created_at,updated_at) VALUES(?,?,?,1,?,?)');
  for (const [id, name] of [['account-ri-1', 'Rhode Island Firm 1'], ['account-ri-2', 'Rhode Island Firm 2']]) insertAccount.run(id, name, null, NOW, NOW);
  raw.prepare(`INSERT INTO pm_account_callbacks(id,account_id,due_on,note,state,revision,source_command_id,created_at,updated_at)
      VALUES(?,?,?,?,?,1,?,?,?)`)
    .run(randomUUID(), 'account-ri-1', '2026-09-22', 'ring the office manager', 'open', 'command-0001', NOW, NOW);
  raw.prepare(`INSERT INTO pm_account_suppression_tombstones(id,account_id,observed_at,source,evidence_ref,admitted_at) VALUES(?,?,?,?,?,?)`)
    .run(randomUUID(), 'account-ri-2', NOW, 'human_never_call', 'call-0002', NOW);
  // Two templates: one left exactly at its seed, one David edited. Only the edited one may travel.
  raw.prepare(`UPDATE email_templates SET subject=?, body=?, revision=revision+1, updated_at=? WHERE id=?`)
    .run(SEED.subject, `${SEED.body}\n\nPS: we are local to Providence.`, NOW, SEED.id);
  closeDatabase(database);
  const deps = (overrides: Partial<CutoverExportDependencies> = {}): CutoverExportDependencies => ({
    acquireLock: () => true, releaseLock: () => {}, ready: async () => {},
    paths: () => paths, loadKey: async () => createTestWorkspaceKey(0x5c),
    destination: () => destination, now: () => NOW,
    phoneSetup: () => ({ status: 'confirmed', confirmedAt: '2026-09-10T08:00:00.000Z', proofDigest: 'a'.repeat(64) }),
    ...overrides,
  });
  return { paths, destination, deps, key, cleanup: () => { rmSync(userData, { recursive: true, force: true }); temp.cleanup(); } };
}

describe('the cutover export from the old app', () => {
  it('writes the three record kinds and the phone status, with the counts it printed', async () => {
    const f = await fixtureWorkspace();
    try {
      const report = await performCutoverExport(f.deps());
      expect(report.counts).toEqual({ callbacks: 1, neverCall: 1, templates: 1 });
      expect(report.path).toBe(join(f.destination, cutoverExportFileName('2026-09-19')));
      expect(report.phone).toBe('confirmed');
      expect(report.schemaVersion).toBeGreaterThan(0);

      const parsed = parseCutoverExport(readFileSync(report.path, 'utf8'));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.file.callbacks).toEqual([{ firmId: 'account-ri-1', dueOn: '2026-09-22', note: 'ring the office manager',
        state: 'open', sourceCommandId: 'command-0001', promisedAt: NOW }]);
      expect(parsed.file.neverCall).toEqual([{ firmId: 'account-ri-2', observedAt: NOW, source: 'human_never_call', evidenceRef: 'call-0002' }]);
      // Only the edited body travels; the four untouched templates are the seeds the copy already carries.
      expect(parsed.file.templates.map(entry => entry.templateId)).toEqual([SEED.id]);
      expect(parsed.file.templates[0]!.body.endsWith('PS: we are local to Providence.')).toBe(true);
      expect(parsed.file.phone).toEqual({ status: 'confirmed', confirmedAt: '2026-09-10T08:00:00.000Z', proofDigest: 'a'.repeat(64) });
      // The file is David's to read: private, and exactly the bytes the report accounted for.
      expect(statSync(report.path).mode & 0o777).toBe(0o600);
      expect(statSync(report.path).size).toBe(report.bytes);
    } finally { f.cleanup(); }
  });

  it('carries no secret, no key, no path and no token', async () => {
    const f = await fixtureWorkspace();
    try {
      const report = await performCutoverExport(f.deps());
      const text = readFileSync(report.path, 'utf8');
      // The workspace key's own bytes, in either spelling, and the shapes a credential would have.
      expect(text).not.toContain(createTestWorkspaceKey(0x5c).bytes.toString('hex'));
      expect(text).not.toContain(createTestWorkspaceKey(0x5c).bytes.toString('base64'));
      expect(text).not.toContain(f.paths.databasePath);
      expect(text).not.toContain(f.paths.keyEnvelopePath);
      expect(text).not.toMatch(/"(?:token|secret|refreshToken|accessToken|envelope|key)"/i);
      // Every top-level key of the file is one the contract names, and there are no others.
      expect(Object.keys(JSON.parse(text)).sort()).toEqual(['callbacks', 'counts', 'exportedAt', 'kind', 'neverCall', 'phone', 'schemaVersion', 'templates', 'version']);
    } finally { f.cleanup(); }
  });

  it('refuses while the app is open, and refuses to replace an export it already wrote', async () => {
    const f = await fixtureWorkspace();
    try {
      let released = 0;
      await expect(performCutoverExport(f.deps({ acquireLock: () => false, releaseLock: () => { released++; } })))
        .rejects.toThrow(CutoverExportRefusedError);
      // A lock it never took is never released, and nothing was written.
      expect(released).toBe(0);
      await expect(performCutoverExport(f.deps({ acquireLock: () => false }))).rejects.toThrow('CUTOVER_EXPORT_FAILED lock');

      await performCutoverExport(f.deps());
      await expect(performCutoverExport(f.deps())).rejects.toThrow('CUTOVER_EXPORT_FAILED write');
    } finally { f.cleanup(); }
  });

  it('refuses a workspace with no database and a key it cannot load, and releases the lock either way', async () => {
    const f = await fixtureWorkspace();
    try {
      let released = 0;
      const release = () => { released++; };
      await expect(performCutoverExport(f.deps({ releaseLock: release, paths: () => resolveApplicationPaths(join(f.destination, 'absent')) })))
        .rejects.toThrow('CUTOVER_EXPORT_FAILED paths');
      await expect(performCutoverExport(f.deps({ releaseLock: release, loadKey: async () => { throw new Error('protector unavailable'); } })))
        .rejects.toThrow('CUTOVER_EXPORT_FAILED key');
      await expect(performCutoverExport(f.deps({ releaseLock: release, loadKey: async () => createTestWorkspaceKey(0x11) })))
        .rejects.toThrow('CUTOVER_EXPORT_FAILED read');
      expect(released).toBe(3);
    } finally { f.cleanup(); }
  });
});
