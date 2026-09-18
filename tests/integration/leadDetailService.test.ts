import { productionDomainGate } from '../fixtures/productionDomainGate';
import { validParcelEvent } from '../fixtures/cloudSourceEvents';
import { cloudSourceEventSchema } from '../../src/shared/contracts/cloudSourceEventContract';
import { randomUUID } from 'node:crypto';
import { createOutboundCommandService } from '../../src/main/communications/outboundCommandService';
import {
  createLegacyLeadDetailProvider as createLeadDetailProvider, createTodayProvider, type LegacyLeadDetailProvider,
} from '../fixtures/legacyDomainProviders';
import type { OutboundRequest } from '../../src/shared/contracts/outboundContract';
import { contactSnapshot } from '../../src/main/communications/contactSnapshot';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeDatabase,
  openDatabase,
  type AppDatabase,
} from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import {
  createDomainServices,
  type DomainServices,
} from '../../src/main/domain/createDomainServices';
import {
  createFounderSalesDomain,
  type FounderSalesDomain,
} from '../../src/main/domain/founderSalesDomain';
import {
  BUILTIN_PRIORITIZATION_RULE_V1,
} from '../../src/main/domain/prioritization/builtinPrioritizationRules';
import {
  contactMethodSchema,
  leadDetailSchema,
  type ContactMethod,
} from '../../src/shared/contracts/leadDetailContract';
import {
  DOMAIN_TIMESTAMP,
  insertOpenCycleWithAction,
  seedProspect,
  type SeededProspect,
} from '../fixtures/domainRows';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../fixtures/tempDatabase';


function readinessProof(personId = 'fixture-person') {
  return Object.freeze({
    subject: Object.freeze({ kind: 'person' as const, id: personId }),
    registryRevision: 1,
    checkpoints: Object.freeze([]),
  });
}
function readyReply(personId?: string) {
  return { kind: 'ready' as const, proof: readinessProof(personId) };
}
const assertCurrentReadiness = (): void => undefined;

const CLOCK_NOW = '2026-08-31T15:00:00.000Z';

class FixedClock {
  constructor(private value: string = CLOCK_NOW) {}

  now(): string {
    return this.value;
  }
}

class SequentialIds {
  private counter = 0;

  next(): string {
    this.counter += 1;
    return `generated-${this.counter}`;
  }
}

