import { createHash } from 'node:crypto';
import { chmodSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auditIdentityMigration } from '../../../src/main/identityMigration/identityMigrationAudit';
import { withReadOnlyEncryptedDatabases } from '../../../src/main/db/readOnlyEncryptedDatabase';
import { serializeIdentityMigrationManifest } from '../../../src/main/identityMigration/identityMigrationManifest';
import { identityFixture, TIME } from './fixtures';

const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
let fixture: Awaited<ReturnType<typeof identityFixture>>;
const input = () => ({ beforeDatabasePath: fixture.before, currentDatabasePath: fixture.current,
  key: fixture.key(), temporaryParent: fixture.directory, generatedAt: TIME });
let hashes: string[];
beforeEach(async () => { fixture = await identityFixture(); hashes = [hash(fixture.before), hash(fixture.current)]; });
afterEach(() => { fixture?.cleanup(); });
const unchanged = () => expect([hash(fixture.before), hash(fixture.current)]).toEqual(hashes);

describe('read-only schema8 identity migration audit', () => {
  it('finds each evidence conflict, never splits by name alone or identical evidence, and retains unknown ownership', () => {
    expect(readFileSync(fixture.before).subarray(0, 16).toString()).not.toBe('SQLite format 3\0');
    const request = input();
    const manifest = auditIdentityMigration(request);
    expect(manifest).toMatchObject({ format: 'callie-identity-migration-audit', version: 1,
      beforeDatabaseSha256: hashes[0], currentDatabaseSha256: hashes[1], generatedAt: TIME });
    expect(manifest.candidates.map(c => [c.normalizedDisplayName, c.currentPersonId, c.conflictReasons, c.contactOwnership]))
      .toEqual([
        ['ADDRESS LLC', 'address-a', ['DIFFERENT_PROPERTY_ADDRESSES'], 'unknown'],
        ['CLOUD LLC', 'cloud-a', ['DIFFERENT_CLOUD_ENTITY_IDS'], 'unknown'],
        ['POSTAL LLC', 'postal-a', ['DIFFERENT_POSTAL_CODES'], 'unknown'],
      ]);
    expect(manifest.candidates.map(c => c.candidateId)).toEqual([
      '6a27f50422be51bad53851a9d531856b6be8ba23764f4cce9c4833626748d09a',
      '5e36d8d143e64fb9e8671fef071ebcc9d16f02e30606c15fe9685b876046f8ec',
      '59b955cdc2dbf08b1a3547188421f6cbdc12a2257868057ccbdd5d8fdafadf68',
    ]);
    expect(manifest.candidates[0].priorPeople).toEqual([
      { priorPersonId: 'address-a', displayName: 'address LLC', postalCodes: ['02100'],
        propertyAddresses: ['1 EXAMPLE ROAD, EXAMPLE CITY, MA, US'], cloudEntityIds: [], sourceEventIds: ['event-address-a'] },
      { priorPersonId: 'address-b', displayName: '  address llc. ', postalCodes: ['02100'],
        propertyAddresses: ['2 EXAMPLE ROAD, EXAMPLE CITY, MA, US'], cloudEntityIds: [], sourceEventIds: ['event-address-b'] },
    ]);
    expect(request.key.bytes).toEqual(Buffer.alloc(32));
    expect(serializeIdentityMigrationManifest(auditIdentityMigration(input())))
      .toBe(serializeIdentityMigrationManifest(manifest));
    unchanged();
  });

  it('opens only private copies read-only, prevents DML and cleans up even when analysis throws', () => {
    const request = input();
    const entries = readdirSync(fixture.directory);
    expect(() => withReadOnlyEncryptedDatabases(request, ({ before, current }) => {
      for (const db of [before, current]) {
        expect(db.readonly).toBe(true);
        expect(db.name).not.toBe(fixture.before);
        expect(statSync(db.name).mode & 0o777).toBe(0o600);
        expect(statSync(dirname(db.name)).mode & 0o777).toBe(0o700);
        expect(() => db.prepare('DELETE FROM persons').run()).toThrow();
      }
      throw new Error('synthetic analysis failure');
    })).toThrow('synthetic analysis failure');
    expect(request.key.bytes).toEqual(Buffer.alloc(32));
    expect(readdirSync(fixture.directory)).toEqual(entries);
    unchanged();
  });

  it.each([
    ['schema14', 'UPDATE app_meta SET schema_version=14'],
    ['schema16', 'UPDATE app_meta SET schema_version=16'],
    ['schema17', 'UPDATE app_meta SET schema_version=17'],
    ['missing ledger', "DELETE FROM kysely_migration WHERE name='0015RecoveryMetadata'"],
    ['extra ledger', "INSERT INTO kysely_migration VALUES ('0016Future', '2099')"],
    ['reordered ledger', "UPDATE kysely_migration SET timestamp='1900' WHERE name='0015RecoveryMetadata'"],
    ['wrong ledger', "UPDATE kysely_migration SET name='0015Other' WHERE name='0015RecoveryMetadata'"],
    ['missing trigger', 'DROP TRIGGER immutable_identity_repair_events'],
    ['weakened trigger', `DROP TRIGGER immutable_backup_receipts; CREATE TRIGGER immutable_backup_receipts BEFORE UPDATE ON backup_receipts BEGIN SELECT 1; END`],
    ['extra table', 'CREATE TABLE unwanted (id TEXT)'],
    ['missing index', 'DROP INDEX activities_person_occurred_idx'],
  ])('rejects %s before copies or output and preserves inputs', (_name, sql) => {
    fixture.mutate(fixture.current, sql);
    hashes = [hash(fixture.before), hash(fixture.current)];
    const entries = readdirSync(fixture.directory);
    const request = input();
    expect(() => auditIdentityMigration(request)).toThrow();
    expect(request.key.bytes).toEqual(Buffer.alloc(32));
    expect(readdirSync(fixture.directory)).toEqual(entries);
    unchanged();
  });

  it.each(['before', 'current'] as const)('rejects symlink and public %s input without changing hashes', which => {
    const original = fixture[which];
    const linked = join(fixture.directory, 'link.db');
    symlinkSync(original, linked);
    const request = { ...input(), [which === 'before' ? 'beforeDatabasePath' : 'currentDatabasePath']: linked };
    expect(() => auditIdentityMigration(request)).toThrow();
    expect(request.key.bytes).toEqual(Buffer.alloc(32));
    chmodSync(original, 0o644);
    expect(() => auditIdentityMigration(input())).toThrow();
    unchanged();
  });

  it('rejects active sidecars without changing either snapshot', () => {
    const sidecar = `${fixture.current}-wal`;
    writeFileSync(sidecar, 'sentinel', { mode: 0o600 });
    expect(() => auditIdentityMigration(input())).toThrow();
    unchanged();
  });

  it('zeroes a wrong key and never creates a copy', () => {
    const request = input(); request.key.bytes.fill(0x11);
    const entries = readdirSync(fixture.directory);
    expect(() => auditIdentityMigration(request)).toThrow();
    expect(request.key.bytes).toEqual(Buffer.alloc(32));
    expect(readdirSync(fixture.directory)).toEqual(entries);
    unchanged();
  });

  it('rejects before schema8 instead of silently treating it as retained evidence', () => {
    fixture.mutate(fixture.before, 'UPDATE app_meta SET schema_version=8');
    hashes[0] = hash(fixture.before);
    expect(() => auditIdentityMigration(input())).toThrow();
    unchanged();
  });
});
