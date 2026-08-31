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
