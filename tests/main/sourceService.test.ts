import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { resolveNativeBinding } from '../../src/main/db/sqliteDriver';
import { IdentityRepository } from '../../src/main/domain/identity/identityRepository';
import {
  IntakeReceiptRepository,
  serializeCanonicalIntakeCommand,
  type CanonicalIntakeCommand,
  type StoredIntakeResult,
} from '../../src/main/domain/source/intakeReceiptRepository';
import {
  SourceRepository,
} from '../../src/main/domain/source/sourceRepository';
import {
  normalizeEmail,
  normalizePhone,
  IntakeIdempotencyConflictError,
  SourceService,
  type CreatePersonProspectCommand,
  type IntakeSourceInput,
  type IntakeFaultPoint,
} from '../../src/main/domain/source/sourceService';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../fixtures/tempDatabase';

const NOW = '2026-08-30T12:00:00.000Z';
const OBSERVED_AT = '2026-08-29T16:30:00.000Z';

describe('SourceService', () => {
  let database: AppDatabase;
  let tempDatabase: TempDatabase;
  let unitOfWork: DomainUnitOfWork;
  let identities: IdentityRepository;
  let sources: SourceRepository;
  let receipts: IntakeReceiptRepository;
  let ids: string[];
  let service: SourceService;

  beforeEach(async () => {
    tempDatabase = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: tempDatabase.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${tempDatabase.path}.backups`,
      workspaceKey: key,
    });
    unitOfWork = new DomainUnitOfWork(database);
    ids = [];
    rebuildService();
  });

  afterEach(() => {
    closeDatabase(database);
    tempDatabase.cleanup();
  });

  function rebuildService(faultInjector?: (point: IntakeFaultPoint) => void): void {
    identities = new IdentityRepository({
      database,
      unitOfWork,
      clock: { now: () => NOW },
      ids: {
        next: () => {
          const id = ids.shift();
          if (id === undefined) throw new Error('Test ID sequence exhausted.');
          return id;
        },
      },
    });
    sources = new SourceRepository({
      database,
      unitOfWork,
      clock: { now: () => NOW },
    });
    receipts = new IntakeReceiptRepository({
      database,
      unitOfWork,
      clock: { now: () => NOW },
    });
    service = new SourceService({
      database,
      unitOfWork,
      identities,
      sources,
      receipts,
      faultInjector,
    });
  }

  function baseCommand(
    sourceId: string,
    overrides: Partial<CreatePersonProspectCommand> = {},
  ): CreatePersonProspectCommand {
    return {
      person: { displayName: 'Kevin Shin' },
      contacts: [{
        kind: 'phone',
        value: '(401) 555-0100',
        reachability: 'direct',
        isPrimary: true,
      }],
      source: {
        id: sourceId,
        channel: 'frbo',
        observedAt: OBSERVED_AT,
        sourceRecord: { listingId: sourceId },
      },
      ...overrides,
    } as CreatePersonProspectCommand;
  }

  function counts(): Record<string, number> {
    const tables = [
      'persons', 'person_contact_methods', 'source_events', 'prospects',
      'source_intake_receipts',
      'organizations', 'organization_aliases', 'properties',
      'prospect_organizations', 'prospect_properties', 'sales_cycles',
    ];
    return Object.fromEntries(tables.map((table) => {
      const row = database.raw.prepare(`SELECT count(*) AS count FROM ${table}`).get() as {
        count: number;
      };
      return [table, row.count];
    }));
  }

  function insertPersonContact(input: {
    personId: string;
    contactId: string;
    kind: 'phone' | 'email';
    value: string;
    reachability: 'direct' | 'indirect' | 'none';
    deleted?: boolean;
  }): void {
    database.raw.prepare(`
      INSERT INTO persons (
        id, display_name, aliases_json, opted_out, never_record, deleted_at,
        version, created_at, updated_at
      ) VALUES (?, ?, '[]', 0, 0, ?, 1, ?, ?)
    `).run(
      input.personId,
      input.personId,
      input.deleted === true ? NOW : null,
      NOW,
      NOW,
    );
    database.raw.prepare(`
      INSERT INTO person_contact_methods (
        id, person_id, kind, normalized_value, validation_state,
        reachability, is_primary, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'valid', ?, 0, ?, ?)
    `).run(
      input.contactId,
      input.personId,
      input.kind,
      input.value,
      input.reachability,
      NOW,
      NOW,
    );
  }

  function canonicalRaceCommand(sourceId: string): CanonicalIntakeCommand {
    return {
      person: {
        displayName: 'Kevin Shin', aliases: [], neverRecord: false, provenance: null,
      },
      contacts: [{
        kind: 'phone', normalizedValue: '+14015550100', reachability: 'direct',
        isPrimary: true, inContacts: null,
      }],
      organizations: [],
      properties: [],
      source: {
        id: sourceId, channel: 'frbo', observedAt: OBSERVED_AT,
        sourceRecord: { listingId: sourceId }, evidenceRef: null,
        referral: null, customSourceReason: null,
      },
      segment: 'hot_frbo',
    };
  }

  function raceResult(sourceId: string): StoredIntakeResult {
    return {
      disposition: 'created',
      personId: 'contended-person',
      prospectId: 'contended-prospect',
      sourceEventId: sourceId,
      identityReviewReason: null,
      contextReviewReasons: [],
      organizationIds: [],
      propertyIds: [],
    };
  }

  function spawnSameSourceContender(sourceId: string): {
    readyPath: string;
    exit: Promise<{ code: number | null; stderr: string }>;
  } {
    const readyPath = `${tempDatabase.path}.${sourceId}.receipt-ready`;
    const commandJson = serializeCanonicalIntakeCommand(canonicalRaceCommand(sourceId));
    const resultJson = JSON.stringify({ formatVersion: 1, result: raceResult(sourceId) });
    const sourceRecordJson = JSON.stringify({
      formatVersion: 1,
      sourceRecord: { listingId: sourceId },
      customSourceReason: null,
    });
    const contender = spawn(process.execPath, [
      resolve(process.cwd(), 'tests/support/sourceIntakeReceiptContender.mjs'),
      tempDatabase.path,
      resolveNativeBinding(),
      readyPath,
      createTestWorkspaceKey().bytes.toString('hex'),
      sourceId,
      sourceRecordJson,
      commandJson,
      resultJson,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    return { readyPath, exit: captureChildExit(contender) };
  }

  it('documents the V1 US phone default and conservative full-lowercase email policy', () => {
    expect(normalizePhone('(401) 555-0100')).toBe('+14015550100');
    expect(normalizePhone('1 401 555 0100')).toBe('+14015550100');
    expect(normalizePhone('+1 (401) 555-0100')).toBe('+14015550100');
    expect(normalizePhone('+442071838750')).toBe('+442071838750');
    expect(() => normalizePhone('555-0100')).toThrow(z.ZodError);
    expect(() => normalizePhone('+01234567890')).toThrow(z.ZodError);
    expect(normalizePhone('+44 20 7183 8750')).toBe('+442071838750');
    expect(() => normalizePhone('+1 (401) CALL-ME')).toThrow(z.ZodError);

    expect(normalizeEmail('  KEVIN\uFF20EXAMPLE.COM ')).toBe('kevin@example.com');
    expect(() => normalizeEmail('kevin @example.com')).toThrow(z.ZodError);
    expect(() => normalizeEmail('kevin@example')).toThrow(z.ZodError);
    expect(() => normalizeEmail('.kevin@example.com')).toThrow(z.ZodError);
    expect(() => normalizeEmail('kevin.@example.com')).toThrow(z.ZodError);
  });

  it('normalizes and deduplicates equivalent contacts before writing', () => {
    ids.push('person', 'contact-phone', 'contact-email', 'prospect');
    const result = service.createPersonProspect(baseCommand('source', {
      contacts: [
        { kind: 'phone', value: '(401) 555-0100', reachability: 'direct' },
        { kind: 'phone', value: '1-401-555-0100', reachability: 'direct' },
        { kind: 'email', value: ' Kevin@Example.COM ', reachability: 'direct' },
        { kind: 'email', value: 'kevin@example.com', reachability: 'direct' },
      ],
    }));

    expect(result).toMatchObject({
      disposition: 'created',
      personId: 'person',
      prospectId: 'prospect',
      sourceEventId: 'source',
      identityReviewReason: null,
    });
    expect(database.raw.prepare(`
      SELECT kind, normalized_value FROM person_contact_methods ORDER BY kind
    `).all()).toEqual([
      { kind: 'email', normalized_value: 'kevin@example.com' },
      { kind: 'phone', normalized_value: '+14015550100' },
    ]);
    expect(counts().sales_cycles).toBe(0);
  });

  type DuplicateContactFacts = {
    reachability: 'direct' | 'indirect' | 'none';
    isPrimary: boolean;
    inContacts: boolean | null;
  };
  const duplicateContactConflictCases: Array<[
    DuplicateContactFacts,
    DuplicateContactFacts,
  ]> = [
    [
      { reachability: 'direct' as const, isPrimary: false, inContacts: null },
      { reachability: 'indirect' as const, isPrimary: false, inContacts: null },
    ],
    [
      { reachability: 'direct' as const, isPrimary: false, inContacts: null },
      { reachability: 'direct' as const, isPrimary: true, inContacts: null },
    ],
    [
      { reachability: 'direct' as const, isPrimary: false, inContacts: false },
      { reachability: 'direct' as const, isPrimary: false, inContacts: true },
    ],
  ];

  it.each(duplicateContactConflictCases)(
    'rejects conflicting duplicate contact facts independent of input order',
    (first, second) => {
    const makeCommand = (contacts: [DuplicateContactFacts, DuplicateContactFacts]) => baseCommand('duplicate-source', {
      contacts: contacts.map((contact, index) => ({
        kind: 'phone' as const,
        value: index === 0 ? '(401) 555-0100' : '1-401-555-0100',
        ...contact,
      })),
    });

    expect(() => service.createPersonProspect(makeCommand([first, second])))
      .toThrow(expect.objectContaining({ name: 'ContactNormalizationConflictError' }));
    expect(() => service.createPersonProspect(makeCommand([second, first])))
      .toThrow(expect.objectContaining({ name: 'ContactNormalizationConflictError' }));
    expect(Object.values(counts()).every((count) => count === 0)).toBe(true);
    },
  );

  it('validates the entire command before writes', () => {
    ids.push('must-not-be-consumed');
    expect(() => service.createPersonProspect(baseCommand('invalid-source', {
      contacts: [{ kind: 'phone', value: '555-0100', reachability: 'direct' }],
    }))).toThrow(z.ZodError);
    expect(counts()).toEqual({
      persons: 0,
      person_contact_methods: 0,
      source_events: 0,
      source_intake_receipts: 0,
      prospects: 0,
      organizations: 0,
      organization_aliases: 0,
      properties: 0,
      prospect_organizations: 0,
      prospect_properties: 0,
      sales_cycles: 0,
    });
  });

  it.each([
    ['frbo', 'hot_frbo'],
    ['registry', 'cold_registry'],
    ['rireig', 'warm'],
    ['referral', 'warm'],
    ['inbound_demo', 'warm'],
    ['community', 'warm'],
  ] as const)('maps %s to its fixed %s segment', (channel, segment) => {
    ids.push(`person-${channel}`, `prospect-${channel}`);
    const source: IntakeSourceInput = channel === 'referral'
      ? {
        id: `source-${channel}`,
        channel,
        observedAt: OBSERVED_AT,
        sourceRecord: { channel },
        referral: { kind: 'unknown' as const, reason: 'not_provided' as const },
      }
      : {
        id: `source-${channel}`,
        channel,
        observedAt: OBSERVED_AT,
        sourceRecord: { channel },
      };
    const result = service.createPersonProspect({
      person: { displayName: `${channel} person` },
      contacts: [],
      source,
    });

    expect(database.raw.prepare('SELECT segment FROM prospects WHERE id = ?')
      .get(result.prospectId)).toEqual({ segment });
  });

  it('requires a typed reason and explicit segment only for custom intake', () => {
    expect(() => service.createPersonProspect({
      person: { displayName: 'Custom Person' },
      contacts: [],
      source: {
        id: 'custom-missing-segment',
        channel: 'custom',
        observedAt: OBSERVED_AT,
        sourceRecord: { row: 1 },
        customSourceReason: 'manual_quick_add',
      },
    } as never)).toThrow(z.ZodError);

    ids.push('custom-person', 'custom-prospect');
    const result = service.createPersonProspect({
      person: { displayName: 'Custom Person' },
      contacts: [],
      segment: 'warm',
      source: {
        id: 'custom-source',
        channel: 'custom',
        observedAt: OBSERVED_AT,
        sourceRecord: { row: 1 },
        customSourceReason: 'manual_quick_add',
      },
    });
    expect(database.raw.prepare('SELECT segment FROM prospects WHERE id = ?')
      .get(result.prospectId)).toEqual({ segment: 'warm' });
  });

  it('reuses the one Person and canonical Prospect for a unique direct match', () => {
    ids.push('person', 'contact', 'prospect');
    const first = service.createPersonProspect(baseCommand('source-one'));
    ids.push('must-not-create-person-or-prospect');
    const second = service.createPersonProspect(baseCommand('source-two', {
      person: { displayName: 'Kevin Shin from second listing' },
      contacts: [{ kind: 'phone', value: '14015550100', reachability: 'direct' }],
      source: {
        id: 'source-two',
        channel: 'frbo',
        observedAt: '2026-08-30T10:00:00.000Z',
        sourceRecord: { listingId: 'listing-two' },
      },
    }));

    expect(second).toMatchObject({
      disposition: 'matched_existing',
      personId: first.personId,
      prospectId: first.prospectId,
    });
    expect(counts()).toMatchObject({ persons: 1, prospects: 1, source_events: 2, sales_cycles: 0 });
    expect(sources.getById('source-two')).toMatchObject({
      personId: first.personId,
      prospectId: first.prospectId,
    });
  });

  it('serializes independent connections racing to ingest the same new direct handle', async () => {
    const readyPath = `${tempDatabase.path}.contender-ready`;
    const contender = spawn(process.execPath, [
      resolve(process.cwd(), 'tests/support/sourceIntakeContender.mjs'),
      tempDatabase.path,
      resolveNativeBinding(),
      readyPath,
      createTestWorkspaceKey().bytes.toString('hex'),
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    const exit = captureChildExit(contender);
    await waitUntil(() => existsSync(readyPath), 5_000);

    const result = service.createPersonProspect(baseCommand('contended-source-two', {
      source: {
        id: 'contended-source-two',
        channel: 'frbo',
        observedAt: OBSERVED_AT,
        sourceRecord: { listingId: 'contended-two' },
      },
    }));
    const childResult = await exit;

    expect(childResult).toEqual({ code: 0, stderr: '' });
    expect(result).toMatchObject({
      disposition: 'matched_existing',
      personId: 'contended-person',
      prospectId: 'contended-prospect',
    });
    expect(counts()).toMatchObject({
      persons: 1, prospects: 1, source_events: 2, source_intake_receipts: 2,
    });
    expect(sources.listByPerson('contended-person').map(({ id }) => id)).toEqual([
      'contended-source-one', 'contended-source-two',
    ]);
  }, 10_000);

  it('serializes the same source ID race and returns the committed durable result', async () => {
    const sourceId = 'same-source';
    const contender = spawnSameSourceContender(sourceId);
    await waitUntil(() => existsSync(contender.readyPath), 5_000);

    const result = service.createPersonProspect(baseCommand(sourceId));
    const childResult = await contender.exit;

    expect(childResult).toEqual({ code: 0, stderr: '' });
    expect(result).toEqual(raceResult(sourceId));
    expect(counts()).toMatchObject({
      persons: 1, prospects: 1, source_events: 1, source_intake_receipts: 1,
    });
  }, 10_000);

  it('serializes a changed same-source race and rejects it without writes', async () => {
    const sourceId = 'same-source-different';
    const contender = spawnSameSourceContender(sourceId);
    await waitUntil(() => existsSync(contender.readyPath), 5_000);

    expect(() => service.createPersonProspect(baseCommand(sourceId, {
      person: { displayName: 'Different Person' },
    }))).toThrow(expect.objectContaining({
      name: 'IntakeIdempotencyConflictError', reason: 'command_mismatch',
    }));
    const childResult = await contender.exit;

    expect(childResult).toEqual({ code: 0, stderr: '' });
    expect(counts()).toMatchObject({
      persons: 1, prospects: 1, source_events: 1, source_intake_receipts: 1,
    });
  }, 10_000);

  it.each([
    ['shared_handle', 'shared'],
    ['conflicting_handle_matches', 'conflicting'],
    ['indirect_handle_match', 'indirect'],
    ['deleted_person_match', 'deleted'],
  ] as const)('creates merge review for %s and never chooses the first match', (reason, scenario) => {
    if (scenario === 'shared') {
      insertPersonContact({
        personId: 'person-a', contactId: 'contact-a', kind: 'phone',
        value: '+14015550100', reachability: 'direct',
      });
      insertPersonContact({
        personId: 'person-z', contactId: 'contact-z', kind: 'phone',
        value: '+14015550100', reachability: 'direct',
      });
    } else if (scenario === 'conflicting') {
      insertPersonContact({
        personId: 'phone-person', contactId: 'phone-contact', kind: 'phone',
        value: '+14015550100', reachability: 'direct',
      });
      insertPersonContact({
        personId: 'email-person', contactId: 'email-contact', kind: 'email',
        value: 'kevin@example.com', reachability: 'direct',
      });
    } else if (scenario === 'indirect') {
      insertPersonContact({
        personId: 'office-person', contactId: 'office-contact', kind: 'phone',
        value: '+14015550100', reachability: 'indirect',
      });
    } else {
      insertPersonContact({
        personId: 'deleted-person', contactId: 'deleted-contact', kind: 'phone',
        value: '+14015550100', reachability: 'direct', deleted: true,
      });
    }
    ids.push('review-person', 'review-phone');
    const contacts = scenario === 'conflicting'
      ? [
        { kind: 'phone' as const, value: '(401) 555-0100', reachability: 'direct' as const },
        { kind: 'email' as const, value: 'kevin@example.com', reachability: 'direct' as const },
      ]
      : [{ kind: 'phone' as const, value: '(401) 555-0100', reachability: 'direct' as const }];
    if (scenario === 'conflicting') ids.push('review-email');
    ids.push('review-prospect');

    const result = service.createPersonProspect(baseCommand(`source-${scenario}`, { contacts }));

    expect(result).toMatchObject({
      disposition: 'created_merge_review',
      personId: 'review-person',
      prospectId: 'review-prospect',
      identityReviewReason: reason,
    });
    expect(database.raw.prepare(`
      SELECT qualification_state, qualification_reason
      FROM prospects WHERE id = 'review-prospect'
    `).get()).toEqual({
      qualification_state: 'merge_review',
      qualification_reason: reason,
    });
    expect(counts().sales_cycles).toBe(0);
  });

  it('treats one handle attached to Direct and indirect people as shared identity evidence', () => {
    insertPersonContact({
      personId: 'direct-person', contactId: 'direct-contact', kind: 'phone',
      value: '+14015550100', reachability: 'direct',
    });
    insertPersonContact({
      personId: 'indirect-person', contactId: 'indirect-contact', kind: 'phone',
      value: '+14015550100', reachability: 'indirect',
    });
    ids.push('review-person', 'review-contact', 'review-prospect');

    const result = service.createPersonProspect(baseCommand('shared-metadata-source'));

    expect(result).toMatchObject({
      disposition: 'created_merge_review',
      personId: 'review-person',
      identityReviewReason: 'shared_handle',
    });
  });

  it('never merges identity from names, organization, property, or shared office context', () => {
    ids.push(
      'person-one', 'prospect-one',
      'organization', 'organization-alias',
      'property',
    );
    const first = service.createPersonProspect(baseCommand('source-one', {
      contacts: [],
      organizations: [{ canonicalName: 'Shin Holdings LLC' }],
      properties: [{
        addressLine1: '10 Hope St', locality: 'Providence', region: 'RI', postalCode: '02906',
      }],
    }));
    ids.push('person-two', 'prospect-two');
    const second = service.createPersonProspect(baseCommand('source-two', {
      contacts: [],
      organizations: [{ canonicalName: 'SHIN HOLDINGS LLC' }],
      properties: [{
        addressLine1: '10 HOPE ST', locality: 'PROVIDENCE', region: 'ri', postalCode: '02906',
      }],
    }));

    expect(first.personId).not.toBe(second.personId);
    expect(first.prospectId).not.toBe(second.prospectId);
    expect(counts()).toMatchObject({
      persons: 2,
      prospects: 2,
      organizations: 1,
      properties: 1,
      prospect_organizations: 2,
      prospect_properties: 2,
      sales_cycles: 0,
    });
  });

  it('keeps one Prospect while attaching two listings, organizations, and properties', () => {
    ids.push(
      'person', 'contact', 'prospect',
      'organization-one', 'alias-one',
      'organization-two', 'alias-two',
      'property-one', 'property-two',
    );
    const result = service.createPersonProspect(baseCommand('source', {
      organizations: [
        { canonicalName: 'Shin Holdings LLC' },
        { canonicalName: 'Elmwood Rentals LLC' },
      ],
      properties: [
        { addressLine1: '10 Hope St', locality: 'Providence', region: 'RI' },
        { addressLine1: '20 Elmwood Ave', locality: 'Providence', region: 'RI' },
      ],
    }));

    expect(result.organizationIds).toEqual(['organization-one', 'organization-two']);
    expect(result.propertyIds).toEqual(['property-one', 'property-two']);
    expect(counts()).toMatchObject({
      persons: 1,
      prospects: 1,
      organizations: 2,
      properties: 2,
      prospect_organizations: 2,
      prospect_properties: 2,
      sales_cycles: 0,
    });
  });

  it('keeps one Prospect when a second listing contributes a second LLC and property', () => {
    ids.push(
      'person', 'contact', 'prospect',
      'organization-one', 'alias-one', 'property-one',
    );
    const first = service.createPersonProspect(baseCommand('listing-source-one', {
      organizations: [{ canonicalName: 'Shin Holdings LLC' }],
      properties: [{ addressLine1: '10 Hope St', locality: 'Providence', region: 'RI' }],
    }));
    ids.push('organization-two', 'alias-two', 'property-two');
    const second = service.createPersonProspect(baseCommand('listing-source-two', {
      source: {
        id: 'listing-source-two',
        channel: 'frbo',
        observedAt: '2026-08-30T10:00:00.000Z',
        sourceRecord: { listingId: 'listing-two' },
      },
      organizations: [{ canonicalName: 'Elmwood Rentals LLC' }],
      properties: [{
        addressLine1: '20 Elmwood Ave', locality: 'Providence', region: 'RI',
      }],
    }));

    expect(second).toMatchObject({
      disposition: 'matched_existing',
      personId: first.personId,
      prospectId: first.prospectId,
    });
    expect(counts()).toMatchObject({
      persons: 1,
      prospects: 1,
      source_events: 2,
      organizations: 2,
      properties: 2,
      prospect_organizations: 2,
      prospect_properties: 2,
      sales_cycles: 0,
    });
  });

  it('reports ambiguous organization/property context and never chooses first', () => {
    database.raw.exec(`
      INSERT INTO organizations (id, canonical_name, created_at, updated_at)
      VALUES ('org-a', 'A', '${NOW}', '${NOW}'), ('org-z', 'Z', '${NOW}', '${NOW}');
      INSERT INTO organization_aliases (id, organization_id, alias, created_at)
      VALUES
        ('alias-a', 'org-a', 'shared llc', '${NOW}'),
        ('alias-z', 'org-z', 'shared llc', '${NOW}');
      INSERT INTO properties (
        id, address_line_1, locality, region, country_code, created_at, updated_at
      ) VALUES
        ('property-a', '10 hope st', 'providence', 'ri', 'US', '${NOW}', '${NOW}'),
        ('property-z', '10 hope st', 'providence', 'ri', 'US', '${NOW}', '${NOW}');
    `);
    ids.push('person', 'prospect');
    const result = service.createPersonProspect(baseCommand('source', {
      contacts: [],
      organizations: [{ canonicalName: 'Shared LLC' }],
      properties: [{ addressLine1: '10 Hope St', locality: 'Providence', region: 'RI' }],
    }));

    expect(result.contextReviewReasons).toEqual([
      'ambiguous_organization', 'ambiguous_property',
    ]);
    expect(result.organizationIds).toEqual([]);
    expect(result.propertyIds).toEqual([]);
    expect(counts()).toMatchObject({
      organizations: 2,
      properties: 2,
      prospect_organizations: 0,
      prospect_properties: 0,
    });
  });

  it('refuses to link a matched property owned by a different requested organization', () => {
    database.raw.exec(`
      INSERT INTO organizations (id, canonical_name, created_at, updated_at)
      VALUES
        ('requested-org', 'Requested LLC', '${NOW}', '${NOW}'),
        ('owner-org', 'Owner LLC', '${NOW}', '${NOW}');
      INSERT INTO organization_aliases (id, organization_id, alias, created_at)
      VALUES
        ('requested-alias', 'requested-org', 'requested llc', '${NOW}'),
        ('owner-alias', 'owner-org', 'owner llc', '${NOW}');
      INSERT INTO properties (
        id, organization_id, address_line_1, locality, region, country_code,
        created_at, updated_at
      ) VALUES (
        'owned-property', 'owner-org', '10 hope st', 'providence', 'ri', 'US',
        '${NOW}', '${NOW}'
      );
    `);
    ids.push('person', 'prospect');

    const result = service.createPersonProspect(baseCommand('property-owner-conflict', {
      contacts: [],
      properties: [{
        addressLine1: '10 Hope St', locality: 'Providence', region: 'RI',
        organizationAlias: 'Requested LLC',
      }],
    }));

    expect(result.contextReviewReasons).toEqual(['property_organization_conflict']);
    expect(result.propertyIds).toEqual([]);
    expect(counts().prospect_properties).toBe(0);
  });

  it('links a matched property only when its requested organization uniquely matches', () => {
    database.raw.exec(`
      INSERT INTO organizations (id, canonical_name, created_at, updated_at)
      VALUES ('owner-org', 'Owner LLC', '${NOW}', '${NOW}');
      INSERT INTO organization_aliases (id, organization_id, alias, created_at)
      VALUES ('owner-alias', 'owner-org', 'owner llc', '${NOW}');
      INSERT INTO properties (
        id, organization_id, address_line_1, locality, region, country_code,
        created_at, updated_at
      ) VALUES (
        'owned-property', 'owner-org', '10 hope st', 'providence', 'ri', 'US',
        '${NOW}', '${NOW}'
      );
    `);
    ids.push('person', 'prospect');

    const result = service.createPersonProspect(baseCommand('property-owner-match', {
      contacts: [],
      properties: [{
        addressLine1: '10 Hope St', locality: 'Providence', region: 'RI',
        organizationAlias: 'Owner LLC',
      }],
    }));

    expect(result.contextReviewReasons).toEqual([]);
    expect(result.propertyIds).toEqual(['owned-property']);
    expect(counts().prospect_properties).toBe(1);
  });

  it('preserves a new property unowned and returns durable review for an ambiguous org alias', () => {
    database.raw.exec(`
      INSERT INTO organizations (id, canonical_name, created_at, updated_at)
      VALUES ('org-a', 'A LLC', '${NOW}', '${NOW}'), ('org-z', 'Z LLC', '${NOW}', '${NOW}');
      INSERT INTO organization_aliases (id, organization_id, alias, created_at)
      VALUES
        ('alias-a', 'org-a', 'shared llc', '${NOW}'),
        ('alias-z', 'org-z', 'shared llc', '${NOW}');
    `);
    ids.push('person', 'prospect', 'property');
    const command = baseCommand('ambiguous-property-org', {
      contacts: [],
      properties: [{
        addressLine1: '50 Hope St', locality: 'Providence', region: 'RI',
        organizationAlias: 'Shared LLC',
      }],
    });

    const first = service.createPersonProspect(command);
    const replay = service.createPersonProspect(command);

    expect(first.contextReviewReasons).toEqual(['ambiguous_organization']);
    expect(first.propertyIds).toEqual(['property']);
    expect(database.raw.prepare(`
      SELECT organization_id FROM properties WHERE id = 'property'
    `).get()).toEqual({ organization_id: null });
    expect(replay).toEqual(first);
  });

  it('preserves a new property unowned while recording a missing organization review', () => {
    ids.push('person', 'prospect', 'property');

    const result = service.createPersonProspect(baseCommand('missing-property-organization', {
      contacts: [],
      properties: [{
        addressLine1: '30 Hope St', locality: 'Providence', region: 'RI',
        organizationAlias: 'Missing LLC',
      }],
    }));

    expect(result.contextReviewReasons).toEqual(['organization_not_found']);
    expect(result.propertyIds).toEqual(['property']);
    expect(database.raw.prepare(`
      SELECT organization_id FROM properties WHERE id = 'property'
    `).get()).toEqual({ organization_id: null });
  });

  it('refuses a specifically organized match to an existing unowned property', () => {
    database.raw.exec(`
      INSERT INTO organizations (id, canonical_name, created_at, updated_at)
      VALUES ('requested-org', 'Requested LLC', '${NOW}', '${NOW}');
      INSERT INTO organization_aliases (id, organization_id, alias, created_at)
      VALUES ('requested-alias', 'requested-org', 'requested llc', '${NOW}');
      INSERT INTO properties (
        id, address_line_1, locality, region, country_code, created_at, updated_at
      ) VALUES (
        'unowned-property', '40 hope st', 'providence', 'ri', 'US', '${NOW}', '${NOW}'
      );
    `);
    ids.push('person', 'prospect');

    const result = service.createPersonProspect(baseCommand('unowned-property-conflict', {
      contacts: [],
      properties: [{
        addressLine1: '40 Hope St', locality: 'Providence', region: 'RI',
        organizationAlias: 'Requested LLC',
      }],
    }));

    expect(result.contextReviewReasons).toEqual(['property_organization_conflict']);
    expect(result.propertyIds).toEqual([]);
    expect(counts().prospect_properties).toBe(0);
  });

  it('preserves immutable original attribution while appending later interaction evidence', () => {
    ids.push('person', 'contact', 'prospect');
    const intake = service.createPersonProspect(baseCommand('original-source'));
    const interaction = service.appendSourceInteraction({
      id: 'interaction-source',
      personId: intake.personId,
      prospectId: intake.prospectId,
      channel: 'community',
      observedAt: '2026-08-30T11:00:00.000Z',
      sourceRecord: { event: 'follow-up' },
    });

    expect(interaction).toMatchObject({
      id: 'interaction-source',
      personId: intake.personId,
      prospectId: intake.prospectId,
    });
    expect(database.raw.prepare(`
      SELECT original_source_event_id FROM prospects WHERE id = ?
    `).get(intake.prospectId)).toEqual({ original_source_event_id: 'original-source' });
    expect(sources.getById('original-source')).toMatchObject({ prospectId: null });
    expect(() => database.raw.prepare(`
      UPDATE prospects SET original_source_event_id = 'interaction-source' WHERE id = ?
    `).run(intake.prospectId)).toThrow();
  });

  it('replays an identical stable source without duplicating any aggregate or context', () => {
    ids.push('person', 'contact', 'prospect', 'organization', 'alias', 'property');
    const command = baseCommand('stable-source', {
      organizations: [{ canonicalName: 'Shin Holdings LLC' }],
      properties: [{ addressLine1: '10 Hope St', locality: 'Providence', region: 'RI' }],
    });
    const first = service.createPersonProspect(command);
    const before = counts();
    const replay = service.createPersonProspect({
      ...command,
      source: {
        ...command.source,
        sourceRecord: { listingId: 'stable-source' },
      },
    } as CreatePersonProspectCommand);

    expect(replay).toEqual(first);
    expect(counts()).toEqual(before);
  });

  it('returns durable context review reasons on exact replay', () => {
    ids.push('person', 'prospect', 'property');
    const command = baseCommand('review-replay', {
      contacts: [],
      properties: [{
        addressLine1: '10 Hope St', locality: 'Providence', region: 'RI',
        organizationAlias: 'Missing LLC',
      }],
    });
    const first = service.createPersonProspect(command);
    const replay = service.createPersonProspect(command);

    expect(first.contextReviewReasons).toEqual(['organization_not_found']);
    expect(replay).toEqual(first);
    expect(counts()).toMatchObject({ source_events: 1, source_intake_receipts: 1 });
  });

  it('treats equivalent normalized command formatting as the same intake', () => {
    ids.push('person', 'contact', 'prospect');
    const first = service.createPersonProspect(baseCommand('normalized-replay'));
    const replay = service.createPersonProspect(baseCommand('normalized-replay', {
      contacts: [{
        kind: 'phone', value: '+1 (401) 555-0100', reachability: 'direct', isPrimary: true,
      }],
      source: {
        id: 'normalized-replay', channel: 'frbo', observedAt: OBSERVED_AT,
        sourceRecord: { listingId: 'normalized-replay' },
      },
    }));

    expect(replay).toEqual(first);
  });

  it.each([
    ['source payload', (command: CreatePersonProspectCommand) => ({
      ...command,
      source: { ...command.source, sourceRecord: { listingId: 'different' } },
    })],
    ['person data', (command: CreatePersonProspectCommand) => ({
      ...command, person: { displayName: 'Different Person' },
    })],
    ['contact facts', (command: CreatePersonProspectCommand) => ({
      ...command,
      contacts: [{ kind: 'phone' as const, value: '(401) 555-0100', reachability: 'indirect' as const }],
    })],
  ] as const)('rejects changed %s on retry before writes', (_label, mutate) => {
    ids.push('person', 'contact', 'prospect');
    const command = baseCommand('stable-source');
    service.createPersonProspect(command);
    const before = counts();

    expect(() => service.createPersonProspect(mutate(command) as CreatePersonProspectCommand))
      .toThrow(IntakeIdempotencyConflictError);
    expect(counts()).toEqual(before);
  });

  it('refuses to hijack an interaction SourceEvent that has no intake receipt', () => {
    ids.push('person', 'contact', 'prospect');
    const intake = service.createPersonProspect(baseCommand('original'));
    service.appendSourceInteraction({
      id: 'interaction-only', personId: intake.personId, prospectId: intake.prospectId,
      channel: 'community', observedAt: OBSERVED_AT,
      sourceRecord: { event: 'interaction' },
    });
    const before = counts();

    expect(() => service.createPersonProspect(baseCommand('interaction-only', {
      source: {
        id: 'interaction-only', channel: 'community', observedAt: OBSERVED_AT,
        sourceRecord: { event: 'interaction' },
      },
    }))).toThrow(expect.objectContaining({
      name: 'IntakeIdempotencyConflictError', reason: 'source_event_without_receipt',
    }));
    expect(counts()).toEqual(before);
  });

  it.each([
    ['command_json', '{"formatVersion":99,"command":{}}'],
    ['result_json', '{bad'],
  ] as const)('fails closed when a stored intake receipt has corrupt %s', (column, corrupt) => {
    const sourceId = `corrupt-${column}`;
    database.raw.exec(`
      INSERT INTO persons (
        id, display_name, aliases_json, opted_out, never_record,
        version, created_at, updated_at
      ) VALUES ('corrupt-person', 'Corrupt', '[]', 0, 0, 1, '${NOW}', '${NOW}');
    `);
    database.raw.prepare(`
      INSERT INTO source_events (
        id, person_id, channel, observed_at, source_record_json, created_at
      ) VALUES (?, 'corrupt-person', 'frbo', ?, ?, ?)
    `).run(sourceId, OBSERVED_AT, JSON.stringify({
      formatVersion: 1,
      sourceRecord: { listingId: sourceId },
      customSourceReason: null,
    }), NOW);
    const validCommand = serializeCanonicalIntakeCommand(canonicalRaceCommand(sourceId));
    const validResult = JSON.stringify({ formatVersion: 1, result: raceResult(sourceId) });
    database.raw.prepare(`
      INSERT INTO source_intake_receipts (
        source_event_id, command_json, result_json, created_at
      ) VALUES (?, ?, ?, ?)
    `).run(
      sourceId,
      column === 'command_json' ? corrupt : validCommand,
      column === 'result_json' ? corrupt : validResult,
      NOW,
    );

    expect(() => service.createPersonProspect(baseCommand(sourceId))).toThrow(z.ZodError);
    expect(counts()).toMatchObject({ persons: 1, source_events: 1, source_intake_receipts: 1 });
  });

  it.each([
    'after_person',
    'after_source_event',
    'after_prospect',
    'after_organization',
    'after_organization_link',
    'after_property',
    'after_property_link',
    'after_receipt',
  ] as const)('rolls back every artifact after an injected %s failure', (faultPoint) => {
    ids.push(
      'person', 'contact', 'prospect',
      'organization', 'alias', 'property',
    );
    rebuildService((point) => {
      if (point === faultPoint) throw new Error(`fault:${point}`);
    });
    const command = baseCommand(`source-${faultPoint}`, {
      organizations: [{ canonicalName: 'Shin Holdings LLC' }],
      properties: [{ addressLine1: '10 Hope St', locality: 'Providence', region: 'RI' }],
    });

    expect(() => service.createPersonProspect(command)).toThrow(`fault:${faultPoint}`);
    expect(Object.values(counts()).every((count) => count === 0)).toBe(true);
  });

  it('validates a whole batch first and rolls back prior commands on a later database failure', () => {
    ids.push('must-not-write');
    expect(() => service.commitBatch([
      baseCommand('valid-first', { contacts: [] }),
      baseCommand('invalid-second', {
        contacts: [{ kind: 'email', value: 'not-an-email', reachability: 'direct' }],
      }),
    ])).toThrow(z.ZodError);
    expect(Object.values(counts()).every((count) => count === 0)).toBe(true);

    ids.push('person-one', 'prospect-one', 'person-two', 'prospect-two');
    expect(() => service.commitBatch([
      baseCommand('first-source', { contacts: [] }),
      {
        person: { displayName: 'Second' },
        contacts: [],
        source: {
          id: 'second-source',
          channel: 'referral',
          observedAt: OBSERVED_AT,
          sourceRecord: { introduction: 'broken' },
          referral: { kind: 'known' as const, referredByPersonId: 'missing-referrer' },
        },
      },
    ])).toThrow();
    expect(Object.values(counts()).every((count) => count === 0)).toBe(true);
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for contender readiness.');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

function captureChildExit(child: ChildProcess): Promise<{ code: number | null; stderr: string }> {
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolvePromise({ code, stderr }));
  });
}