describe('leadDetailService over a real encrypted domain', () => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let services: DomainServices;
  let domain: FounderSalesDomain;
  let leadDetail: LegacyLeadDetailProvider;
  let ruleVersionId: string;

  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${temp.path}.backups`, workspaceKey: key,
    });
    const clock = new FixedClock();
    const ids = new SequentialIds();
    services = createDomainServices({ database, clock, ids });
    services.unitOfWork.immediate(() => {
      const installed = services.prioritizationRepository
        .installRuleVersion(BUILTIN_PRIORITIZATION_RULE_V1);
      ruleVersionId = installed.id;
      services.prioritizationRepository.activateRuleVersion({
        ruleVersionId: installed.id, expectedActiveRuleVersionId: null,
      });
      services.cadences.installBuiltins();
    });
    domain = createFounderSalesDomain({ services, database, clock, ids });
    leadDetail = createLeadDetailProvider(productionDomainGate(domain));
  });

  afterEach(() => {
    closeDatabase(database);
    temp.cleanup();
  });

  function seedLead(prefix: string): {
    prospect: SeededProspect;
    cycleId: string;
    actionId: string;
  } {
    const prospect = seedProspect(database.raw, prefix);
    const { cycleId, actionId } = insertOpenCycleWithAction({
      database: database.raw, prefix, prospect,
    });
    return { prospect, cycleId, actionId };
  }

  function addPhone(prospect: SeededProspect, id: string): void {
    database.raw.prepare(`
      INSERT INTO person_contact_methods (
        id, person_id, kind, normalized_value, validation_state, reachability,
        is_primary, federal_status, compliance_tcpa_flag, covered_area_code,
        compliance_source, scrubbed_at, compliance_expires_at, created_at, updated_at
      ) VALUES (?, ?, 'phone', '+14015550100', 'valid', 'direct', 1,
        'verified_clear', 0, '401', 'ftc_download', '2026-08-15T00:00:00.000Z',
        '2026-09-15T00:00:00.000Z', ?, ?)
    `).run(id, prospect.personId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    database.raw.prepare(`INSERT INTO person_outbound_jurisdictions
      (person_id, region_code, timezone, source, effective_at, updated_at)
      VALUES (?, 'RI', 'America/New_York', 'manual_review', ?, ?)`)
      .run(prospect.personId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    for (const channel of ['call', 'text']) {
      database.raw.prepare(`INSERT OR REPLACE INTO outbound_jurisdiction_clearances
        (region_code, channel, decision, registration_confirmed,
         state_dnc_subscription_confirmed, consent_rule_confirmed, source,
         effective_at, expires_at, updated_at)
        VALUES ('RI', ?, 'allowed', 1, 1, 1, 'test',
          '2026-08-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', ?)`)
        .run(channel, DOMAIN_TIMESTAMP);
    }
  }

  function addEmail(prospect: SeededProspect, id: string): void {
    database.raw.prepare(`INSERT INTO person_contact_methods (
      id, person_id, kind, normalized_value, validation_state, reachability,
      is_primary, created_at, updated_at
    ) VALUES (?, ?, 'email', 'founder@example.com', 'valid', 'direct', 1, ?, ?)`)
      .run(id, prospect.personId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
  }

  function seedEnrichmentLead(fitBand: 'low' | 'medium' | 'high' | null = 'high', includeOwnerEvidence = true) {
    const lead = seedLead('enrichment');
    database.raw.prepare(`INSERT INTO cloud_entity_links (cloud_entity_id, person_id, linked_at)
      VALUES ('ce_01JC0000000000000000000000', ?, ?)`)
      .run(lead.prospect.personId, DOMAIN_TIMESTAMP);
    services.unitOfWork.immediate(() => {
      const property = services.identities.createProperty({
        addressLine1: '123 Hope St', locality: 'Providence', region: 'RI',
        postalCode: '02906', countryCode: 'US',
      });
      services.identities.linkProperty({
        prospectId: lead.prospect.prospectId, propertyId: property.id, relationship: 'owner',
      });
      if (includeOwnerEvidence) {
        // Supported identity is evidence-backed, not inferred from a nonempty display name.
        const source = validParcelEvent();
        source.entity.cloud_entity_id = 'ce_01JC0000000000000000000000';
        source.entity.person = { ...source.entity.person!, full_name: 'Person enrichment-person',
          org_names: [], phones: [], emails: [] };
        source.entity.property = { ...source.entity.property!,
          situs_address: { line1: '123 Hope St', locality: 'Providence', region: 'RI', postal_code: '02906', country_code: 'US' },
          parcel_id: null, unit_count: null };
        source.source_uri = 'fixture:enrichment:linked-owner';
        source.fetched_at = CLOCK_NOW;
        services.sourceRepository.append({ id: 'enrichment-owner-source', channel: 'parcel',
          personId: lead.prospect.personId, prospectId: lead.prospect.prospectId, salesCycleId: lead.cycleId,
          observedAt: source.observed_at, sourceRecord: { cloudSourceEvent: cloudSourceEventSchema.parse(source) },
          evidenceRef: source.source_uri });
      }
    });
    if (fitBand !== null) {
      // Faithful evaluation/projection pair, preserving the fidelity triggers.
      const points = fitBand === 'high' ? 25 : fitBand === 'medium' ? 15 : 5;
      database.raw.prepare(`INSERT INTO prioritization_evaluations (
        id, prospect_id, rule_version_id, decision_kind, evaluated_at, fit_points, fit_band,
        timing_millipoints, timing_band, reachability, data_confidence, priority,
        earliest_trigger_expires_at, verify_first, command_json, input_snapshot_json,
        result_json, explanation_json, created_at
      ) VALUES ('enrichment-evaluation', ?, ?, 'evaluated', ?, ?, ?, 0, 'cold', 'none',
        8, 'p3', NULL, 0, '{}', '{}', '{}', '[]', ?)`)
        .run(lead.prospect.prospectId, ruleVersionId, CLOCK_NOW, points, fitBand, CLOCK_NOW);
      database.raw.prepare(`INSERT INTO prospect_priority_projection (
        prospect_id, rule_version_id, evaluation_id, fit_points, fit_band,
        timing_millipoints, timing_band, reachability, data_confidence, priority,
        earliest_trigger_expires_at, verify_first, version, evaluated_at, updated_at
      ) VALUES (?, ?, 'enrichment-evaluation', ?, ?, 0, 'cold', 'none', 8, 'p3', NULL, 0, 1, ?, ?)`)
        .run(lead.prospect.prospectId, ruleVersionId, points, fitBand, CLOCK_NOW, CLOCK_NOW);
    }
    return lead;
  }

  it('refuses enrichment for a nonempty name without supported owner evidence', async () => {
    const { prospect } = seedEnrichmentLead('high', false);
    const before = database.raw.prepare('SELECT total_changes() AS n').get();
    expect(domain.getEnrichmentRequestCandidate({ personId: prospect.personId })).toMatchObject({
      ownerFullName: 'Person enrichment-person', fitBand: 'high', identityReady: false,
    });
    expect((await leadDetail.get({ personId: prospect.personId })).findContactEligibility)
      .toEqual({ eligible: false, refusalReason: 'identity_or_address_missing' });
    expect(database.raw.prepare('SELECT total_changes() AS n').get()).toEqual(before);
    expect(database.raw.prepare('SELECT count(*) AS n FROM sourcing_enrichment_requests').get()).toEqual({ n: 0 });
  });

  it.each(['medium', 'high'] as const)('projects complete %s-fit eligibility from persisted evidence without mutating', async (fitBand) => {
    const { prospect } = seedEnrichmentLead(fitBand);
    const changes = database.raw.prepare('SELECT total_changes() AS n').get();
    expect(domain.getEnrichmentRequestCandidate({ personId: prospect.personId })).toEqual({
      cloudEntityId: 'ce_01JC0000000000000000000000', ownerFullName: 'Person enrichment-person',
      situsAddress: { line1: '123 Hope St', locality: 'Providence', region: 'RI', postalCode: '02906' },
      lastRequestedAt: null, qualificationState: 'eligible', fitBand,
      identityReady: true, hasUsableDirectContact: false, suppressionBlocked: false,
    });
    const detail = await leadDetail.get({ personId: prospect.personId });
    expect(detail.findContactEligibility).toEqual({ eligible: true, refusalReason: null });
    expect(leadDetailSchema.safeParse(detail).success).toBe(true);
    expect(database.raw.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
  });

  it.each(['unreviewed', 'disqualified', 'merge_review'] as const)('requires founder qualification for %s even with high fit', async (state) => {
    const { prospect } = seedEnrichmentLead();
    database.raw.prepare(`UPDATE prospects SET qualification_state = ?, qualification_gate_reason = ? WHERE id = ?`)
      .run(state, state === 'disqualified' ? 'out_of_area' : null, prospect.prospectId);
    const candidate = domain.getEnrichmentRequestCandidate({ personId: prospect.personId });
    expect(candidate.qualificationState).toBe(state);
    if (state === 'merge_review') expect(candidate.identityReady).toBe(false);
    expect((await leadDetail.get({ personId: prospect.personId })).findContactEligibility)
      .toEqual({ eligible: false, refusalReason: 'qualification_required' });
  });

  it.each(['low', null] as const)('refuses %s persisted fit even with high cloud scores', async (fitBand) => {
    const { prospect } = seedEnrichmentLead(fitBand);
    database.raw.prepare('UPDATE prospects SET cloud_fit = 99, cloud_timing = 99 WHERE id = ?').run(prospect.prospectId);
    expect(domain.getEnrichmentRequestCandidate({ personId: prospect.personId }).fitBand).toBe(fitBand);
    expect((await leadDetail.get({ personId: prospect.personId })).findContactEligibility)
      .toEqual({ eligible: false, refusalReason: 'fit_gate_failed' });
  });

  it.each(['cloud link', 'address', 'name', 'deleted identity'] as const)('refuses missing %s', async (missing) => {
    const { prospect } = seedEnrichmentLead();
    if (missing === 'cloud link') database.raw.prepare('DELETE FROM cloud_entity_links').run();
    if (missing === 'address') database.raw.prepare("UPDATE properties SET locality = ''").run();
    if (missing === 'name') database.raw.prepare("UPDATE persons SET display_name = '  ' WHERE id = ?").run(prospect.personId);
    if (missing === 'deleted identity') database.raw.prepare('UPDATE persons SET deleted_at = ? WHERE id = ?').run(CLOCK_NOW, prospect.personId);
    expect((await leadDetail.get({ personId: prospect.personId })).findContactEligibility)
      .toEqual({ eligible: false, refusalReason: 'identity_or_address_missing' });
  });

  it.each([
    ['phone', 'verified_person', 'valid', 'direct', true],
    ['email', 'verified_person', 'valid', 'indirect', true],
    ['phone', 'vendor_candidate', 'valid', 'direct', false],
    ['phone', 'unknown', 'valid', 'direct', false],
    ['phone', 'conflicting_identity', 'valid', 'direct', false],
    ['phone', 'verified_person', 'unverified', 'direct', false],
    ['phone', 'verified_person', 'invalid', 'direct', false],
    ['email', 'verified_person', 'valid', 'none', false],
  ] as const)('derives usable contact from %s/%s/%s/%s evidence', async (kind, ownership, validation, reachability, usable) => {
    const { prospect } = seedEnrichmentLead();
    if (kind === 'phone') addPhone(prospect, 'contact');
    else addEmail(prospect, 'contact');
    database.raw.prepare(`UPDATE person_contact_methods SET ownership_state = ?, validation_state = ?, reachability = ? WHERE id = 'contact'`)
      .run(ownership, validation, reachability);
    expect(domain.getEnrichmentRequestCandidate({ personId: prospect.personId }).hasUsableDirectContact).toBe(usable);
    expect((await leadDetail.get({ personId: prospect.personId })).findContactEligibility).toEqual({
      eligible: !usable, refusalReason: usable ? 'direct_contact_exists' : null,
    });
  });

  it('projects rate refusal from the persisted 30-day ledger', async () => {
    const { prospect } = seedEnrichmentLead();
    domain.recordEnrichmentRequested({ cloudEntityId: 'ce_01JC0000000000000000000000' });
    expect(domain.getEnrichmentRequestCandidate({ personId: prospect.personId }).lastRequestedAt).toBe(CLOCK_NOW);
    expect((await leadDetail.get({ personId: prospect.personId })).findContactEligibility)
      .toEqual({ eligible: false, refusalReason: 'rate_limited' });
  });

  it('requires the exact closed eligibility DTO instead of an optional renderer hint', async () => {
    const { prospect } = seedEnrichmentLead();
    const detail = await leadDetail.get({ personId: prospect.personId });
    const withoutEligibility: Record<string, unknown> = { ...detail };
    delete withoutEligibility.findContactEligibility;
    expect(leadDetailSchema.safeParse(withoutEligibility).success).toBe(false);
    const invalidEligibility: unknown[] = [
      { eligible: true, refusalReason: null, extra: true },
      { eligible: false, refusalReason: 'not_eligible' },
    ];
    for (const eligibility of invalidEligibility) {
      expect(leadDetailSchema.safeParse({ ...detail, findContactEligibility: eligibility }).success).toBe(false);
    }
  });

  it.each(['detail', 'list'] as const)('keeps an absent projection null in real %s output without getter writes', async surface => {
    const { prospect } = seedLead('not-assessed');
    const before = database.raw.prepare('SELECT total_changes() AS n').get();
    const detail = await leadDetail.get({ personId: prospect.personId });
    const list = domain.listLeadRows({ query: '', stages: [], priorities: [], sort: 'priority', cursor: null, limit: 20 });
    const output = surface === 'detail' ? detail : list.rows.find(row => row.personId === prospect.personId);
    expect(output).toBeDefined();
    expect(output?.priorityContext).toBeNull();
    expect(detail.priorityReasons).toEqual([]);
    expect(detail.findContactEligibility).toEqual({ eligible: false, refusalReason: 'fit_gate_failed' });
    expect(database.raw.prepare('SELECT total_changes() AS n').get()).toEqual(before);
    for (const table of ['prioritization_evaluations', 'prospect_priority_projection', 'discovery_assessments', 'sourcing_enrichment_requests']) {
      expect(database.raw.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
  });

  it('preserves real zero scores in detail and list after a canonical evaluation', async () => {
    const { prospect } = seedLead('real-zero');
    services.prioritization.recalculateProspect({ evaluationId: 'real-zero-evaluation', prospectId: prospect.prospectId,
      ruleVersionId, evaluatedAt: CLOCK_NOW, expectedProjectionVersion: null });
    expect(services.prioritizationRepository.getProjection(prospect.prospectId)).toMatchObject({
      fitPoints: 0, fitBand: 'low', timingMilliPoints: 0, timingBand: 'cold', priority: 'p3' });
    const before = database.raw.prepare('SELECT total_changes() AS n').get();
    const detail = await leadDetail.get({ personId: prospect.personId });
    const list = domain.listLeadRows({ query: '', stages: [], priorities: [], sort: 'priority', cursor: null, limit: 20 });
    for (const output of [detail, list.rows[0]]) {
      expect(output?.priorityContext).toMatchObject({ fitPoints: 0, fitBand: 'low', timingValue: 0, timingBand: 'cold', priority: 'P3' });
    }
    expect(detail.priorityReasons).toContain('Fit low 0/30');
    expect(detail.priorityReasons).toContain('Timing cold 0/40');
    expect(detail.findContactEligibility.eligible).toBe(false);
    expect(database.raw.prepare('SELECT total_changes() AS n').get()).toEqual(before);
  });

  it('returns the strict detail DTO for a seeded lead', async () => {
    const { prospect, cycleId } = seedLead('alpha');
    addPhone(prospect, 'alpha-phone');
    database.raw.prepare(`UPDATE person_contact_methods SET source_label = 'vendor-fixture',
      vendor_rank = 2, phone_kind = 'mobile', ownership_state = 'vendor_candidate',
      evidence_observed_at = '2026-08-30T12:00:00.000Z' WHERE id = 'alpha-phone'`).run();

    const detail = await leadDetail.get({ personId: prospect.personId });

    expect(() => leadDetailSchema.parse(detail)).not.toThrow();
    expect(detail.personId).toBe(prospect.personId);
    expect(detail.salesCycleId).toBe(cycleId);
    expect(detail.personName).toBe(`Person ${prospect.personId}`);
    expect(detail.stage).toBe('ready');
    expect(detail.workflowStatus).toBe('active');
    expect(detail.optedOut).toBe(false);
    expect(detail.phones).toHaveLength(1);
    expect(detail.outboundAttempts).toEqual([]);
    expect(detail.phones[0]).toEqual({
      contactSnapshot: contactSnapshot(database.raw.prepare(`SELECT id, person_id AS personId, kind,
        normalized_value AS normalizedValue, validation_state AS validationState, updated_at AS updatedAt
        FROM person_contact_methods WHERE id = 'alpha-phone'`).get() as Parameters<typeof contactSnapshot>[0]),
      id: 'alpha-phone',
      kind: 'phone',
      value: '+14015550100',
      label: null,
      valid: true,
      validationState: 'valid',
      reachability: 'direct',
      sourceLabel: 'vendor-fixture',
      vendorRank: 2,
      phoneKind: 'mobile',
      ownershipState: 'vendor_candidate',
      evidenceObservedAt: '2026-08-30T12:00:00.000Z',
      compliance: {
        status: 'verified_clear',
        label: 'Verified clear until Sep 15, 2026',
        expiresAt: '2026-09-15T00:00:00.000Z',
        callRefusalReason: null,
        textRefusalReason: null,
      },
    });
    expect(detail.emails).toEqual([]);
    expect(detail.nextAction).not.toBeNull();
    expect(detail.revision).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(detail)).not.toMatch(/leadScore|blended|combined/);
    expect(JSON.stringify(detail)).not.toMatch(/source_json|contact_hmac|evidence_ref|policy_version/i);
  });

  it('projects explicit refusal statuses without evidence or policy internals', async () => {
    const { prospect } = seedLead('blocked');
    addPhone(prospect, 'blocked-phone');
    database.raw.prepare(`UPDATE person_contact_methods SET federal_status = 'listed'
      WHERE id = 'blocked-phone'`).run();

    const detail = await leadDetail.get({ personId: prospect.personId });

    expect(detail.phones[0]?.compliance).toEqual({
      status: 'federal_dnc_listed',
      label: 'Federal DNC listed',
      expiresAt: null,
      callRefusalReason: 'federal_dnc_listed',
      textRefusalReason: 'federal_dnc_listed',
    });
    expect(Object.keys(detail.phones[0] ?? {})).toEqual([
      'id', 'contactSnapshot', 'kind', 'value', 'label', 'valid', 'validationState', 'reachability',
      'sourceLabel', 'vendorRank', 'phoneKind', 'ownershipState', 'evidenceObservedAt', 'compliance',
    ]);
  });

  it('maps legacy phone and email evidence conservatively without inventing ownership or rank', async () => {
    const { prospect } = seedLead('legacy');
    addPhone(prospect, 'legacy-phone');
    addEmail(prospect, 'legacy-email');
    const detail = await leadDetail.get({ personId: prospect.personId });
    for (const contact of [...detail.phones, ...detail.emails]) {
      expect(contact).toMatchObject({
        valid: true, validationState: 'valid', reachability: 'direct',
        sourceLabel: null, vendorRank: null, phoneKind: null,
        ownershipState: 'unknown', evidenceObservedAt: null,
      });
    }
    expect(detail.emails[0]?.compliance).toBeNull();
  });

  it.each([
    ['unverified', false, 'indirect', 'landline', 'unknown'],
    ['invalid', false, 'none', 'voip', 'conflicting_identity'],
    ['valid', true, 'direct', 'other', 'verified_person'],
  ] as const)('preserves %s validation separately from ownership and phone kind', async (validation, valid, reachability, kind, ownership) => {
    const { prospect } = seedLead('evidence');
    addPhone(prospect, 'evidence-phone');
    database.raw.prepare(`UPDATE person_contact_methods SET validation_state = ?,
      reachability = ?, phone_kind = ?, ownership_state = ? WHERE id = 'evidence-phone'`)
      .run(validation, reachability, kind, ownership);
    const detail = await leadDetail.get({ personId: prospect.personId });
    expect(detail.phones[0]).toMatchObject({
      validationState: validation, valid, reachability, phoneKind: kind, ownershipState: ownership,
    });
    if (!valid) {
      expect(detail.phones[0]?.compliance).toMatchObject({
        status: 'compliance_unknown', callRefusalReason: 'contact_validation_unusable',
        textRefusalReason: 'contact_validation_unusable',
      });
    }
  });

  it('orders mixed phone evidence deterministically instead of trusting legacy primary or phone order', async () => {
    const { prospect } = seedLead('mixed');
    addPhone(prospect, 'tcpa');
    database.raw.prepare(`UPDATE person_contact_methods SET normalized_value = '+14015550199',
      is_primary = 0, compliance_tcpa_flag = 1, ownership_state = 'verified_person'
      WHERE id = 'tcpa'`).run();
    const insert = database.raw.prepare(`INSERT INTO person_contact_methods (
      id, person_id, kind, normalized_value, validation_state, reachability, is_primary,
      federal_status, compliance_tcpa_flag, covered_area_code, compliance_source, scrubbed_at,
      compliance_expires_at, ownership_state, vendor_rank, created_at, updated_at
    ) VALUES (?, ?, 'phone', ?, ?, 'direct', ?, ?, 0, '401', 'ftc_download',
      '2026-08-15T00:00:00.000Z', '2026-09-15T00:00:00.000Z', ?, ?, ?, ?)`);
    for (const [id, value, validation, primary, federal, ownership, rank] of [
      ['listed-rank-one', '+14015550100', 'valid', 1, 'listed', 'vendor_candidate', 1],
      ['unknown-owner', '+14015550103', 'valid', 0, 'unknown', 'unknown', 2],
      ['clear-vendor-three', '+14015550130', 'valid', 0, 'verified_clear', 'vendor_candidate', 3],
      ['conflict-rank-one', '+14015550102', 'valid', 0, 'unknown', 'conflicting_identity', 1],
      ['unknown-vendor', '+14015550105', 'unverified', 0, 'verified_clear', 'vendor_candidate', 2],
      ['clear-verified', '+14015550190', 'valid', 0, 'verified_clear', 'verified_person', 4],
      ['unknown-verified', '+14015550110', 'valid', 0, 'unknown', 'verified_person', 5],
      ['clear-vendor-two', '+14015550120', 'valid', 0, 'verified_clear', 'vendor_candidate', 2],
    ] as const) {
      insert.run(id, prospect.personId, value, validation, primary, federal, ownership, rank,
        DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    }
    const before = database.raw.prepare('SELECT * FROM person_contact_methods ORDER BY id').all();
    const first = await leadDetail.get({ personId: prospect.personId });
    const second = await leadDetail.get({ personId: prospect.personId });
    expect(first.phones.map(({ id }) => id)).toEqual([
      'clear-verified', 'clear-vendor-two', 'clear-vendor-three', 'unknown-verified',
      'unknown-vendor', 'unknown-owner', 'conflict-rank-one', 'tcpa', 'listed-rank-one',
    ]);
    expect(second.phones).toEqual(first.phones);
    expect(first.phones.slice(-2).map(({ compliance }) => compliance?.status))
      .toEqual(['tcpa_blocked', 'federal_dnc_listed']);
    expect(first.phones.every((phone) => contactMethodSchema.safeParse(phone).success)).toBe(true);
    expect(database.raw.prepare('SELECT * FROM person_contact_methods ORDER BY id').all()).toEqual(before);
  });

  it('fails closed for otherwise-unmapped refusal reasons', async () => {
    const { prospect } = seedLead('invalid');
    addPhone(prospect, 'invalid-phone');
    database.raw.prepare(`UPDATE person_contact_methods SET validation_state = 'invalid'
      WHERE id = 'invalid-phone'`).run();

    const compliance = (await leadDetail.get({ personId: prospect.personId }))
      .phones[0]?.compliance;

    expect(compliance).toMatchObject({
      status: 'compliance_unknown',
      callRefusalReason: 'contact_validation_unusable',
      textRefusalReason: 'contact_validation_unusable',
    });
    expect(compliance?.label).toBe('Compliance unknown');
    expect(compliance?.expiresAt).toBeNull();
  });

  it('gives state clearance priority over a simultaneous recipient-window refusal', async () => {
    const { prospect } = seedLead('precedence');
    addPhone(prospect, 'precedence-phone');
    database.raw.prepare(`UPDATE person_outbound_jurisdictions
      SET timezone = 'Pacific/Honolulu' WHERE person_id = ?`).run(prospect.personId);
    database.raw.prepare(`UPDATE outbound_jurisdiction_clearances
      SET registration_confirmed = 0 WHERE region_code = 'RI' AND channel = 'call'`).run();

    const compliance = (await leadDetail.get({ personId: prospect.personId }))
      .phones[0]?.compliance;

    expect(compliance).toEqual({
      status: 'state_clearance_required',
      label: 'State clearance required',
      expiresAt: null,
      callRefusalReason: 'state_registration_missing',
      textRefusalReason: 'outside_recipient_window',
    });
  });

  it('rejects an unknown person', async () => {
    await expect(
      leadDetail.get({ personId: 'missing-person' }),
    ).rejects.toThrow();
  });

  function requestFor(prefix = 'outbound'): OutboundRequest {
    const { prospect, cycleId } = seedLead(prefix);
    addPhone(prospect, `${prefix}-phone`);
    return { commandId: randomUUID(), channel: 'call', personId: prospect.personId,
      salesCycleId: cycleId, contactMethodId: `${prefix}-phone`,
      expectedContactSnapshot: domain.getLeadDetail({ personId: prospect.personId }).phones[0].contactSnapshot };
  }

  // The begin-outbound IPC channel is gone; the legacy provider is exercised directly, so the
  // strict request parse and receipt validation under test are the outbound service's own.
  function normalRoute(beforeReady: () => void = () => undefined, injected = true) {
    const gate: Parameters<typeof createLeadDetailProvider>[0] = {
      withDomain: async (operation) => operation(domain),
    };
    const dispatch = vi.fn(async () => ({ status: 'handoff_accepted' as const, reasonCode: null }));
    const outbound = createOutboundCommandService({ domain: gate,
      phone: { inspectCapability: async () => ({ state: 'available', reasonCode: null }), dispatch },
      readiness: { getCapability: () => ({ state: 'available', reasonCode: null }),
        check: async (personId) => { beforeReady(); return readyReply(personId); }, assertCurrent: assertCurrentReadiness },
    });
    const provider = createLeadDetailProvider(gate, undefined, injected ? outbound : undefined);
    return { dispatch, provider, outbound, today: createTodayProvider(gate),
      invoke: (request: unknown) => provider.beginOutbound(request as OutboundRequest) };
  }

  function expectNoCommunication() {
    expect(database.raw.prepare("SELECT COUNT(*) AS n FROM activities WHERE kind IN ('call','text','email') AND direction = 'outbound'").get()).toEqual({ n: 0 });
  }

  it('normal provider accepts one handoff with durable facts and no phantom touch', async () => {
    const request = requestFor();
    const before = domain.getLeadDetail({ personId: request.personId });
    const route = normalRoute();
    const receipt = await route.invoke(request);
    expect(receipt).toMatchObject({ commandId: request.commandId, channel: 'call', status: 'handoff_accepted', reasonCode: null });
    expect(route.dispatch).toHaveBeenCalledTimes(1);
    expect(route.dispatch).toHaveBeenCalledWith('+14015550100');
    expectNoCommunication();
    const after = domain.getLeadDetail({ personId: request.personId });
    expect(after.outboundAttempts).toEqual([expect.objectContaining({ commandId: request.commandId, status: 'handoff_accepted', manualActivityId: null })]);
    expect(after.activities).toEqual(before.activities);
    expect(after.nextAction).toEqual(before.nextAction);
    expect(after.stage).toBe(before.stage);
    expect(database.raw.prepare("SELECT COUNT(*) AS n FROM activities WHERE channel = 'outbound_command'").get()).toEqual({ n: 3 });
    await expect(route.invoke(request)).resolves.toEqual(receipt);
    expect(route.dispatch).toHaveBeenCalledTimes(1);
    await expect(route.invoke({ ...request, expectedContactSnapshot: 'b'.repeat(64) })).rejects.toThrow('conflicts');
    route.outbound.dispose();
  });

  it('preserves direct service factory enrichment position and delegates its third outbound service', async () => {
    const request = requestFor();
    const route = normalRoute();
    const enrichment = { request: vi.fn(async () => ({ written: false, refusalReason: 'rate_limited' as const })) };
    const provider = createLeadDetailProvider(productionDomainGate(domain), enrichment, route.outbound);
    await expect(provider.beginOutbound(request)).resolves.toMatchObject({ status: 'handoff_accepted' });
    expect((await provider.getOutboundCapabilities()).phoneHandoff.state).toBe('available');
    await expect(provider.findContactInfo({ personId: request.personId })).resolves.toEqual({ written: false, refusalReason: 'rate_limited' });
    expect(enrichment.request).toHaveBeenCalledWith({ personId: request.personId });
    expect(route.dispatch).toHaveBeenCalledTimes(1); expectNoCommunication();
  });

  it('strict outbound service rejects forged target/body and missing identity before dispatch', async () => {
    const request = requestFor();
    const route = normalRoute();
    for (const field of ['target', 'body', 'url', 'observedOutcome']) {
      await expect(route.invoke({ ...request, [field]: 'forged' })).rejects.toThrow();
    }
    for (const field of ['commandId', 'expectedContactSnapshot']) {
      const invalid: Record<string, unknown> = { ...request }; delete invalid[field];
      await expect(route.invoke(invalid)).rejects.toThrow();
    }
    expect(route.dispatch).not.toHaveBeenCalled();
    expect(database.raw.prepare('SELECT COUNT(*) AS n FROM activities').get()).toEqual({ n: 0 });
  });

  it.each(['federal_status', 'validation_state', 'normalized_value'] as const)('rechecks changed %s at final authority after readiness', async (field) => {
    const request = requestFor();
    const route = normalRoute(() => {
      if (field === 'federal_status') database.raw.prepare("UPDATE person_contact_methods SET federal_status = 'listed'").run();
      if (field === 'validation_state') database.raw.prepare("UPDATE person_contact_methods SET validation_state = 'invalid'").run();
      if (field === 'normalized_value') database.raw.prepare("UPDATE person_contact_methods SET normalized_value = '+14015550101'").run();
    });
    await expect(route.invoke(request)).resolves.toMatchObject({ status: 'refused', reasonCode: field === 'federal_status' ? 'federal_dnc_listed' : 'stale_contact' });
    expect(route.dispatch).not.toHaveBeenCalled(); expectNoCommunication();
  });

  it('rejects another persons contact before creating any command facts', async () => {
    const request = requestFor();
    const other = requestFor('other');
    const route = normalRoute();
    await expect(route.invoke({ ...request, contactMethodId: other.contactMethodId })).rejects.toMatchObject({ code: 'CONTACT_METHOD_NOT_FOUND' });
    expect(route.dispatch).not.toHaveBeenCalled();
    expect(database.raw.prepare('SELECT COUNT(*) AS n FROM activities').get()).toEqual({ n: 0 });
  });

  it('checks current permission inside its write scope immediately before fake dispatch', async () => {
    const request = requestFor();
    const order: string[] = [];
    const original = services.outboundPermission.assertMayExecuteOutbound.bind(services.outboundPermission);
    vi.spyOn(services.outboundPermission, 'assertMayExecuteOutbound').mockImplementation((input) => {
      services.unitOfWork.assertWriteScope(); original(input); order.push('authorize');
    });
    const route = normalRoute();
    route.dispatch.mockImplementation(async () => { order.push('dispatch'); return { status: 'handoff_accepted', reasonCode: null }; });
    await route.invoke(request);
    expect(order).toEqual(['authorize', 'dispatch']); expectNoCommunication();
  });

  it('rolls back command preparation and never dispatches when the durable write fails', async () => {
    const request = requestFor();
    const append = services.events.appendActivity.bind(services.events);
    vi.spyOn(services.events, 'appendActivity').mockImplementation((input) => { append(input); throw new Error('fault after append'); });
    const route = normalRoute();
    await expect(route.invoke(request)).rejects.toThrow('fault after append');
    expect(route.dispatch).not.toHaveBeenCalled();
    expect(database.raw.prepare('SELECT COUNT(*) AS n FROM activities').get()).toEqual({ n: 0 });
  });

  it('applies a real opt-out during readiness and never dispatches from stale allowed detail', async () => {
    const request = requestFor();
    const route = normalRoute(() => { domain.logCallOutcome({ personId: request.personId, salesCycleId: request.salesCycleId,
      outcome: 'opted_out', occurredAt: CLOCK_NOW, callbackAt: null }); });
    await expect(route.invoke(request)).resolves.toMatchObject({ status: 'refused', reasonCode: 'cycle_not_executable' });
    expect(route.dispatch).not.toHaveBeenCalled();
    expect(domain.getLeadDetail({ personId: request.personId }).optedOut).toBe(true);
    expect(database.raw.prepare("SELECT COUNT(*) AS n FROM activities WHERE channel = 'outbound_command' AND kind <> 'system'").get()).toEqual({ n: 0 });
  });

  it.each(['call', 'text', 'email'] as const)('absent service persists unavailable %s and never launches', async (channel) => {
    const request = requestFor();
    if (channel === 'email') { addEmail({ personId: request.personId } as SeededProspect, 'email'); }
    const route = normalRoute(undefined, false);
    const input = channel === 'email' ? { ...request, channel, contactMethodId: 'email', expectedContactSnapshot: domain.getLeadDetail({ personId: request.personId }).emails[0].contactSnapshot } : { ...request, channel };
    const capabilities = await route.provider.getOutboundCapabilities();
    expect(capabilities.phoneHandoff).toEqual({ state: 'unavailable', reasonCode: 'phone_route_unverified' });
    expect(capabilities.localDrafts).toBe(true);
    const receipt = await route.invoke(input);
    expect(receipt).toMatchObject({ status: 'unavailable', reasonCode: channel === 'call' ? 'phone_route_unverified' : 'channel_unavailable' });
    expect(domain.inspectOutboundCommand(input)).toEqual(receipt);
    expect(route.dispatch).not.toHaveBeenCalled(); expectNoCommunication();
    const direct = createLeadDetailProvider(productionDomainGate(domain));
    await expect(direct.beginOutbound(input)).resolves.toEqual(receipt);
  });

  it.each(['text', 'email'] as const)('injected normal %s request is unavailable, never a Phone launch', async (channel) => {
    const request = requestFor();
    const route = normalRoute();
    await expect(route.invoke({ ...request, channel })).resolves.toMatchObject({ status: 'unavailable', reasonCode: 'channel_unavailable' });
    expect(route.dispatch).not.toHaveBeenCalled(); expectNoCommunication();
  });

  it.each(['same', 'old'] as const)('recovered %s-cycle command association uses authoritative normal manual provider', async (cycle) => {
    const request = requestFor();
    domain.prepareOutboundDispatch(request); // Durable unresolved intent, no dispatched result.
    if (cycle === 'old') {
      domain.dismissLead({ personId: request.personId, salesCycleId: request.salesCycleId,
        qualificationGateReason: 'out_of_area', expectedRevision: domain.getLeadDetail({ personId: request.personId }).revision });
      const prospect = { personId: request.personId, prospectId: 'outbound-prospect', sourceEventId: 'outbound-source' };
      insertOpenCycleWithAction({ database: database.raw, prefix: 'replacement', prospect });
    }
    const route = normalRoute();
    const detail = await route.provider.get({ personId: request.personId });
    expect(detail.outboundAttempts[0]).toMatchObject({ commandId: request.commandId, status: 'unknown', manualActivityId: null });
    const input = { personId: detail.personId, salesCycleId: detail.salesCycleId, outboundCommandId: request.commandId,
      outcome: 'no_answer' as const, occurredAt: CLOCK_NOW, callbackAt: null as string | null };
    const before = database.raw.prepare('SELECT total_changes() AS n').get();
    if (cycle === 'old') {
      expect(detail.salesCycleId).not.toBe(request.salesCycleId);
      await expect(route.today.logCallOutcome(input)).rejects.toMatchObject({ code: 'ACTION_NOT_SUPPORTED' });
      expect(database.raw.prepare('SELECT total_changes() AS n').get()).toEqual(before);
      expectNoCommunication();
    } else {
      await route.today.logCallOutcome(input);
      const saved = database.raw.prepare('SELECT total_changes() AS n').get();
      await route.today.logCallOutcome(input);
      expect(database.raw.prepare('SELECT total_changes() AS n').get()).toEqual(saved);
      expect((await route.provider.get({ personId: request.personId })).outboundAttempts[0]).toMatchObject({ status: 'unknown', manualActivityId: expect.any(String) });
      expect(database.raw.prepare("SELECT COUNT(*) AS n FROM activities WHERE adapter = 'callie_manual_outbound_v1'").get()).toEqual({ n: 1 });
    }
    expect(route.dispatch).not.toHaveBeenCalled();
  });

  it('confirms review_to_ready through the guarded transition', async () => {
    const prospect = seedProspect(database.raw, 'alpha');
    database.raw.prepare(`
      UPDATE prospects SET qualification_state = 'unreviewed' WHERE id = ?
    `).run(prospect.prospectId);
    const cycle = services.lifecycle.createUnreviewedCycle({
      personId: prospect.personId,
      prospectId: prospect.prospectId,
      entrySourceEventId: prospect.sourceEventId,
      effectiveAt: DOMAIN_TIMESTAMP,
    });

    const receipt = await leadDetail.confirmTransition({
      transition: 'review_to_ready',
      salesCycleId: cycle.id,
      expectedRevision: 0,
    });

    expect(receipt.affectedSalesCycleIds).toEqual([cycle.id]);
    const detail = await leadDetail.get({ personId: prospect.personId });
    expect(detail.stage).toBe('ready');
    expect(detail.history.length).toBeGreaterThan(0);
  });

  it('dismisses an unreviewed lead through the disqualification path', async () => {
    const prospect = seedProspect(database.raw, 'alpha');
    database.raw.prepare(`
      UPDATE prospects SET qualification_state = 'unreviewed' WHERE id = ?
    `).run(prospect.prospectId);
    const cycle = services.lifecycle.createUnreviewedCycle({
      personId: prospect.personId,
      prospectId: prospect.prospectId,
      entrySourceEventId: prospect.sourceEventId,
      effectiveAt: DOMAIN_TIMESTAMP,
    });

    const receipt = await leadDetail.dismissLead({
      salesCycleId: cycle.id,
      personId: prospect.personId,
      qualificationGateReason: 'out_of_area',
      expectedRevision: 0,
    });

    expect(receipt.affectedPersonIds).toEqual([prospect.personId]);
    expect(receipt.affectedSalesCycleIds).toEqual([cycle.id]);
    // The prospect is disqualified with the exact gate reason.
    expect(database.raw.prepare(`
      SELECT qualification_state, qualification_gate_reason
      FROM prospects WHERE id = ?
    `).get(prospect.prospectId)).toEqual({
      qualification_state: 'disqualified',
      qualification_gate_reason: 'out_of_area',
    });
    // The cycle closes into Lost-Nurture and leaves the actionable list.
    expect(database.raw.prepare(`
      SELECT stage, workflow_status, current_next_action_id, close_reason
      FROM sales_cycles WHERE id = ?
    `).get(cycle.id)).toEqual({
      stage: 'lost_nurture',
      workflow_status: 'closed',
      current_next_action_id: null,
      close_reason: 'disqualified',
    });
  });

  it('rejects a dismissal whose person does not own the cycle', async () => {
    const prospect = seedProspect(database.raw, 'alpha');
    database.raw.prepare(`
      UPDATE prospects SET qualification_state = 'unreviewed' WHERE id = ?
    `).run(prospect.prospectId);
    const cycle = services.lifecycle.createUnreviewedCycle({
      personId: prospect.personId,
      prospectId: prospect.prospectId,
      entrySourceEventId: prospect.sourceEventId,
      effectiveAt: DOMAIN_TIMESTAMP,
    });

    await expect(
      leadDetail.dismissLead({
        salesCycleId: cycle.id,
        personId: 'someone-else',
        qualificationGateReason: 'out_of_area',
        expectedRevision: 0,
      }),
    ).rejects.toThrow();
    expect(database.raw.prepare(
      'SELECT qualification_state FROM prospects WHERE id = ?',
    ).get(prospect.prospectId)).toEqual({ qualification_state: 'unreviewed' });
  });
});

describe('strict contact presentation DTO', () => {
  const evidence = {
    validationState: 'unverified', reachability: 'indirect', sourceLabel: 'vendor-fixture',
    vendorRank: 1, phoneKind: 'mobile', ownershipState: 'vendor_candidate',
    evidenceObservedAt: '2026-08-30T12:00:00.000Z',
  } as const;
  const contact: ContactMethod = {
    contactSnapshot: 'a'.repeat(64),
    id: 'candidate', kind: 'phone', value: '+14015550100', label: null, valid: false,
    ...evidence,
    compliance: {
      status: 'state_clearance_required', label: 'State clearance required', expiresAt: null,
      callRefusalReason: 'state_registration_missing', textRefusalReason: null,
    },
  };

  it('accepts the expanded evidence while preserving independent channel refusals', () => {
    expect(contactMethodSchema.parse(contact)).toEqual(contact);
  });

  it.each(Object.keys(evidence))('requires explicit %s rather than silently defaulting evidence', (field) => {
    const missing: Record<string, unknown> = { ...contact };
    delete missing[field];
    expect(contactMethodSchema.safeParse(missing).success).toBe(false);
  });

  it.each([
    ['validationState', 'verified'], ['reachability', 'reachable'], ['sourceLabel', ''],
    ['vendorRank', 0], ['vendorRank', -1], ['vendorRank', 1.5], ['vendorRank', '1'],
    ['phoneKind', 'cell'], ['ownershipState', 'matched_owner'], ['evidenceObservedAt', 'yesterday'],
    ['evidenceObservedAt', '2026-08-30T12:00:00'],
  ])('rejects invalid %s evidence %s', (field, value) => {
    expect(contactMethodSchema.safeParse({ ...contact, [field]: value }).success).toBe(false);
  });

  it.each(['mayCall', 'mayText', 'authorized', 'isPrimary', 'leadScore', 'blendedScore'])('rejects reusable authorization or unapproved field %s', (field) => {
    expect(contactMethodSchema.safeParse({ ...contact, [field]: true }).success).toBe(false);
    expect(contactMethodSchema.safeParse({
      ...contact, compliance: { ...contact.compliance, [field]: true },
    }).success).toBe(false);
  });
});
