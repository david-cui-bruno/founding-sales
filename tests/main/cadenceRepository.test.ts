import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import {
  BUILTIN_CADENCES,
  computeCadenceContentHash,
  parseCadenceAggregate,
} from '../../src/main/domain/cadence/builtinCadences';
import {
  CadenceCatalogCorruptionError,
  CadenceRepository,
  CadenceVersionConflictError,
} from '../../src/main/domain/cadence/cadenceRepository';
import {
  DomainRepositoryDatabaseMismatchError,
  DomainTransactionRequiredError,
} from '../../src/main/domain/support/domainErrors';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../fixtures/tempDatabase';

const TIMESTAMP = '2026-08-31T12:00:00.000Z';

describe('CadenceRepository', () => {
  let database: AppDatabase | undefined;
  let otherDatabase: AppDatabase | undefined;
  let workspace: TempDatabase | undefined;
  let otherWorkspace: TempDatabase | undefined;

  afterEach(() => {
    if (database !== undefined) closeDatabase(database);
    if (otherDatabase !== undefined) closeDatabase(otherDatabase);
    workspace?.cleanup();
    otherWorkspace?.cleanup();
  });

  async function setup() {
    workspace = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: workspace.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${workspace.path}.backups`, workspaceKey: key,
    });
    const unitOfWork = new DomainUnitOfWork(database);
    let clockReads = 0;
    const repository = new CadenceRepository({
      database,
      unitOfWork,
      clock: { now: () => { clockReads += 1; return TIMESTAMP; } },
    });
    return { repository, unitOfWork, clockReads: () => clockReads };
  }

  it('requires an active Unit of Work and an exact database binding', async () => {
    const { repository, unitOfWork } = await setup();
    expect(() => repository.install(BUILTIN_CADENCES[0]!)).toThrow(DomainTransactionRequiredError);

    otherWorkspace = createTempDatabase();
    const otherKey = createTestWorkspaceKey();
    otherDatabase = openDatabase({ path: otherWorkspace.path, key: otherKey });
    await migrateToLatest(otherDatabase, {
      backupDirectory: `${otherWorkspace.path}.backups`, workspaceKey: otherKey,
    });
    expect(() => new CadenceRepository({
      database: otherDatabase!, unitOfWork, clock: { now: () => TIMESTAMP },
    })).toThrow(DomainRepositoryDatabaseMismatchError);
  });

  it('installs and strictly roundtrips all six complete aggregates', async () => {
    const { repository, unitOfWork } = await setup();
    const installed = unitOfWork.immediate(() => repository.installBuiltins());
    expect(installed).toEqual(BUILTIN_CADENCES);
    expect(repository.list()).toEqual(BUILTIN_CADENCES);
    for (const definition of BUILTIN_CADENCES) {
      expect(repository.getById(definition.id)).toEqual(definition);
      expect(repository.getByFamilyVersion(definition.family, 1)).toEqual(definition);
    }
    expect(database!.raw.prepare('SELECT count(*) AS count FROM cadence_definitions').get())
      .toEqual({ count: 6 });
    expect(database!.raw.prepare('SELECT count(*) AS count FROM cadence_steps').get())
      .toEqual({ count: 26 });
    expect(database!.raw.prepare('SELECT count(*) AS count FROM cadence_action_components').get())
      .toEqual({ count: 34 });
  });

  it('returns the parsed existing aggregate on exact reinstall without reading the clock', async () => {
    const { repository, unitOfWork, clockReads } = await setup();
    const original = unitOfWork.immediate(() => repository.install(BUILTIN_CADENCES[0]!));
    const readsAfterFirst = clockReads();
    const replay = unitOfWork.immediate(() => repository.install(structuredClone(original)));
    expect(replay).toEqual(original);
    expect(clockReads()).toBe(readsAfterFirst);
    expect(database!.raw.prepare('SELECT count(*) AS count FROM cadence_definitions').get())
      .toEqual({ count: 1 });
  });

  it('rejects same family/version with edited mechanics or copy as a typed conflict', async () => {
    const { repository, unitOfWork } = await setup();
    unitOfWork.immediate(() => repository.install(BUILTIN_CADENCES[0]!));
    const edited = structuredClone(BUILTIN_CADENCES[0]!);
    edited.steps[2]!.components[0]!.template.body = 'Edited without a new version.';
    edited.contentHash = computeCadenceContentHash(edited);
    expect(parseCadenceAggregate(edited).contentHash).toBe(edited.contentHash);
    expect(() => unitOfWork.immediate(() => repository.install(edited)))
      .toThrow(CadenceVersionConflictError);
    expect(repository.getById(BUILTIN_CADENCES[0]!.id)).toEqual(BUILTIN_CADENCES[0]);
  });

  it('propagates unrelated primary-key and content-hash conflicts', async () => {
    const { repository, unitOfWork } = await setup();
    unitOfWork.immediate(() => repository.install(BUILTIN_CADENCES[0]!));
    const idCollision = structuredClone(BUILTIN_CADENCES[1]!);
    idCollision.id = BUILTIN_CADENCES[0]!.id;
    idCollision.contentHash = computeCadenceContentHash(idCollision);
    expect(() => unitOfWork.immediate(() => repository.install(idCollision))).toThrow();
  });

  it.each([
    {
      label: 'malformed definition JSON', table: 'cadence_definitions',
      mutation: "UPDATE cadence_definitions SET definition_json = '{' WHERE id = 'cadence-a-v1'",
    },
    {
      label: 'noncanonical definition JSON', table: 'cadence_definitions',
      mutation: `UPDATE cadence_definitions
        SET definition_json = '{"formatVersion":1, "category":"prospecting","policyIds":{"call":"founder_call_v1","email":"founder_email_v1","text":"founder_text_v1"}}'
        WHERE id = 'cadence-a-v1'`,
    },
    {
      label: 'divergent content hash', table: 'cadence_definitions',
      mutation: `UPDATE cadence_definitions
        SET content_hash = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
        WHERE id = 'cadence-a-v1'`,
    },
    {
      label: 'unknown step envelope version', table: 'cadence_steps',
      mutation: `UPDATE cadence_steps SET step_json = '{"formatVersion":2,"timing":{"differentCallWindow":false,"finalSlaDayOffset":null,"kind":"immediate"}}'
        WHERE id = 'cadence-a-v1-day-0'`,
    },
    {
      label: 'malformed outcome graph', table: 'cadence_action_components',
      mutation: `UPDATE cadence_action_components SET outcome_graph_json = '{}'
        WHERE id = 'cadence-a-v1-day-0-call'`,
    },
    {
      label: 'noncanonical template envelope', table: 'cadence_action_components',
      mutation: `UPDATE cadence_action_components SET template_json = ' {"formatVersion":1}'
        WHERE id = 'cadence-a-v1-day-0-call'`,
    },
  ])('fails closed on $label', async ({ table, mutation }) => {
    const { repository, unitOfWork } = await setup();
    unitOfWork.immediate(() => repository.install(BUILTIN_CADENCES[0]!));
    database!.raw.exec(`DROP TRIGGER immutable_${table}`);
    database!.raw.prepare(mutation).run();
    expect(() => repository.getById('cadence-a-v1')).toThrow(CadenceCatalogCorruptionError);
  });

  it('blocks UPDATE, DELETE, and OR REPLACE for definitions, steps, and components', async () => {
    const { repository, unitOfWork } = await setup();
    unitOfWork.immediate(() => repository.install(BUILTIN_CADENCES[0]!));
    const mutations = [
      "UPDATE cadence_definitions SET name = 'changed' WHERE id = 'cadence-a-v1'",
      "DELETE FROM cadence_definitions WHERE id = 'cadence-a-v1'",
      `INSERT OR REPLACE INTO cadence_definitions
       (id, family, version, name, content_hash, attempt_cap, definition_json, created_at)
       SELECT id, family, version, 'changed', content_hash, attempt_cap, definition_json, created_at
       FROM cadence_definitions WHERE id = 'cadence-a-v1'`,
      "UPDATE cadence_steps SET label = 'changed' WHERE id = 'cadence-a-v1-day-0'",
      "DELETE FROM cadence_steps WHERE id = 'cadence-a-v1-day-0'",
      `INSERT OR REPLACE INTO cadence_steps
       (id, cadence_definition_id, sequence, day_offset, label, breakup, step_json, created_at)
       SELECT id, cadence_definition_id, sequence, day_offset, 'changed', breakup, step_json, created_at
       FROM cadence_steps WHERE id = 'cadence-a-v1-day-0'`,
      "UPDATE cadence_action_components SET action_type = 'email' WHERE id = 'cadence-a-v1-day-0-call'",
      "DELETE FROM cadence_action_components WHERE id = 'cadence-a-v1-day-0-call'",
      `INSERT OR REPLACE INTO cadence_action_components
       (id, cadence_step_id, sequence, action_type, channel, condition_json,
        outcome_graph_json, template_json, created_at)
       SELECT id, cadence_step_id, sequence, 'email', channel, condition_json,
              outcome_graph_json, template_json, created_at
       FROM cadence_action_components WHERE id = 'cadence-a-v1-day-0-call'`,
      `INSERT OR REPLACE INTO cadence_action_components
       (id, cadence_step_id, sequence, action_type, channel, condition_json,
        outcome_graph_json, template_json, created_at)
       SELECT 'replacement-component-id', cadence_step_id, sequence, action_type,
              channel, condition_json, outcome_graph_json, template_json, created_at
       FROM cadence_action_components WHERE id = 'cadence-a-v1-day-0-call'`,
    ];
    for (const mutation of mutations) {
      expect(() => database!.raw.prepare(mutation).run()).toThrow();
    }
  });
});
