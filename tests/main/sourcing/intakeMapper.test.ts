import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../../src/main/db/database';
import { migrateToLatest } from '../../../src/main/db/migrate';
import { IdentityRepository } from '../../../src/main/domain/identity/identityRepository';
import { IntakeReceiptRepository } from '../../../src/main/domain/source/intakeReceiptRepository';
import { SourceRepository } from '../../../src/main/domain/source/sourceRepository';
import { segmentForChannel, SourceService } from '../../../src/main/domain/source/sourceService';
import { DomainUnitOfWork } from '../../../src/main/domain/support/domainUnitOfWork';
import {
  buildNeedsIdentityIntakeCommand,
  cloudReceiptKey,
  CloudEventUnmappableError,
  mapCloudSourceEvent,
} from '../../../src/main/sourcing/intakeMapper';
import { validFrboEvent, validParcelEvent, validEnrichmentEvent } from '../../fixtures/cloudSourceEvents';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../../fixtures/tempDatabase';
import type { CloudSourceEvent } from '../../../src/shared/contracts/cloudSourceEventContract';

const NOW = '2026-09-01T12:00:00.000Z';

function scoredEvent(base: CloudSourceEvent): CloudSourceEvent {
  return {
    ...base,
    scores: {
      fit: 62,
      timing: 41,
      reasons: [
        { signal: 'portfolio_in_band', contribution: 15 },
        { signal: 'permit_filed_recent', contribution: 12 },
      ],
    },
    scores_version: 2,
  };
}

describe('cloudReceiptKey', () => {
  it('prefixes the cloud idempotency key', () => {
    expect(cloudReceiptKey('a'.repeat(64))).toBe(`cloud:${'a'.repeat(64)}`);
  });
});

