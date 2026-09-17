import { randomUUID, createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase } from '../../../../src/main/db/database';
import { createMigrationRunner, migrateToLatest, productionMigrations } from '../../../../src/main/db/migrate';
import { createDomainServices } from '../../../../src/main/domain/createDomainServices';
import { BUILTIN_PRIORITIZATION_RULE_V1 } from '../../../../src/main/domain/prioritization/builtinPrioritizationRules';
import { assertDomainStorageReady, DOMAIN_SCHEMA_MANIFEST } from '../../../../src/main/domain/startup/storageReadiness';
import { beginDiscoveryRequestSchema, beginDiscoveryReceiptSchema, type DiscoveryAssessment } from '../../../../src/shared/contracts/discoveryContract';
import { discoveryAssessment, DISCOVERY_NOW, seedDiscoveryOwner, type DiscoveryDatabase } from '../../../fixtures/discoveryDatabase';
import { createTempDatabase, createTestWorkspaceKey } from '../../../fixtures/tempDatabase';

describe('0017 discovery assessments migration', () => {
  let f: DiscoveryDatabase;
  let owner: ReturnType<typeof seedDiscoveryOwner>;
  let other: ReturnType<typeof seedDiscoveryOwner>;
  beforeEach(async () => {
    const temp = createTempDatabase(); const key = createTestWorkspaceKey();
    const database = openDatabase({ path: temp.path, key });
    await createMigrationRunner(productionMigrations.filter(x => x.schemaVersion <= 16))(database,
      { workspaceKey: key, backupDirectory: `${temp.path}.backups` });
    const services = createDomainServices({ database, clock: { now: () => DISCOVERY_NOW }, ids: { next: randomUUID } });
    services.unitOfWork.immediate(() => {
      services.prioritizationRepository.installRuleVersion(BUILTIN_PRIORITIZATION_RULE_V1);
      services.cadences.installBuiltins();
    });
    f = { database, services, temp, key, close() { closeDatabase(database); key.bytes.fill(0); temp.cleanup(); } };
    owner = seedDiscoveryOwner(f, { prefix: 'one', units: 10, legacyUnreviewed: true });
    other = seedDiscoveryOwner(f, { prefix: 'two', units: null, legacyUnreviewed: true });
  });
  afterEach(() => f?.close());
  const migrate = () => migrateToLatest(f.database, { workspaceKey: f.key, backupDirectory: `${f.temp.path}.backups` });
  function insert(assessment: DiscoveryAssessment, patch: Record<string, unknown> = {}) {
    const row = { id: assessment.id, person_id: assessment.personId, prospect_id: assessment.prospectId,
      sales_cycle_id: assessment.salesCycleId, fingerprint: assessment.fingerprint,
      policy_version: assessment.policyVersion, rule_version_id: assessment.ruleVersionId,
      model_version: assessment.modelVersion, evaluated_at: assessment.evaluatedAt, expires_at: assessment.expiresAt,
      local_date: assessment.localDate, override_id: assessment.overrideId, disposition: assessment.disposition,
      assessment_json: JSON.stringify(assessment), ...patch };
    // Mutate raw columns and matching JSON together so each CHECK is tested
    // independently of the JSON/column coherence guard.
    if (!('assessment_json' in patch)) {
      const json: Record<string, unknown> = { ...assessment };
      for (const [column, key] of Object.entries({ id: 'id', person_id: 'personId', prospect_id: 'prospectId',
        sales_cycle_id: 'salesCycleId', fingerprint: 'fingerprint', policy_version: 'policyVersion',
        rule_version_id: 'ruleVersionId', model_version: 'modelVersion', evaluated_at: 'evaluatedAt',
        expires_at: 'expiresAt', local_date: 'localDate', override_id: 'overrideId', disposition: 'disposition' })) {
        if (column in patch) json[key] = patch[column];
      }
      row.assessment_json = JSON.stringify(json);
    }
    f.database.raw.prepare(`INSERT INTO discovery_assessments (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
  }
  it('adds exactly schema17 to real16 without rewriting selected business rows, and accepts the exact manifest', async () => {
    const tables = ['persons', 'prospects', 'source_events', 'source_intake_receipts', 'properties', 'sales_cycles', 'stage_events', 'recovery_readiness'];
    const snapshot = () => tables.map(table => f.database.raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const before = snapshot();
    const priorLedger = f.database.raw.prepare('SELECT name, timestamp FROM kysely_migration ORDER BY name').all();
    expect(await createMigrationRunner(productionMigrations.filter(x => x.schemaVersion <= 17))(f.database,
      { workspaceKey: f.key, backupDirectory: `${f.temp.path}.backups` }))
      .toEqual({ fromVersion: 16, toVersion: 17, appliedMigrationIds: ['0017DiscoveryAssessments'] });
    expect(f.database.raw.prepare('SELECT schema_version FROM app_meta WHERE singleton = 1').get()).toMatchObject({ schema_version: 17 });
    expect(snapshot()).toEqual(before);
    expect(await migrate()).toEqual({ fromVersion: 17, toVersion: 27, appliedMigrationIds: ['0018PlaybookDueActions', '0019EmailDrafts', '0020PmAccounts', '0021DelegatedWork', '0022MailPersistence', '0023Campaigns', '0024RequestedFollowupAndPolicyReviews', '0025KnownCompanyResearchSettings', '0026LocalCompanyDrafts', '0027ListedRouteVerification'] });
    expect(f.database.raw.prepare('SELECT name, timestamp FROM kysely_migration WHERE name < ? ORDER BY name').all('0017')).toEqual(priorLedger);
    expect(f.database.raw.prepare('SELECT name FROM kysely_migration ORDER BY name').all()).toEqual(productionMigrations.map(x => ({ name: x.id })));
    for (const table of ['discovery_assessments', 'discovery_current', 'discovery_overrides', 'discovery_preparations', 'discovery_scan_state']) {
      expect(f.database.raw.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get('table', table)).toEqual({ name: table });
    }
    expect(f.database.raw.prepare("PRAGMA index_info('jobs_type_state_created_idx')").all()).toMatchObject([
      { name: 'type' }, { name: 'state' }, { name: 'created_at' }, { name: 'id' },
    ]);
    expect(assertDomainStorageReady({ database: f.database, expectedBusyTimeoutMs: 5000,
      expectedSchemaVersion: 27, expectedManifest: DOMAIN_SCHEMA_MANIFEST }).schemaVersion).toBe(27);
    const catalog = f.database.raw.prepare(`SELECT name, type, sql FROM sqlite_master
      WHERE type IN ('table','index','trigger') AND (type <> 'index' OR sql IS NOT NULL)
      ORDER BY name COLLATE BINARY`).all() as { name: string; type: string; sql: string | null }[];
    const hash = createHash('sha256').update(JSON.stringify(catalog.map(x => [x.type, x.name, (x.sql ?? '').replace(/\s+/g, ' ').trim()])
      .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))).digest('hex');
    expect(hash).toBe(DOMAIN_SCHEMA_MANIFEST.catalogSha256);
    expect(await migrate()).toEqual({ fromVersion: 27, toVersion: 27, appliedMigrationIds: [] });
  });

  it('guards assessment history, exact FK-valid owner tuples and pointer insert/update/version at SQL level', async () => {
    await migrate();
    const assessment = discoveryAssessment(owner); const alien = discoveryAssessment(other);
    insert(assessment); insert(alien);
    expect(() => f.database.raw.prepare('DELETE FROM discovery_assessments WHERE id = ?').run(assessment.id)).toThrow();
    expect(() => f.database.raw.prepare('UPDATE discovery_assessments SET disposition = ? WHERE id = ?').run('watch', assessment.id)).toThrow();
    for (const patch of [{ personId: other.personId }, { prospectId: other.prospectId }, { salesCycleId: other.salesCycleId }]) {
      expect(() => insert(discoveryAssessment(owner, patch))).toThrow();
    }
    // A raw FK-valid alias person does not make an otherwise different owner tuple valid.
    f.database.raw.prepare('INSERT INTO persons(id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(` ${owner.personId}`, 'Alias fixture', DISCOVERY_NOW, DISCOVERY_NOW);
    expect(() => insert(assessment, { id: randomUUID(), person_id: ` ${owner.personId}` })).toThrow();
    const pointer = f.database.raw.prepare('INSERT INTO discovery_current(prospect_id, assessment_id, version) VALUES (?, ?, ?)');
    expect(() => pointer.run(owner.prospectId, alien.id, 1)).toThrow();
    expect(() => pointer.run(owner.prospectId, assessment.id, 0)).toThrow();
    expect(() => pointer.run(owner.prospectId, assessment.id, 1.5)).toThrow();
    pointer.run(owner.prospectId, assessment.id, 1);
    expect(() => pointer.run(owner.prospectId, assessment.id, 1)).toThrow();
    expect(() => f.database.raw.prepare('UPDATE discovery_current SET assessment_id = ? WHERE prospect_id = ?').run(alien.id, owner.prospectId)).toThrow();
    expect(f.database.raw.pragma('foreign_key_check')).toEqual([]);
  });

  it.each([
    { id: 'not-uuid' }, { id: '11111111-1111-4111-1111-111111111111' },
    { id: '11111111-1111-9111-8111-111111111111' }, { disposition: 'invalid' }, { fingerprint: 'A'.repeat(64) }, { policy_version: 'future' },
    { evaluated_at: '2026-02-30T00:00:00.000Z' }, { expires_at: DISCOVERY_NOW }, { local_date: '2026-02-30' },
    { assessment_json: '{}' }, { assessment_json: '{invalid' }, { assessment_json: '[]' },
    { assessment_json: ' '.repeat(2_000_001) }, { model_version: '' },
  ])('rejects invalid raw assessment columns case %#', async patch => {
    await migrate(); insert(discoveryAssessment(owner));
    expect(() => insert(discoveryAssessment(owner), patch)).toThrow();
  });

  it('enforces override/preparation ownership, action linkage, JSON and append-only guards without the repository', async () => {
    await migrate(); const assessment = discoveryAssessment(owner); insert(assessment);
    const overrideId = randomUUID();
    const overrideSql = f.database.raw.prepare(`INSERT INTO discovery_overrides
      (id, assessment_id, person_id, prospect_id, sales_cycle_id, fingerprint, decision, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const args = [overrideId, assessment.id, owner.personId, owner.prospectId, owner.salesCycleId, assessment.fingerprint, 'watch', 'Wait for review', DISCOVERY_NOW];
    for (const [index, value] of [[2, other.personId], [3, other.prospectId], [4, other.salesCycleId], [5, 'b'.repeat(64)], [6, 'bad'], [7, ''], [8, 'bad']] as const) {
      const bad = [...args]; bad[index] = value; expect(() => overrideSql.run(...bad)).toThrow();
    }
    overrideSql.run(...args);
    const ready = f.services.lifecycle.reviewToReady({ cycleId: owner.salesCycleId, expectedCycleVersion: 1, expectedProspectVersion: 1, effectiveAt: DISCOVERY_NOW });
    const otherReady = f.services.lifecycle.reviewToReady({ cycleId: other.salesCycleId, expectedCycleVersion: 1, expectedProspectVersion: 1, effectiveAt: DISCOVERY_NOW });
    const request = beginDiscoveryRequestSchema.parse({ commandId: randomUUID(), personId: owner.personId, salesCycleId: owner.salesCycleId,
      assessmentId: assessment.id, expectedFingerprint: assessment.fingerprint });
    const receipt = beginDiscoveryReceiptSchema.parse({ personId: owner.personId, salesCycleId: owner.salesCycleId,
      assessmentId: assessment.id, actionId: ready.currentNextActionId,
      mutation: { revision: 1, affectedPersonIds: [owner.personId], affectedSalesCycleIds: [owner.salesCycleId] } });
    const prepSql = f.database.raw.prepare(`INSERT INTO discovery_preparations
      (id, assessment_id, person_id, prospect_id, sales_cycle_id, fingerprint, action_id, request_json, receipt_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const prepArgs = [request.commandId, assessment.id, owner.personId, owner.prospectId, owner.salesCycleId,
      assessment.fingerprint, ready.currentNextActionId, JSON.stringify(request), JSON.stringify(receipt)];
    for (const [index, value] of [[2, other.personId], [3, other.prospectId], [4, other.salesCycleId], [5, 'b'.repeat(64)],
      [6, otherReady.currentNextActionId], [7, '{}'], [8, '{bad']] as const) {
      const bad = [...prepArgs]; bad[index] = value; expect(() => prepSql.run(...bad)).toThrow();
    }
    // Task2 M1: keep both JSON documents coherent with EVERY scalar being
    // changed. These must reach the relational guard, not a JSON CHECK.
    const foreignActionReceipt = { ...receipt, actionId: otherReady.currentNextActionId };
    expect(() => prepSql.run(request.commandId, assessment.id, owner.personId, owner.prospectId,
      owner.salesCycleId, assessment.fingerprint, otherReady.currentNextActionId,
      JSON.stringify(request), JSON.stringify(foreignActionReceipt))).toThrow('FOREIGN KEY constraint failed');
    const foreignOwnerRequest = { ...request, personId: other.personId, salesCycleId: other.salesCycleId };
    const foreignOwnerReceipt = { ...receipt, personId: other.personId, salesCycleId: other.salesCycleId,
      actionId: otherReady.currentNextActionId,
      mutation: { revision: 1, affectedPersonIds: [other.personId], affectedSalesCycleIds: [other.salesCycleId] } };
    expect(() => prepSql.run(request.commandId, assessment.id, other.personId, other.prospectId,
      other.salesCycleId, assessment.fingerprint, otherReady.currentNextActionId,
      JSON.stringify(foreignOwnerRequest), JSON.stringify(foreignOwnerReceipt)))
      .toThrow('Discovery receipt ownership mismatch.');
    prepSql.run(...prepArgs);
    for (const table of ['discovery_overrides', 'discovery_preparations']) {
      expect(() => f.database.raw.exec(`UPDATE ${table} SET id = id`)).toThrow();
      expect(() => f.database.raw.exec(`DELETE FROM ${table}`)).toThrow();
    }
    expect(() => insert(discoveryAssessment(other, { overrideId }))).toThrow();
    expect(f.database.raw.prepare('SELECT * FROM discovery_scan_state').all()).toEqual([]);
    expect(() => f.database.raw.exec("INSERT INTO discovery_scan_state(singleton, cursor) VALUES (2, NULL)")).toThrow();
    expect(() => f.database.raw.exec("INSERT INTO discovery_scan_state(singleton, cursor) VALUES (1, '')")).toThrow();
  });
});
