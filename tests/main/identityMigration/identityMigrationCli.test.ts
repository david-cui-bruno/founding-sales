import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, watch, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { identityFixture } from './fixtures';
import { closeDatabase, openDatabase } from '../../../src/main/db/database';

const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
let fixture: Awaited<ReturnType<typeof identityFixture>>;
let hashes: string[];
let auditPath: string;
let output: string;
const run = (script: string, args: string[]) => spawnSync(process.execPath, [resolve('scripts', script), ...args], {
  encoding: 'utf8', timeout: 15_000, env: { ...process.env },
});
const args = () => ['--before-database', fixture.before, '--current-database', fixture.current,
  '--recovery-material-file', fixture.material, '--output', auditPath];
const unchanged = () => expect([hash(fixture.before), hash(fixture.current), hash(fixture.material)]).toEqual(hashes);
const rejectAudit = async (argv = args()) => {
  const created: string[] = [];
  const watcher = watch(fixture.directory, (_event, file) => { if (file) created.push(file.toString()); });
  const result = run('runIdentityMigrationAudit.mjs', argv);
  await new Promise(resolve => setTimeout(resolve, 20));
  watcher.close();
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('Identity migration audit failed.\n');
  expect(existsSync(auditPath)).toBe(false);
  expect(created.filter(file => file.startsWith('.identity-audit-'))).toEqual([]);
  unchanged();
};

beforeAll(() => {
  const build = run('buildOperationalTools.mjs', []);
  expect({ status: build.status, stderr: build.stderr }).toEqual({ status: 0, stderr: '' });
});
beforeEach(async () => {
  fixture = await identityFixture();
  hashes = [hash(fixture.before), hash(fixture.current), hash(fixture.material)];
  auditPath = join(fixture.directory, 'audit.json');
  output = join(fixture.directory, 'review.json');
});
afterEach(() => fixture?.cleanup());