describe('mapCloudSourceEvent', () => {
  describe('person-bearing events -> intake', () => {
    it('maps a parcel owner event to a full intake command', () => {
      const event = validParcelEvent();

      const mapped = mapCloudSourceEvent(event);

      expect(mapped.kind).toBe('intake');
      if (mapped.kind !== 'intake') return;
      expect(mapped.receiptKey).toBe(`cloud:${event.idempotency_key}`);
      expect(mapped.cloudEntityId).toBe(event.entity.cloud_entity_id);
      expect(mapped.segment).toBe('cold');
      expect(mapped.trigger).toBeNull();
      expect(mapped.command).toEqual({
        person: {
          displayName: 'JANE ROE',
          provenance: {
            cloudEntityId: event.entity.cloud_entity_id,
            sourceUri: event.source_uri,
            mailingAddress: event.entity.person?.mailing_address ?? null,
          },
        },
        contacts: [
          {
            kind: 'phone',
            value: '+14015551234',
            reachability: 'direct',
            isPrimary: true,
            complianceEvidence: {
              federalStatus: 'unknown',
              tcpaFlag: null,
              coveredAreaCode: null,
              source: 'legacy',
              scrubbedAt: null,
              expiresAt: null,
            },
          },
          {
            kind: 'email',
            value: 'jane@example.com',
            reachability: 'direct',
            isPrimary: true,
          },
        ],
        organizations: [{ canonicalName: 'ROE PROPERTIES LLC' }],
        properties: [{
          addressLine1: '9 Doyle Ave',
          locality: 'Providence',
          region: 'RI',
          postalCode: '02906',
          countryCode: 'US',
          doorCount: 3,
          propertyType: '3F',
          sourceRecord: {
            parcelId: 'PROV-123-456',
            yearBuilt: 1918,
            useCode: '3F',
          },
        }],
        source: {
          id: `cloud:${event.idempotency_key}`,
          channel: 'parcel',
          observedAt: '2026-08-30T00:00:00.000Z',
          sourceRecord: { cloudSourceEvent: event },
        },
      });
    });

    it('marks only the first phone and first email primary', () => {
      const event = validParcelEvent();
      (event.entity.person as { phones: string[] }).phones = [
        '+14015551234', '+14015555678',
      ];

      const mapped = mapCloudSourceEvent(event);

      if (mapped.kind !== 'intake') throw new Error('expected intake');
      expect(mapped.command.contacts.map((contact) => contact.isPrimary)).toEqual(
        [true, false, true],
      );
    });

    it('carries the exact evidence record through cloud and app contracts', () => {
      const event = validEnrichmentEvent();

      const mapped = mapCloudSourceEvent(event);

      expect(mapped.kind).toBe('intake');
      if (mapped.kind !== 'intake') return;
      expect(mapped.command.contacts).toEqual([
        {
          kind: 'phone',
          value: '+14015550100',
          reachability: 'direct',
          isPrimary: true,
          complianceEvidence: {
            federalStatus: 'unknown',
            tcpaFlag: null,
            coveredAreaCode: null,
            source: 'enrichment_vendor',
            scrubbedAt: null,
            expiresAt: null,
          },
        },
        {
          kind: 'phone',
          value: '+14015550101',
          reachability: 'direct',
          isPrimary: false,
          complianceEvidence: {
            federalStatus: 'listed',
            tcpaFlag: null,
            coveredAreaCode: null,
            source: 'enrichment_vendor',
            scrubbedAt: null,
            expiresAt: null,
          },
        },
        {
          kind: 'email',
          value: 'jane.roe@example.com',
          reachability: 'direct',
          isPrimary: true,
        },
      ]);
    });

    it('carries positive TCPA evidence through to the contact input', () => {
      const event = validEnrichmentEvent();
      (event.payload as { phones: Array<{ compliance: { tcpa_flag: boolean | null } }> })
        .phones[0]!.compliance.tcpa_flag = true;

      const mapped = mapCloudSourceEvent(event);

      if (mapped.kind !== 'intake') throw new Error('expected intake');
      const flagged = mapped.command.contacts.find(
        (contact) => contact.value === '+14015550101',
      );
      expect(flagged?.complianceEvidence?.tcpaFlag).toBe(true);
    });

    it('keeps entity.person contacts (default flags) for an enrichment miss', () => {
      const event = validEnrichmentEvent();
      (event.payload as { hit: boolean; phones: unknown[] }).hit = false;
      (event.payload as { phones: unknown[] }).phones = [];
      (event.payload as { emails: unknown[] }).emails = [];
      (event.entity.person as { phones: string[] }).phones = ['+14015559999'];

      const mapped = mapCloudSourceEvent(event);

      if (mapped.kind !== 'intake') throw new Error('expected intake');
      expect(mapped.command.contacts).toEqual([{
        kind: 'phone',
        value: '+14015559999',
        reachability: 'direct',
        isPrimary: true,
        complianceEvidence: {
          federalStatus: 'unknown',
          tcpaFlag: null,
          coveredAreaCode: null,
          source: 'legacy',
          scrubbedAt: null,
          expiresAt: null,
        },
      }]);
    });

    it('falls back to the organization name when the person has no full name', () => {
      const event = validParcelEvent();
      (event.entity.person as { full_name: string | null }).full_name = null;

      const mapped = mapCloudSourceEvent(event);

      if (mapped.kind !== 'intake') throw new Error('expected intake');
      expect(mapped.command.person.displayName).toBe('ROE PROPERTIES LLC');
    });

    it('omits the property when the situs address is unusable', () => {
      const event = validParcelEvent();
      (event.entity.property as { situs_address: unknown }).situs_address = null;

      const mapped = mapCloudSourceEvent(event);

      if (mapped.kind !== 'intake') throw new Error('expected intake');
      expect(mapped.command.properties).toEqual([]);
    });

    it('carries the contract trigger for trigger-bearing events', () => {
      const event = validParcelEvent();
      event.trigger = {
        type: 'review_pain', weight: 1.0, half_life_days: 45, window: null,
      };

      const mapped = mapCloudSourceEvent(event);

      if (mapped.kind !== 'intake') throw new Error('expected intake');
      expect(mapped.trigger).toEqual({
        type: 'review_pain', weight: 1.0, half_life_days: 45, window: null,
      });
    });

    it('canonicalizes a seconds-precision observed_at timestamp', () => {
      const event = validParcelEvent();
      event.observed_at = '2026-08-30T00:00:00Z';

      const mapped = mapCloudSourceEvent(event);

      if (mapped.kind !== 'intake') throw new Error('expected intake');
      expect(mapped.command.source.observedAt).toBe('2026-08-30T00:00:00.000Z');
    });

    it.each([
      ['frbo', 'hot'],
      ['community', 'hot'],
      ['registry', 'cold'],
      ['parcel', 'cold'],
      ['deed', 'cold'],
      ['permit', 'cold'],
      ['violation', 'cold'],
      ['rireig', 'warm'],
      ['inbound_demo', 'warm'],
    ] as const)('maps channel %s to segment %s via segmentForChannel', (channel, segment) => {
      const event: CloudSourceEvent = { ...validParcelEvent(), channel, trigger: null };

      const mapped = mapCloudSourceEvent(event);

      if (mapped.kind !== 'intake') throw new Error('expected intake');
      expect(mapped.segment).toBe(segment);
      expect(mapped.segment).toBe(segmentForChannel(channel));
      expect(mapped.command.source.channel).toBe(channel);
    });

    it('attaches an unknown referral attribution for referral events', () => {
      const event: CloudSourceEvent = { ...validParcelEvent(), channel: 'referral' };

      const mapped = mapCloudSourceEvent(event);

      if (mapped.kind !== 'intake') throw new Error('expected intake');
      expect(mapped.command.source).toMatchObject({
        channel: 'referral',
        referral: { kind: 'unknown', reason: 'not_provided' },
      });
      expect(mapped.segment).toBe('warm');
    });
  });

  describe('person-null events -> needs-identity', () => {
    it('maps an frbo listing without a person to a needs-identity item', () => {
      const event = validFrboEvent();

      const mapped = mapCloudSourceEvent(event);

      expect(mapped).toEqual({
        kind: 'needs-identity',
        receiptKey: `cloud:${event.idempotency_key}`,
        cloudEntityId: event.entity.cloud_entity_id,
        channel: 'frbo',
        segment: 'hot',
        observedAt: '2026-09-01T02:59:00.000Z',
        situsAddress: event.entity.property?.situs_address ?? null,
        parcelId: null,
        event,
      });
    });

    it('treats a person without name or organization as needs-identity', () => {
      const event = validParcelEvent();
      const person = event.entity.person as {
        full_name: string | null; org_names: string[];
      };
      person.full_name = null;
      person.org_names = [];

      const mapped = mapCloudSourceEvent(event);

      expect(mapped.kind).toBe('needs-identity');
    });

    it('builds a placeholder intake command anchored to the situs address', () => {
      const event = validFrboEvent();
      const mapped = mapCloudSourceEvent(event);
      if (mapped.kind !== 'needs-identity') throw new Error('expected needs-identity');

      const command = buildNeedsIdentityIntakeCommand(mapped);

      expect(command).not.toBeNull();
      expect(command!.person.displayName).toBe('Unknown owner · 123 Hope St, Providence');
      expect(command!.contacts).toEqual([]);
      expect(command!.organizations).toEqual([]);
      expect(command!.properties).toEqual([{
        addressLine1: '123 Hope St',
        locality: 'Providence',
        region: 'RI',
        postalCode: '02906',
        countryCode: 'US',
        doorCount: null,
        propertyType: null,
        sourceRecord: { parcelId: null, yearBuilt: null, useCode: null },
      }]);
      expect(command!.source).toEqual({
        id: `cloud:${event.idempotency_key}`,
        channel: 'frbo',
        observedAt: '2026-09-01T02:59:00.000Z',
        sourceRecord: { cloudSourceEvent: event },
      });
    });

    it('returns null when the event has no usable situs address', () => {
      const event = validFrboEvent();
      (event.entity.property as { situs_address: unknown }).situs_address = null;
      const mapped = mapCloudSourceEvent(event);
      if (mapped.kind !== 'needs-identity') throw new Error('expected needs-identity');

      expect(buildNeedsIdentityIntakeCommand(mapped)).toBeNull();
    });
  });

  describe('scored re-emissions -> score-update', () => {
    it('maps a scores_version event to a score update, never an intake', () => {
      const event = scoredEvent(validParcelEvent());

      const mapped = mapCloudSourceEvent(event);

      expect(mapped).toEqual({
        kind: 'score-update',
        idempotencyKey: event.idempotency_key,
        receiptKey: `cloud:${event.idempotency_key}`,
        scoresVersion: 2,
        fit: 62,
        timing: 41,
        reasons: [
          { signal: 'portfolio_in_band', contribution: 15 },
          { signal: 'permit_filed_recent', contribution: 12 },
        ],
        scoredAt: '2026-08-30T00:00:00.000Z',
      });
    });

    it('maps a scored person-null event to a score update too', () => {
      const mapped = mapCloudSourceEvent(scoredEvent(validFrboEvent()));
      expect(mapped.kind).toBe('score-update');
    });

    it('rejects a scores_version event without a scores block', () => {
      const event: CloudSourceEvent = { ...validParcelEvent(), scores_version: 1 };
      expect(() => mapCloudSourceEvent(event)).toThrow(CloudEventUnmappableError);
    });
  });

  describe('unmappable events', () => {
    it('rejects channel custom (the cloud never emits it)', () => {
      const event: CloudSourceEvent = { ...validParcelEvent(), channel: 'custom' };
      expect(() => mapCloudSourceEvent(event)).toThrow(CloudEventUnmappableError);
    });
  });
});

