import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import {
  createDomainServices,
  type DomainServices,
} from '../../src/main/domain/createDomainServices';
import {
  createFounderSalesDomain,
  FounderSalesDomain,
} from '../../src/main/domain/founderSalesDomain';
import {
  BUILTIN_PRIORITIZATION_RULE_V1,
} from '../../src/main/domain/prioritization/builtinPrioritizationRules';
import { createImportService, type ImportProvider } from '../../src/main/imports/importService';
import type {
  ImportCommitRequest,
  ImportMapping,
} from '../../src/shared/contracts/importContract';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../fixtures/tempDatabase';

const CLOCK_NOW = '2026-08-31T15:00:00.000Z';

class FixedClock {
  constructor(private value: string = CLOCK_NOW) {}

  now(): string {
    return this.value;
  }

  set(value: string): void {
    this.value = value;
  }
}

class SequentialIds {
  private counter = 0;

  next(): string {
    this.counter += 1;
    return `generated-${this.counter}`;
  }
}

const fixture = (name: string): string => readFileSync(
  join(process.cwd(), 'tests', 'fixtures', 'import', name), 'utf8',
);

const VALID_MAPPING: ImportMapping = {
  Name: 'person_name',
  Phone: 'phone',
  Email: 'email',
  Source: 'source',
  Doors: 'doors',
  Organization: 'organization',
};

