import { dirname } from 'node:path';
import { parseRecoveryKeyMaterial } from '../security/recoveryKey';
import { createHash } from 'node:crypto';
import { openPrivateInput, sha256, writePrivateManifest, withReadOnlyEncryptedDatabases, type ReadOnlyAuditInput } from '../db/readOnlyEncryptedDatabase';
import type { RawDatabase } from '../db/sqliteDriver';
import { normalizeCloudDisplayName } from '../domain/source/cloudNameMatching';
import { serializeIdentityMigrationManifest, type IdentityAuditCandidate, type IdentityMigrationManifest } from './identityMigrationManifest';

type PriorPerson = IdentityAuditCandidate['priorPeople'][number];
const sorted = (values: string[]) => [...new Set(values.filter(Boolean))].sort();
const normalizeAddress = (value: string) => value.normalize('NFKC').toUpperCase().replace(/\s+/g, ' ').trim();
const tableExists = (db: RawDatabase, name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

function priorPeople(before: RawDatabase): PriorPerson[] {
  if (!tableExists(before, 'persons')) return [];
  const people = before.prepare('SELECT id, display_name FROM persons WHERE deleted_at IS NULL ORDER BY id COLLATE BINARY')
    .all() as Array<{ id: string; display_name: string }>;
  return people.map(person => {
    const properties = before.prepare(`SELECT property.address_line_1, property.address_line_2,
      property.locality, property.region, property.country_code, property.postal_code
      FROM properties AS property JOIN prospect_properties AS link ON link.property_id=property.id
      JOIN prospects AS prospect ON prospect.id=link.prospect_id WHERE prospect.person_id=?`).all(person.id) as Array<{
        address_line_1: string; address_line_2: string | null; locality: string; region: string; country_code: string; postal_code: string | null;
      }>;
    return {
      priorPersonId: person.id, displayName: person.display_name,
      postalCodes: sorted(properties.map(p => normalizeAddress(p.postal_code ?? ''))),
      // Postal is kept separately so postal-only differences stay that reason.
      propertyAddresses: sorted(properties.map(p => [p.address_line_1, p.address_line_2, p.locality, p.region, p.country_code]
        .filter(Boolean).map(normalizeAddress).join(', '))),
      cloudEntityIds: tableExists(before, 'cloud_entity_links')
        ? sorted((before.prepare('SELECT cloud_entity_id FROM cloud_entity_links WHERE person_id=?').all(person.id) as { cloud_entity_id: string }[])
          .map(row => row.cloud_entity_id)) : [],
      sourceEventIds: sorted((before.prepare('SELECT id FROM source_events WHERE person_id=?').all(person.id) as { id: string }[]).map(row => row.id)),
    };
  });
}

function currentOwner(current: RawDatabase, person: PriorPerson): string | undefined {
  const owners = new Set<string>();
  // An extant prior identity must agree with every retained link. Missing or
  // divergent evidence is not replaced by a same-name guess.
  const existing = current.prepare('SELECT id FROM persons WHERE id=? AND deleted_at IS NULL').get(person.priorPersonId) as { id: string } | undefined;
  if (existing) owners.add(existing.id);
  for (const id of person.sourceEventIds) {
    const row = current.prepare('SELECT person_id FROM source_events WHERE id=?').get(id) as { person_id: string } | undefined;
    if (!row) return undefined;
    owners.add(row.person_id);
  }
  for (const id of person.cloudEntityIds) {
    const row = current.prepare('SELECT person_id FROM cloud_entity_links WHERE cloud_entity_id=?').get(id) as { person_id: string } | undefined;
    if (!row) return undefined;
    owners.add(row.person_id);
  }
  if (owners.size !== 1) return undefined;
  const owner = [...owners][0];
  return current.prepare('SELECT 1 FROM persons WHERE id=? AND deleted_at IS NULL').get(owner) ? owner : undefined;
}

function conflicts(people: PriorPerson[]): IdentityAuditCandidate['conflictReasons'] {
  const reasons: IdentityAuditCandidate['conflictReasons'] = [];
  const fields = [
    ['postalCodes', 'DIFFERENT_POSTAL_CODES'],
    ['propertyAddresses', 'DIFFERENT_PROPERTY_ADDRESSES'],
    ['cloudEntityIds', 'DIFFERENT_CLOUD_ENTITY_IDS'],
  ] as const;
  for (const [field, reason] of fields) {
    // Missing evidence is unknown, not a conflict. Identical multi-value sets
    // remain genuine duplicates rather than false splits.
    const known = people.map(p => p[field]).filter(values => values.length > 0);
    if (new Set(known.map(values => JSON.stringify(values))).size > 1) reasons.push(reason);
  }
  return reasons;
}

export function auditIdentityMigration(input: ReadOnlyAuditInput & { generatedAt: string }): IdentityMigrationManifest {
  return withReadOnlyEncryptedDatabases(input, ({ before, current, beforeDatabaseSha256, currentDatabaseSha256 }) => {
    const groups = new Map<string, { name: string; currentPersonId: string; people: PriorPerson[] }>();
    for (const person of priorPeople(before)) {
      const name = normalizeCloudDisplayName(person.displayName);
      const owner = currentOwner(current, person);
      if (!name || !owner) continue;
      const key = JSON.stringify([name, owner]);
      const group = groups.get(key) ?? { name, currentPersonId: owner, people: [] };
      group.people.push(person); groups.set(key, group);
    }
    const candidates: IdentityAuditCandidate[] = [];
    for (const group of groups.values()) {
      const conflictReasons = conflicts(group.people);
      if (group.people.length < 2 || conflictReasons.length === 0) continue;
      candidates.push({
        candidateId: createHash('sha256').update(JSON.stringify([
          group.name, group.currentPersonId, group.people.map(p => p.priorPersonId).sort(),
        ])).digest('hex'),
        normalizedDisplayName: group.name, currentPersonId: group.currentPersonId,
        priorPeople: group.people, conflictReasons, contactOwnership: 'unknown',
      });
    }
    candidates.sort((a, b) => {
      const left = JSON.stringify([a.normalizedDisplayName, a.currentPersonId]);
      const right = JSON.stringify([b.normalizedDisplayName, b.currentPersonId]);
      return left < right ? -1 : left > right ? 1 : 0;
    });
    const manifest: IdentityMigrationManifest = { format: 'callie-identity-migration-audit', version: 1,
      beforeDatabaseSha256, currentDatabaseSha256, generatedAt: input.generatedAt, candidates };
    serializeIdentityMigrationManifest(manifest); // Validate before returning any output.
    return manifest;
  });
}

/** Fixture/source preparation only. This does not authorize a founder audit. */
export function auditIdentityMigrationFiles(input: {
  beforeDatabasePath: string; currentDatabasePath: string;
  recoveryMaterialFile: string; outputPath: string; generatedAt: string;
}): { count: number; sha256: string; path: string } {
  const material = openPrivateInput(input.recoveryMaterialFile);
  let key: ReturnType<typeof parseRecoveryKeyMaterial> | undefined;
  try {
    key = parseRecoveryKeyMaterial(material.bytes.toString('utf8').trim());
    const manifest = auditIdentityMigration({ ...input, key, temporaryParent: dirname(input.outputPath) });
    material.assertUnchanged();
    const content = serializeIdentityMigrationManifest(manifest);
    writePrivateManifest(input.outputPath, content);
    return { count: manifest.candidates.length, sha256: sha256(content), path: input.outputPath };
  } finally { key?.bytes.fill(0); material.close(); }
}
