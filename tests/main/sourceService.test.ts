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
  SourceEventIdempotencyConflictError,
  SourceRepository,
} from '../../src/main/domain/source/sourceRepository';
import {
  normalizeEmail,
  normalizePhone,
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
    service = new SourceService({
      database,
      unitOfWork,
      identities,
      sources,
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

  it('documents the V1 US phone default and conservative full-lowercase email policy', () => {
    expect(normalizePhone('(401) 555-0100')).toBe('+14015550100');
    expect(normalizePhone('1 401 555 0100')).toBe('+14015550100');
    expect(normalizePhone('+442071838750')).toBe('+442071838750');
    expect(() => normalizePhone('555-0100')).toThrow(z.ZodError);
    expect(() => normalizePhone('+01234567890')).toThrow(z.ZodError);
    expect(() => normalizePhone('+44 20 7183 8750')).toThrow(z.ZodError);

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

  it('validates the entire command before writes', () => {
    ids.push('must-not-be-consumed');
    expect(() => service.createPersonProspect(baseCommand('invalid-source', {
      contacts: [{ kind: 'phone', value: '555-0100', reachability: 'direct' }],
    }))).toThrow(z.ZodError);
    expect(counts()).toEqual({
      persons: 0,
      person_contact_methods: 0,
      source_events: 0,
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
    expect(counts()).toMatchObject({ persons: 1, prospects: 1, source_events: 2 });
    expect(sources.listByPerson('contended-person').map(({ id }) => id)).toEqual([
      'contended-source-one', 'contended-source-two',
    ]);
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

    expect(replay).toMatchObject({
      disposition: 'matched_existing',
      personId: first.personId,
      prospectId: first.prospectId,
      sourceEventId: first.sourceEventId,
      organizationIds: first.organizationIds,
      propertyIds: first.propertyIds,
    });
    expect(counts()).toEqual(before);
  });

  it('rejects a changed source payload on retry and rolls back all attempted writes', () => {
    ids.push('person', 'contact', 'prospect');
    service.createPersonProspect(baseCommand('stable-source'));
    const before = counts();

    expect(() => service.createPersonProspect(baseCommand('stable-source', {
      source: {
        id: 'stable-source',
        channel: 'frbo',
        observedAt: OBSERVED_AT,
        sourceRecord: { listingId: 'different' },
      },
    }))).toThrow(SourceEventIdempotencyConflictError);
    expect(counts()).toEqual(before);
  });

  it.each([
    'after_person',
    'after_source_event',
    'after_prospect',
    'after_organization',
    'after_organization_link',
    'after_property',
    'after_property_link',
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