describe('idempotent replay through the real intake pipeline', () => {
  let database: AppDatabase;
  let tempDatabase: TempDatabase;
  let service: SourceService;
  let ids: string[];

  beforeEach(async () => {
    tempDatabase = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: tempDatabase.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${tempDatabase.path}.backups`,
      workspaceKey: key,
    });
    const unitOfWork = new DomainUnitOfWork(database);
    ids = [];
    const clock = { now: () => NOW };
    const identities = new IdentityRepository({
      database,
      unitOfWork,
      clock,
      ids: {
        next: () => {
          const id = ids.shift();
          if (id === undefined) throw new Error('Test ID sequence exhausted.');
          return id;
        },
      },
    });
    const sources = new SourceRepository({ database, unitOfWork, clock });
    const receipts = new IntakeReceiptRepository({ database, unitOfWork, clock });
    service = new SourceService({ database, unitOfWork, identities, sources, receipts });
  });

  afterEach(() => {
    closeDatabase(database);
    tempDatabase.cleanup();
  });

  it('creates once and replays as a no-op keyed by cloud:<idempotency_key>', () => {
    const event = validParcelEvent();

    const first = mapCloudSourceEvent(event);
    if (first.kind !== 'intake') throw new Error('expected intake');
    ids.push(
      'person-1', 'contact-1', 'contact-2', 'prospect-1',
      'org-1', 'alias-1', 'property-1',
    );
    const firstResult = service.createPersonProspect(first.command);

    expect(firstResult.disposition).toBe('created');
    expect(firstResult.sourceEventId).toBe(`cloud:${event.idempotency_key}`);

    const replay = mapCloudSourceEvent(event);
    if (replay.kind !== 'intake') throw new Error('expected intake');
    const replayResult = service.createPersonProspect(replay.command);

    expect(replayResult).toEqual(firstResult);
    expect(database.raw.prepare<[], { count: number }>(
      'SELECT COUNT(*) AS count FROM persons',
    ).get()).toEqual({ count: 1 });
    expect(database.raw.prepare<[], { count: number }>(
      'SELECT COUNT(*) AS count FROM source_events',
    ).get()).toEqual({ count: 1 });
    expect(database.raw.prepare<[], { source_event_id: string }>(
      'SELECT source_event_id FROM source_intake_receipts',
    ).get()).toEqual({ source_event_id: `cloud:${event.idempotency_key}` });
    expect(database.raw.prepare<[], { segment: string }>(
      "SELECT segment FROM prospects WHERE id = 'prospect-1'",
    ).get()).toEqual({ segment: 'cold' });
  });
});