describe('import service over a real domain', () => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let services: DomainServices;
  let clock: FixedClock;
  let domain: FounderSalesDomain;
  let service: ImportProvider;

  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${temp.path}.backups`, workspaceKey: key,
    });
    clock = new FixedClock();
    const ids = new SequentialIds();
    services = createDomainServices({ database, clock, ids });
    services.unitOfWork.immediate(() => {
      const installed = services.prioritizationRepository
        .installRuleVersion(BUILTIN_PRIORITIZATION_RULE_V1);
      services.prioritizationRepository.activateRuleVersion({
        ruleVersionId: installed.id, expectedActiveRuleVersionId: null,
      });
      services.cadences.installBuiltins();
    });
    domain = createFounderSalesDomain({ services, database, clock, ids });
    service = createImportService(domain);
  });

  afterEach(() => {
    closeDatabase(database);
    temp.cleanup();
  });

  const countPersons = (): number => (database.raw.prepare(
    'SELECT COUNT(*) AS count FROM persons',
  ).get() as { count: number }).count;

  const listAll = () => domain.listLeadRows({
    query: '', stages: [], priorities: [], sort: 'priority', cursor: null, limit: 50,
  });

  const countSourceEvents = (): number => (database.raw.prepare(
    'SELECT COUNT(*) AS count FROM source_events',
  ).get() as { count: number }).count;

  it('preserves nonblank record numbers through preview, remap, skip and persisted source records', async () => {
    const preview = await service.preview({
      kind: 'csv', sourceName: 'blank-records.csv',
      content: 'Name,Email\nNora,nora@fixture.invalid\n\n   \nMarcus,marcus@fixture.invalid\n',
    });
    expect(preview.sampleRows.map((row) => row.rowNumber)).toEqual([2, 5]);
    const remapped = await service.remap({
      previewId: preview.previewId, contentHash: preview.contentHash, mapping: preview.suggestedMapping,
    });
    expect(remapped.sampleRows.map((row) => row.rowNumber)).toEqual([2, 5]);
    const receipt = await service.commit({
      previewId: preview.previewId, contentHash: preview.contentHash, mapping: preview.suggestedMapping,
      source: { channel: 'registry', referredByPersonId: null },
      duplicateDecisions: [{ rowNumber: 2, decision: 'skip', personId: null }],
    });
    expect(receipt.importedRowCount).toBe(1);
    expect(listAll().rows.map((row) => row.personName)).toEqual(['Marcus']);
    expect(database.raw.prepare('SELECT source_record_json FROM source_events').all()).toEqual([
      { source_record_json: expect.stringContaining('"rowNumber":5') },
    ]);
  });

  it.each([['\n', 3], ['\n   \n\t\n', 5]] as const)(
    'accepts leading blank records %j and persists absolute record %i', async (prefix, rowNumber) => {
      const preview = await service.preview({
        kind: 'csv', sourceName: 'leading-blank.csv',
        content: `${prefix}Name,Email\nNora,nora@fixture.invalid\n`,
      });
      expect(preview.columns).toEqual(['Name', 'Email']);
      expect(preview.errors).toEqual([]);
      expect(preview.sampleRows).toEqual([{ rowNumber, cells: ['Nora', 'nora@fixture.invalid'] }]);
      const remapped = await service.remap({
        previewId: preview.previewId, contentHash: preview.contentHash, mapping: preview.suggestedMapping,
      });
      expect(remapped.errors).toEqual([]);
      expect(remapped.sampleRows).toEqual(preview.sampleRows);
      const receipt = await service.commit({
        previewId: preview.previewId, contentHash: preview.contentHash, mapping: remapped.suggestedMapping,
        source: { channel: 'registry', referredByPersonId: null }, duplicateDecisions: [],
      });
      expect(receipt.importedRowCount).toBe(1);
      expect(countPersons()).toBe(1);
      expect(countSourceEvents()).toBe(1);
      expect(database.raw.prepare('SELECT source_record_json FROM source_events').all()).toEqual([
        { source_record_json: expect.stringContaining(`"rowNumber":${rowNumber}`) },
      ]);
    },
  );

  it('ignores constructor and __proto__ columns without prototype effects or schema crashes', async () => {
    const preview = await service.preview({
      kind: 'csv', sourceName: 'unknown-headers.csv',
      content: 'Name,constructor,__proto__\nNora,unknown-constructor,unknown-prototype\n',
    });
    expect(preview.columns).toEqual(['Name', 'constructor', '__proto__']);
    expect(preview.sampleRows).toEqual([
      { rowNumber: 2, cells: ['Nora', 'unknown-constructor', 'unknown-prototype'] },
    ]);
    expect(preview.errors).toEqual([]);
    expect(Object.hasOwn(preview.suggestedMapping, 'constructor')).toBe(true);
    expect(preview.suggestedMapping.constructor).toBe('ignore');
    expect(Object.getPrototypeOf(preview.suggestedMapping)).toBe(Object.prototype);
    expect(Object.entries(preview.suggestedMapping).filter(([, field]) => field !== 'ignore'))
      .toEqual([['Name', 'person_name']]);
    const remapped = await service.remap({
      previewId: preview.previewId, contentHash: preview.contentHash, mapping: preview.suggestedMapping,
    });
    expect(remapped.errors).toEqual([]);
    expect(remapped.suggestedMapping).toEqual(preview.suggestedMapping);
    const receipt = await service.commit({
      previewId: preview.previewId, contentHash: preview.contentHash, mapping: remapped.suggestedMapping,
      source: { channel: 'registry', referredByPersonId: null }, duplicateDecisions: [],
    });
    expect(receipt.importedRowCount).toBe(1);
    expect(listAll().rows.map((row) => row.personName)).toEqual(['Nora']);
    expect(countPersons()).toBe(1);
    expect(countSourceEvents()).toBe(1);
  });

  const malformedSources = [
    ['duplicate headers', 'Name,Name,Email\nNora,Other,nora@fixture.invalid\n', 'DUPLICATE_HEADER'],
    ['trimmed duplicate headers', 'Name, Name ,Email\nNora,Other,nora@fixture.invalid\n', 'DUPLICATE_HEADER'],
    ['blank headers', 'Name, ,Email\nNora,Other,nora@fixture.invalid\n', 'INVALID_HEADER'],
    ['missing cells', 'Name,Email\nNora\n', 'PARSE_ERROR'],
    ['extra cells', 'Name,Email\nNora,nora@fixture.invalid,extra\n', 'PARSE_ERROR'],
    ['malformed quotes', 'Name,Email\nNora,"nora@fixture.invalid', 'PARSE_ERROR'],
  ] as const;

  it.each(malformedSources)('retains blocking errors across remap for %s', async (_name, content, code) => {
    const preview = await service.preview({ kind: 'csv', sourceName: 'malformed.csv', content });
    expect(preview.errors.map((error) => error.code)).toContain(code);
    const parseErrors = preview.errors.filter((error) => error.code === code);
    const mapping: ImportMapping = Object.fromEntries(preview.columns.map((column) => [
      column, column === 'Name' ? 'person_name' : 'ignore',
    ]));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const remapped = await service.remap({
        previewId: preview.previewId, contentHash: preview.contentHash, mapping,
      });
      expect(remapped.errors.filter((error) => error.code === code)).toEqual(parseErrors);
    }
  });

  it.each(malformedSources)('refuses commit before any writes for %s even when all rows are skipped', async (_name, content) => {
    const preview = await service.preview({ kind: 'csv', sourceName: 'malformed.csv', content });
    const mapping: ImportMapping = Object.fromEntries(preview.columns.map((column) => [
      column, column === 'Name' ? 'person_name' : 'ignore',
    ]));
    await service.remap({ previewId: preview.previewId, contentHash: preview.contentHash, mapping });
    for (const skip of [false, true]) {
      await expect(service.commit({
        previewId: preview.previewId, contentHash: preview.contentHash, mapping,
        source: { channel: 'registry', referredByPersonId: null },
        duplicateDecisions: skip ? preview.sampleRows.map((row): ImportCommitRequest['duplicateDecisions'][number] => ({
          rowNumber: row.rowNumber, decision: 'skip', personId: null,
        })) : [],
      })).rejects.toMatchObject({ code: 'IMPORT_VALIDATION_FAILED' });
      expect(countPersons()).toBe(0);
      expect(countSourceEvents()).toBe(0);
    }
  });

  it.each([
    ['csv', ';'], ['csv', '\t'], ['spreadsheet_paste', '\t'],
  ] as const)('preserves %s delimiter %j through real commit', async (kind, delimiter) => {
    const preview = await service.preview({
      kind, sourceName: 'delimited.csv',
      content: ` Name ${delimiter} Email \r\n\r\n   \r\nNora${delimiter}nora@fixture.invalid\r\n`,
    });
    expect(preview.columns).toEqual(['Name', 'Email']);
    expect(preview.errors).toEqual([]);
    const receipt = await service.commit({
      previewId: preview.previewId, contentHash: preview.contentHash, mapping: preview.suggestedMapping,
      source: { channel: 'registry', referredByPersonId: null }, duplicateDecisions: [],
    });
    expect(receipt.importedRowCount).toBe(1);
    expect(countPersons()).toBe(1);
  });

  it('numbers quoted multiline content by records, not physical lines', async () => {
    const preview = await service.preview({
      kind: 'csv', sourceName: 'multiline.csv',
      content: '\uFEFFName,Notes\r\nNora,"first\r\nsecond"\r\n\r\nMarcus,last\r\n',
    });
    expect(preview.errors).toEqual([]);
    expect(preview.sampleRows).toEqual([
      { rowNumber: 2, cells: ['Nora', 'first\r\nsecond'] },
      { rowNumber: 4, cells: ['Marcus', 'last'] },
    ]);
  });

  it('recomputes row errors while retaining immutable bounded parse errors', async () => {
    const preview = await service.preview({
      kind: 'csv', sourceName: 'bounded-errors.csv',
      content: `Name,Email\n${Array.from({ length: 30 }, () => 'Nora,not-an-email,extra').join('\n')}`,
    });
    const parseErrors = preview.errors.filter((error) => error.code === 'PARSE_ERROR');
    expect(parseErrors).toHaveLength(20);
    expect(preview.errors.some((error) => error.code === 'INVALID_EMAIL')).toBe(true);
    for (const error of parseErrors) {
      expect(error.message.length).toBeLessThanOrEqual(200);
      expect(error.message).not.toMatch(/[\r\n]|\/Users\/|\bat .*\(/);
    }
    // The public preview is not the authoritative stored parse-error list.
    preview.errors.length = 0;
    const remapped = await service.remap({
      previewId: preview.previewId, contentHash: preview.contentHash,
      mapping: { Name: 'person_name', Email: 'ignore' },
    });
    expect(remapped.errors).toEqual(parseErrors);
    expect(remapped.validCount).toBe(30);
    await expect(service.commit({
      previewId: preview.previewId, contentHash: preview.contentHash,
      mapping: remapped.suggestedMapping,
      source: { channel: 'registry', referredByPersonId: null }, duplicateDecisions: [],
    })).rejects.toMatchObject({ code: 'IMPORT_VALIDATION_FAILED' });
    expect(countPersons()).toBe(0);
    expect(countSourceEvents()).toBe(0);
  });

  it('previews, remaps, commits, and reports a valid CSV import end to end', async () => {
    const preview = await service.preview({
      kind: 'csv', sourceName: 'leads-valid.csv', content: fixture('leads-valid.csv'),
    });
    expect(preview.columns).toEqual(['Name', 'Phone', 'Email', 'Source', 'Doors', 'Organization']);
    expect(preview.rowCount).toBe(2);
    expect(preview.validCount).toBe(2);
    expect(preview.errors).toEqual([]);
    expect(preview.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.suggestedMapping).toEqual(VALID_MAPPING);

    const remapped = await service.remap({
      previewId: preview.previewId,
      contentHash: preview.contentHash,
      mapping: { ...VALID_MAPPING, Doors: 'ignore' },
    });
    expect(remapped.validCount).toBe(2);
    expect(remapped.suggestedMapping).toEqual({ ...VALID_MAPPING, Doors: 'ignore' });

    const receipt = await service.commit({
      previewId: preview.previewId,
      contentHash: preview.contentHash,
      mapping: VALID_MAPPING,
      source: { channel: 'registry', referredByPersonId: null },
      duplicateDecisions: [],
    });
    expect(receipt.importedRowCount).toBe(2);
    expect(receipt.importedPersonIds).toHaveLength(2);
    expect(receipt.revision).toBeGreaterThan(0);

    const status = await service.status({ jobId: receipt.jobId });
    expect(status.state).toBe('succeeded');
    expect(status.progressCurrent).toBe(2);
    expect(status.safeErrorCode).toBeNull();

    const page = listAll();
    expect(page.rows.some((row) => row.personName === 'Kevin Shin')).toBe(true);
    expect(page.rows.some((row) => row.personName === 'Maya Ortiz')).toBe(true);
    expect(countPersons()).toBe(2);
  });

  it('handles BOM, CRLF, and quoted commas from the duplicates fixture', async () => {
    const preview = await service.preview({
      kind: 'csv', sourceName: 'leads-duplicates.csv', content: fixture('leads-duplicates.csv'),
    });
    expect(preview.columns).toEqual(['Name', 'Phone', 'Organization']);
    expect(preview.rowCount).toBe(2);
    expect(preview.sampleRows).toEqual([
      { rowNumber: 2, cells: ['Kevin Shin', '+14015550101', 'Shin, Holdings LLC'] },
      { rowNumber: 3, cells: ['Nina Park', '+14015550199', 'Park & Co, Ltd'] },
    ]);
    expect(preview.errors).toEqual([]);

    const receipt = await service.commit({
      previewId: preview.previewId,
      contentHash: preview.contentHash,
      mapping: preview.suggestedMapping,
      source: { channel: 'custom', referredByPersonId: null },
      duplicateDecisions: [],
    });
    expect(receipt.importedRowCount).toBe(2);
    expect(listAll().rows.some((row) => row.personName === 'Nina Park')).toBe(true);
  });

  it('surfaces duplicate candidates and honors explicit skip decisions', async () => {
    const first = await service.preview({
      kind: 'csv', sourceName: 'leads-valid.csv', content: fixture('leads-valid.csv'),
    });
    await service.commit({
      previewId: first.previewId,
      contentHash: first.contentHash,
      mapping: VALID_MAPPING,
      source: { channel: 'registry', referredByPersonId: null },
      duplicateDecisions: [],
    });
    expect(countPersons()).toBe(2);

    const second = await service.preview({
      kind: 'csv', sourceName: 'leads-duplicates.csv', content: fixture('leads-duplicates.csv'),
    });
    expect(second.duplicateCandidates.some(
      (candidate) => candidate.rowNumber === 2 && candidate.personIds.length > 0,
    )).toBe(true);

    const receipt = await service.commit({
      previewId: second.previewId,
      contentHash: second.contentHash,
      mapping: second.suggestedMapping,
      source: { channel: 'custom', referredByPersonId: null },
      duplicateDecisions: [{ rowNumber: 2, decision: 'skip', personId: null }],
    });
    expect(receipt.importedRowCount).toBe(1);
    expect(countPersons()).toBe(3);
    expect(listAll().rows.some((row) => row.personName === 'Nina Park')).toBe(true);
  });

  it('commits all valid rows atomically or none', async () => {
    const preview = await service.preview({
      kind: 'csv', sourceName: 'leads-invalid.csv', content: fixture('leads-invalid.csv'),
    });
    expect(preview.validCount).toBe(0);
    expect(preview.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining(['MISSING_NAME', 'INVALID_PHONE', 'INVALID_EMAIL']),
    );

    await expect(service.commit({
      previewId: preview.previewId,
      contentHash: preview.contentHash,
      mapping: preview.suggestedMapping,
      source: { channel: 'registry', referredByPersonId: null },
      duplicateDecisions: [],
    })).rejects.toMatchObject({ code: 'IMPORT_VALIDATION_FAILED' });

    expect(countPersons()).toBe(0);
    expect(listAll().total).toBe(0);
  });

  it('rejects a commit whose content hash does not match the preview', async () => {
    const preview = await service.preview({
      kind: 'csv', sourceName: 'leads-valid.csv', content: fixture('leads-valid.csv'),
    });

    await expect(service.commit({
      previewId: preview.previewId,
      contentHash: 'b'.repeat(64),
      mapping: VALID_MAPPING,
      source: { channel: 'registry', referredByPersonId: null },
      duplicateDecisions: [],
    })).rejects.toMatchObject({ code: 'IMPORT_PREVIEW_INVALID' });

    expect(countPersons()).toBe(0);
  });

  it('invalidates the preview after a successful commit so a repeat cannot duplicate rows', async () => {
    const preview = await service.preview({
      kind: 'csv', sourceName: 'leads-valid.csv', content: fixture('leads-valid.csv'),
    });
    const request: ImportCommitRequest = {
      previewId: preview.previewId,
      contentHash: preview.contentHash,
      mapping: VALID_MAPPING,
      source: { channel: 'registry' as const, referredByPersonId: null },
      duplicateDecisions: [],
    };

    await service.commit(request);
    await expect(service.commit(request))
      .rejects.toMatchObject({ code: 'IMPORT_PREVIEW_INVALID' });

    expect(countPersons()).toBe(2);
  });

  it('rejects an expired preview at commit time', async () => {
    const preview = await service.preview({
      kind: 'csv', sourceName: 'leads-valid.csv', content: fixture('leads-valid.csv'),
    });
    clock.set('2026-08-31T16:00:01.000Z');

    await expect(service.commit({
      previewId: preview.previewId,
      contentHash: preview.contentHash,
      mapping: VALID_MAPPING,
      source: { channel: 'registry', referredByPersonId: null },
      duplicateDecisions: [],
    })).rejects.toMatchObject({ code: 'IMPORT_PREVIEW_INVALID' });

    expect(countPersons()).toBe(0);
  });

  it('reports an unknown import job as JOB_NOT_FOUND', async () => {
    await expect(service.status({ jobId: 'missing-job' }))
      .rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });
  });
});