describe('fixture-only operational CLI contracts', () => {
  it('observes actual temporary-copy creation on success so rejection event checks are meaningful', async () => {
    const events: string[] = [];
    const watcher = watch(fixture.directory, (_event, file) => { if (file) events.push(file.toString()); });
    const result = run('runIdentityMigrationAudit.mjs', args());
    await new Promise(resolve => setTimeout(resolve, 20));
    watcher.close();
    expect(result.status).toBe(0);
    expect(events.some(file => file.startsWith('.identity-audit-'))).toBe(true);
    expect(readdirSync(fixture.directory).some(file => file.startsWith('.identity-audit-'))).toBe(false);
    unchanged();
  });

  it('rejects closed WAL-header snapshots without creating source sidecars or temporary copies', async () => {
    const db = openDatabase({ path: fixture.current, key: fixture.key() });
    closeDatabase(db);
    hashes[1] = hash(fixture.current);
    await rejectAudit();
    expect(existsSync(fixture.current + '-wal')).toBe(false);
    expect(existsSync(fixture.current + '-shm')).toBe(false);
  });

  it('builds runnable audit/finalizer, emits private manifests, logs only count/hash/path and preserves all inputs', () => {
    const result = run('runIdentityMigrationAudit.mjs', args());
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toEqual({ count: 3, sha256: hash(auditPath), path: auditPath });
    expect(statSync(auditPath).mode & 0o777).toBe(0o600);
    const audit = JSON.parse(readFileSync(auditPath, 'utf8'));
    const decisions = join(fixture.directory, 'decisions.json');
    writeFileSync(decisions, JSON.stringify(audit.candidates.map((c: { candidateId: string }, index: number) => ({
      candidateId: c.candidateId, decision: index === 0 ? 'approved' : 'rejected',
    }))), { mode: 0o600 });
    const immutableHashes = [hash(auditPath), hash(decisions)];
    const reviewed = run('finalizeIdentityMigrationReview.mjs', ['--audit-manifest', auditPath, '--decisions', decisions, '--output', output]);
    expect({ status: reviewed.status, stderr: reviewed.stderr }).toEqual({ status: 0, stderr: '' });
    expect(JSON.parse(reviewed.stdout)).toEqual({ count: 3, sha256: hash(output), path: output });
    expect(statSync(output).mode & 0o777).toBe(0o600);
    const manifest = JSON.parse(readFileSync(output, 'utf8'));
    expect(manifest.auditManifestSha256).toBe(hash(auditPath));
    expect(manifest.approvedCandidateIds).toHaveLength(1);
    expect(manifest.rejectedCandidateIds).toHaveLength(2);
    expect(new Date(manifest.reviewedAt).toISOString()).toBe(manifest.reviewedAt);
    expect([hash(auditPath), hash(decisions)]).toEqual(immutableHashes);
    expect(readdirSync(fixture.directory).filter(file => file.startsWith('.identity-audit-'))).toEqual([]);
    unchanged();
  });

  it.each([14, 16, 17])('rejects current schema%s before any temp creation, output, or dry-run output', async version => {
    fixture.mutate(fixture.current, `UPDATE app_meta SET schema_version=${version}`);
    hashes[1] = hash(fixture.current);
    await rejectAudit();
  });

  it.each([
    "DELETE FROM kysely_migration WHERE name='0015RecoveryMetadata'",
    "INSERT INTO kysely_migration VALUES ('0016Future', '2099')",
    "UPDATE kysely_migration SET timestamp='1900' WHERE name='0015RecoveryMetadata'",
    'DROP TRIGGER protect_restore_drill_backup_receipt',
  ])('rejects inconsistent schema15 catalog/ledger %# before creating anything', async sql => {
    fixture.mutate(fixture.current, sql); hashes[1] = hash(fixture.current); await rejectAudit();
  });

  it.each(['symlink', 'hardlink', 'directory', 'fifo', 'public-file', 'public-parent', 'symlink-parent', 'plaintext', 'wrong-key'])(
    'rejects unsafe %s input without writes', async scenario => {
      const altered = args();
      const path = join(fixture.directory, 'unsafe');
      if (scenario === 'symlink') symlinkSync(fixture.current, path);
      if (scenario === 'hardlink') linkSync(fixture.current, path);
      if (scenario === 'directory') mkdirSync(path, { mode: 0o700 });
      if (scenario === 'fifo') expect(spawnSync('/usr/bin/mkfifo', [path]).status).toBe(0);
      if (scenario === 'public-file') chmodSync(fixture.current, 0o644);
      if (scenario === 'public-parent') chmodSync(fixture.directory, 0o755);
      if (scenario === 'symlink-parent') {
        symlinkSync(fixture.directory, path);
        altered[3] = join(path, 'current.db');
      }
      if (scenario === 'plaintext') writeFileSync(path, 'SQLite format 3\0not encrypted', { mode: 0o600 });
      if (scenario === 'wrong-key') {
        writeFileSync(fixture.material, 'not-a-valid-fixture-key'); hashes[2] = hash(fixture.material);
      }
      if (['symlink', 'hardlink', 'directory', 'fifo', 'plaintext'].includes(scenario)) altered[3] = path;
      await rejectAudit(altered);
    });

  it('rejects material-file symlinks and public recovery text', async () => {
    const path = join(fixture.directory, 'material-link'); symlinkSync(fixture.material, path);
    const altered = args(); altered[5] = path; await rejectAudit(altered);
    chmodSync(fixture.material, 0o644); await rejectAudit();
  });

  it.each(['omitted', 'unknown', 'duplicate', 'relative', 'override'])('rejects %s CLI arguments without defaults', async scenario => {
    const altered = args();
    if (scenario === 'omitted') altered.splice(0, 2);
    if (scenario === 'unknown') altered.push('--mode', 'dry-run');
    if (scenario === 'duplicate') altered[2] = '--before-database';
    if (scenario === 'relative') altered[1] = 'before.db';
    if (scenario === 'override') altered.push('--expected-current-schema', '16');
    await rejectAudit(altered);
  });

  it('never overwrites an existing output or follows an output symlink', () => {
    writeFileSync(auditPath, 'keep this output', { mode: 0o600 });
    const digest = hash(auditPath);
    expect(run('runIdentityMigrationAudit.mjs', args()).status).toBe(1);
    expect(hash(auditPath)).toBe(digest);
    const altered = args(); altered[7] = join(fixture.directory, 'output-link'); symlinkSync(fixture.current, altered[7]);
    expect(run('runIdentityMigrationAudit.mjs', altered).status).toBe(1);
    unchanged();
  });

  it.each(['missing', 'duplicate', 'unknown', 'symlink', 'public', 'extra-field', 'bad-audit', 'output-existing', 'relative'])(
    'finalizer rejects %s while preserving immutable audit/decision bytes', scenario => {
      expect(run('runIdentityMigrationAudit.mjs', args()).status).toBe(0);
      const audit = JSON.parse(readFileSync(auditPath, 'utf8'));
      let rows = audit.candidates.map((c: { candidateId: string }) => ({ candidateId: c.candidateId, decision: 'approved' }));
      if (scenario === 'missing') rows = rows.slice(1);
      if (scenario === 'duplicate') rows.push(rows[0]);
      if (scenario === 'unknown') rows[0].candidateId = 'unknown';
      if (scenario === 'extra-field') rows[0].extra = true;
      const decisions = join(fixture.directory, 'decisions.json');
      writeFileSync(decisions, JSON.stringify(rows), { mode: 0o600 });
      const argv = ['--audit-manifest', auditPath, '--decisions', decisions, '--output', output];
      if (scenario === 'symlink') { argv[3] += '.link'; symlinkSync(decisions, argv[3]); }
      if (scenario === 'public') chmodSync(decisions, 0o644);
      if (scenario === 'bad-audit') writeFileSync(auditPath, '{"version":2}');
      if (scenario === 'output-existing') writeFileSync(output, 'unchanged', { mode: 0o600 });
      if (scenario === 'relative') argv[1] = 'audit.json';
      const before = [hash(auditPath), hash(decisions)];
      const result = run('finalizeIdentityMigrationReview.mjs', argv);
      expect({ status: result.status, stdout: result.stdout, stderr: result.stderr })
        .toEqual({ status: 1, stdout: '', stderr: 'Identity migration review failed.\n' });
      expect([hash(auditPath), hash(decisions)]).toEqual(before);
      if (scenario === 'output-existing') expect(readFileSync(output, 'utf8')).toBe('unchanged');
      else expect(existsSync(output)).toBe(false);
      unchanged();
    });
});
