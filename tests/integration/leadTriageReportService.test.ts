import { contactSnapshot } from '../../src/main/communications/contactSnapshot';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { BUILTIN_PRIORITIZATION_RULE_V1 } from '../../src/main/domain/prioritization/builtinPrioritizationRules';
import type { LeadTriageSnapshot, LeadTriageAssessment } from '../../src/shared/contracts/leadTriageReportContract';
import { createTodayProvider as createGatedTodayProvider } from '../../src/main/ipc/registerApplicationIpc';
import { createDomainServices, type DomainServices } from '../../src/main/domain/createDomainServices';
import { createFounderSalesDomain, type FounderSalesDomain } from '../../src/main/domain/founderSalesDomain';
import { createTodayProvider } from '../../src/main/today/todayService';
import { insertClosedCycle, insertOpenCycleWithAction, seedProspect } from '../fixtures/domainRows';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from '../fixtures/tempDatabase';

const NOW = '2026-08-31T15:00:00.000Z';
describe('read-only lead triage snapshot over an intact encrypted domain', () => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let domain: FounderSalesDomain;
  let services: DomainServices;
  let counter = 0;
  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    await migrateToLatest(database, { backupDirectory: `${temp.path}.backups`, workspaceKey: key });
    const clock = { now: () => NOW };
    const ids = { next: () => `generated-${++counter}` };
    services = createDomainServices({ database, clock, ids });
    domain = createFounderSalesDomain({ database, services, clock, ids });
    for (let i = 34; i >= 0; i--) {
      const prefix = `q${String(i).padStart(2, '0')}`;
      const prospect = seedProspect(database.raw, prefix);
      insertOpenCycleWithAction({ database: database.raw, prefix, prospect, stage: 'unreviewed' });
      if (i < 2) insertClosedCycle({ database: database.raw, prefix: `${prefix}-history`, prospect });
    }
    seedEvidence();
  });
  afterEach(() => { vi.restoreAllMocks(); closeDatabase(database); temp.cleanup(); });

  it('returns the first 30 distinct people in the exact existing queue order without advancing revision', async () => {
    const queue = domain.getTriageQueue();
    const provider = createTodayProvider(domain);
    expect(queue.items).toHaveLength(35);
    expect(queue.items.map((row) => row.salesCycleId)).toEqual(Array.from({ length: 35 }, (_, i) => `q${String(i).padStart(2, '0')}-cycle`));
    expect(provider.getLeadTriageSnapshot).toBeTypeOf('function');
    const snapshot = await provider.getLeadTriageSnapshot({ limit: 30 });
    expect(snapshot.leads.map(({ personId, salesCycleId }) => ({ personId, salesCycleId })))
      .toEqual(queue.items.slice(0, 30).map(({ personId, salesCycleId }) => ({ personId, salesCycleId })));
    expect(snapshot.scannedQueueRows).toBe(30);
    expect(snapshot.revisionBefore).toBe(queue.revision);
    expect(snapshot.revisionAfter).toBe(queue.revision);
    expect(snapshot.privacyScanPassed).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('contactSnapshot');
    for (const contact of services.identities.listContactMethodsForPerson('q00-person')) {
      expect(JSON.stringify(snapshot)).not.toContain(contactSnapshot(contact));
    }
  });

  function tableBytes() {
    const tables = database.raw.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
    return Object.fromEntries(tables.map(({ name }) => {
      const rows = database.raw.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all().map((row) => JSON.stringify(row)).sort();
      return [name, { count: rows.length, bytes: JSON.stringify(rows) }];
    }));
  }

  function seedEvidence() {
    const raw = database.raw;
    const rule = services.unitOfWork.immediate(() => services.prioritizationRepository.installRuleVersion(BUILTIN_PRIORITIZATION_RULE_V1));
    for (const [i, points, band, timing, timingBand] of [
      [0, 5, 'low', 1000, 'cold'], [1, 15, 'medium', 12000, 'warm'], [2, 25, 'high', 30000, 'hot'],
      [6, 25, 'high', 7999, 'cold'], [7, 25, 'high', 8000, 'warm'],
      [8, 25, 'high', 19999, 'warm'], [9, 25, 'high', 20000, 'hot'], [10, 25, 'high', 40000, 'hot'],
    ] as const) {
      const prospectId = `q${String(i).padStart(2, '0')}-prospect`;
      raw.prepare(`INSERT INTO prioritization_evaluations (
        id, prospect_id, rule_version_id, decision_kind, evaluated_at, fit_points, fit_band,
        timing_millipoints, timing_band, reachability, data_confidence, priority,
        earliest_trigger_expires_at, verify_first, command_json, input_snapshot_json,
        result_json, explanation_json, created_at
      ) VALUES (?, ?, ?, 'evaluated', ?, ?, ?, ?, ?, 'direct', 8, 'p3', NULL, 0, '{}', '{}', '{}', '[]', ?)`)
        .run(`eval-${i}`, prospectId, rule.id, NOW, points, band, timing, timingBand, NOW);
      raw.prepare(`INSERT INTO prospect_priority_projection (
        prospect_id, rule_version_id, evaluation_id, fit_points, fit_band, timing_millipoints,
        timing_band, reachability, data_confidence, priority, earliest_trigger_expires_at,
        verify_first, version, evaluated_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'direct', 8, 'p3', NULL, 0, 1, ?, ?)`)
        .run(prospectId, rule.id, `eval-${i}`, points, band, timing, timingBand, NOW, NOW);
    }
    services.unitOfWork.immediate(() => {
      const organization = services.identities.createOrganization({ canonicalName: 'Harbor Holdings' });
      services.identities.linkOrganization({ prospectId: 'q00-prospect', organizationId: organization.id, relationship: 'property_owner' });
      const property = services.identities.createProperty({ organizationId: organization.id, addressLine1: '123 Hope St', locality: 'Providence', region: 'RI', postalCode: '02906' });
      services.identities.linkProperty({ prospectId: 'q00-prospect', propertyId: property.id, relationship: 'owner' });
      const unknown = services.identities.createOrganization({ canonicalName: 'Unresolved Company' });
      services.identities.linkOrganization({ prospectId: 'q01-prospect', organizationId: unknown.id, relationship: 'owner@example.com' });
    });
    raw.prepare(`UPDATE prospects SET cloud_fit = 90, cloud_timing = 3, cloud_score_reasons_json = ? WHERE id = 'q00-prospect'`)
      .run(JSON.stringify([{ signal: 'assessment', contribution: 5 }, { signal: 'owner@example.com +14015550100', contribution: 2 }]));
    raw.prepare(`UPDATE prospects SET cloud_fit = 99, cloud_timing = 99 WHERE id = 'q04-prospect'`).run();
    raw.prepare(`UPDATE prospects SET qualification_state = 'merge_review' WHERE id = 'q03-prospect'`).run();
    for (const [id, type, expiry] of [
      ['t1', 'assessment_change', '2026-09-30T00:00:00.000Z'],
      ['t2', 'permit_filed', '2026-08-01T00:00:00.000Z'],
      ['t3', 'private@example.com', null],
    ]) {
      raw.prepare(`INSERT INTO source_events (id, person_id, channel, observed_at, source_record_json, created_at) VALUES (?, 'q00-person', ?, '2026-07-01T00:00:00.000Z', ?, ?)`).run(`${id}-source`, type === 'permit_filed' ? 'permit' : 'custom', JSON.stringify({ prioritizationTrigger: { version: 1, signal: type } }), NOW);
      raw.prepare(`INSERT INTO trigger_events (id, prospect_id, source_event_id, trigger_type, effective_at, expires_at, strength_multiplier, verification_state, evidence_json, created_at) VALUES (?, 'q00-prospect', ?, ?, '2026-07-01T00:00:00.000Z', ?, 1, 'verified', '{"messageBody":"secret"}', ?)`).run(id, `${id}-source`, type, expiry, NOW);
    }
    for (const [id, person, number, federal, ownership, rank, validation] of [
      ['phone-clear', 'q00-person', '+14015550100', 'verified_clear', 'verified_person', 2, 'valid'],
      ['phone-candidate', 'q00-person', '+14015550101', 'unknown', 'vendor_candidate', 1, 'valid'],
      ['phone-block', 'q01-person', '+14015550102', 'listed', 'verified_person', 1, 'valid'],
      ['phone-conflict', 'q03-person', '+14015550103', 'unknown', 'conflicting_identity', 1, 'invalid'],
    ]) raw.prepare(`INSERT INTO person_contact_methods (id, person_id, kind, normalized_value, validation_state, reachability, ownership_state, vendor_rank, source_label, federal_status, compliance_tcpa_flag, covered_area_code, compliance_source, scrubbed_at, compliance_expires_at, created_at, updated_at) VALUES (?, ?, 'phone', ?, ?, 'direct', ?, ?, 'private@example.com', ?, 0, '401', 'ftc_download', '2026-08-15T00:00:00.000Z', '2026-09-15T00:00:00.000Z', ?, ?)`)
      .run(id, person, number, validation, ownership, rank, federal, NOW, NOW);
    raw.prepare(`INSERT INTO person_contact_methods (id, person_id, kind, normalized_value, validation_state, reachability, ownership_state, created_at, updated_at) VALUES ('email', 'q02-person', 'email', 'owner@example.com', 'valid', 'direct', 'verified_person', ?, ?)`).run(NOW, NOW);
    raw.prepare(`INSERT INTO person_outbound_jurisdictions (person_id, region_code, timezone, source, effective_at, updated_at) VALUES ('q00-person', 'RI', 'America/New_York', 'manual_review', ?, ?)`).run(NOW, NOW);
    for (const channel of ['call', 'text']) raw.prepare(`INSERT OR REPLACE INTO outbound_jurisdiction_clearances (region_code, channel, decision, registration_confirmed, state_dnc_subscription_confirmed, consent_rule_confirmed, source, effective_at, expires_at, updated_at) VALUES ('RI', ?, 'allowed', 1, 1, 1, 'test', '2026-08-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', ?)`).run(channel, NOW);
    raw.prepare(`INSERT INTO cloud_entity_links (cloud_entity_id, person_id, linked_at) VALUES ('fixture-entity', 'q00-person', ?)`).run(NOW);
    raw.prepare(`INSERT INTO sourcing_enrichment_requests (cloud_entity_id, last_requested_at) VALUES ('fixture-entity', ?)`).run(NOW);
    raw.prepare(`INSERT INTO sourcing_outcome_outbox (id, cloud_entity_id, label, observed_at) VALUES ('outcome', 'fixture-entity', 'won', ?)`).run(NOW);
    domain.setReviewPosition({ position: 7 });
    for (const [prefix, stage] of [['excluded-ready', 'ready'], ['excluded-future', 'unreviewed'], ['excluded-deleted', 'unreviewed']] as const) {
      const prospect = seedProspect(raw, prefix);
      insertOpenCycleWithAction({ database: raw, prefix, prospect, stage });
    }
    raw.prepare("UPDATE sales_cycles SET resurface_at = '2027-01-01T00:00:00.000Z', resurface_reason = 'snooze' WHERE id = 'excluded-future-cycle'").run();
    raw.prepare("UPDATE persons SET deleted_at = ? WHERE id = 'excluded-deleted-person'").run(NOW);
    const suppressed = seedProspect(raw, 'excluded-optout');
    insertClosedCycle({ database: raw, prefix: 'excluded-optout', prospect: suppressed });
    for (const person of ['excluded-optout-person']) {
      raw.prepare(`INSERT INTO activities (id, person_id, kind, direction, channel, occurred_at, observed_outcome, metadata_json, created_at) VALUES (?, ?, 'note', 'internal', 'manual', ?, 'opted_out', '{}', ?)`).run(`${person}-note`, person, NOW, NOW);
      raw.prepare(`INSERT INTO opt_out_tombstones (id, person_id, requested_at, observed_channel, source_activity_id, policy_version, created_at) VALUES (?, ?, ?, 'manual', ?, 'founder_opt_out_v1', ?)`).run(`${person}-tombstone`, person, NOW, `${person}-note`, NOW);
    }
    raw.prepare(`UPDATE persons SET opted_out = 1, opted_out_at = ? WHERE id = 'excluded-optout-person'`).run(NOW);
    raw.prepare(`INSERT INTO opt_out_handles (id, tombstone_id, kind, normalized_value, created_at) VALUES ('suppressed-handle', 'excluded-optout-person-tombstone', 'email', 'suppressed@example.com', ?)`).run(NOW);
    raw.prepare(`INSERT INTO person_contact_methods (id, person_id, kind, normalized_value, validation_state, reachability, created_at, updated_at) VALUES ('suppressed-email', 'q05-person', 'email', 'suppressed@example.com', 'unverified', 'none', ?, ?)`).run(NOW, NOW);
    raw.prepare(`INSERT INTO sourcing_suppression_outbox (handle_id) VALUES ('suppressed-handle')`).run();

  }

  function snapshot(limit = 30) {
    expect(domain.getLeadTriageSnapshot).toBeTypeOf('function');
    return domain.getLeadTriageSnapshot({ limit });
  }

  it('issues SELECTs only and preserves the bytes/counts of every table through both Today delegates', async () => {
    const before = tableBytes();
    for (const table of ['persons', 'prospects', 'sales_cycles', 'next_actions', 'activities', 'review_position', 'sourcing_enrichment_requests', 'sourcing_outcome_outbox', 'sourcing_suppression_outbox']) expect(before).toHaveProperty(table);
    expect(readFileSync(temp.path).subarray(0, 16).toString()).not.toBe('SQLite format 3\0');
    const revision = domain.getTriageQueue().revision;
    const prepare = database.raw.prepare.bind(database.raw);
    const statements: string[] = [];
    const prepareSpy = vi.spyOn(database.raw, 'prepare').mockImplementation((sql) => {
      statements.push(sql);
      expect(sql.trim()).toMatch(/^SELECT\b/i);
      return prepare(sql);
    });
    const writes = [vi.spyOn(database.raw, 'exec'), vi.spyOn(database.raw, 'pragma'), vi.spyOn(services.unitOfWork, 'immediate'), vi.spyOn(domain, 'getTriageQueue')];
    for (const spy of writes) spy.mockImplementation(() => { throw new Error('Not a SELECT-only read'); });
    let result: LeadTriageSnapshot;
    try {
      result = snapshot(20);
      const gate = { withDomain: async <T>(operation: (domain: FounderSalesDomain) => T | Promise<T>): Promise<T> => operation(domain), getHealth: vi.fn() };
      expect(await createGatedTodayProvider(gate).getLeadTriageSnapshot({ limit: 20 })).toEqual(result);
      expect(await createTodayProvider(domain).getLeadTriageSnapshot({ limit: 20 })).toEqual(result);
      expect(statements.length).toBeGreaterThan(20);
      const queueSelect = statements.find((sql) => sql.includes('cycle.prospect_id, person.display_name'));
      expect(queueSelect).toBeDefined();
      expect(queueSelect).not.toMatch(/\bLIMIT\b/i);
    } finally { prepareSpy.mockRestore(); writes.forEach((spy) => spy.mockRestore()); }
    expect(result!.leads).toHaveLength(20);
    expect(result!.revisionBefore).toBe(revision);
    expect(result!.revisionAfter).toBe(revision);
    expect(tableBytes()).toEqual(before);
  });

  it('keeps persisted Fit/Timing independent and maps only reviewed evidence, never narratives', () => {
    const result = snapshot();
    expect(result.leads.slice(0, 3).map((lead) => [lead.fit.points, lead.fit.band, lead.timing.value, lead.timing.band]))
      .toEqual([[5, 'low', 1, 'cold'], [15, 'medium', 12, 'warm'], [25, 'high', 30, 'hot']]);
    const first = result.leads[0]!;
    expect(first).toMatchObject({ locality: 'Providence', region: 'RI', postalCode: '02906', reachability: 'direct', dataConfidence: 8,
      organization: { label: 'Harbor Holdings', relationship: 'property_owner', evidenceCodes: ['organization_property_match'] },
      contacts: { phoneCount: 2, emailCount: 0, usableDirectCount: 1, maskedPrimaryPhone: '••• ••• 0101' },
      compliance: { status: 'mixed', refusalReasonCodes: ['federal_status_unknown'] } });
    expect(first.timing.triggers).toEqual([
      { code: 'assessment_change', observedAt: '2026-07-01T00:00:00.000Z', expiresAt: '2026-09-30T00:00:00.000Z' },
      { code: 'permit_activity', observedAt: '2026-07-01T00:00:00.000Z', expiresAt: '2026-08-01T00:00:00.000Z' },
      { code: 'other_sanitized', observedAt: '2026-07-01T00:00:00.000Z', expiresAt: null },
    ]);
    expect(first.cloud.contributions).toEqual([{ signalCode: 'assessment', contribution: 5 }, { signalCode: 'other_sanitized', contribution: 2 }]);
    expect(first.contacts.evidenceCodes).toContain('enrichment_rate_limited');
    expect(result.leads[1]).toMatchObject({ organization: { relationship: 'unknown' }, compliance: { status: 'blocked', refusalReasonCodes: ['federal_dnc_listed'] }, contacts: { maskedPrimaryPhone: null } });
    expect(result.leads[2]).toMatchObject({ contacts: { emailCount: 1, usableDirectCount: 1 }, compliance: { status: 'unknown' } });
    expect(result.leads[3]!.identityConcernCodes).toContain('identity_collision');
    expect(result.leads[3]!.contacts.evidenceCodes).toContain('contact_validation_invalid');
    expect(result.leads[4]).toMatchObject({ fit: { points: null, band: null, evidenceCodes: ['fit_evidence_missing'] }, timing: { value: null, band: null }, cloud: { fit: 99, timing: 99 }, reachability: null, dataConfidence: null });
    expect(JSON.stringify(result)).not.toMatch(/@|1401555|123 Hope|messageBody|sourceLabel|secret/);
    expect(snapshot()).toEqual(result);
  });

  it('exhausts a short real queue without inventing leads', () => {
    database.raw.prepare("UPDATE sales_cycles SET resurface_at = '2027-01-01T00:00:00.000Z', resurface_reason = 'snooze' WHERE id >= 'q10-cycle'").run();
    expect(snapshot()).toMatchObject({ scannedQueueRows: 10, leads: expect.any(Array) });
    expect(snapshot().leads).toHaveLength(10);
  });

  it('scans 40 explicitly synthetic ordered input rows to reach 30 distinct people using the actual collector', async () => {
    expect(domain.getLeadTriageSnapshot).toBeTypeOf('function');
    const { collectLeadTriageSnapshot } = await import('../../src/main/today/leadTriageReportService');
    const queue = domain.getTriageQueue();
    const rows = queue.items.map((row) => ({ cycle_id: row.salesCycleId, person_id: row.personId, display_name: row.personName, prospect_id: row.personId.replace('-person', '-prospect') }));
    const synthetic = [...rows.slice(0, 10).flatMap((row) => [row, row]), ...rows.slice(10)];
    const before = tableBytes();
    const result = collectLeadTriageSnapshot({ database, services, orderedRows: synthetic, request: { limit: 30 }, generatedAt: NOW, revisionBefore: queue.revision, currentRevision: () => domain.getTriageQueue().revision });
    expect(result.scannedQueueRows).toBe(40);
    expect(result.leads.map((row) => row.personId)).toEqual(queue.items.slice(0, 30).map((row) => row.personId));
    expect(result.leads.map((row) => row.queueIndex)).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, ...Array.from({ length: 20 }, (_, i) => 20 + i)]);
    expect(result.leads.map((row) => row.rank)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(tableBytes()).toEqual(before);
  });

  it.each(['Avery +14015550100', 'Avery (401) 555-0100', 'owner@example.com', 'Avery 123 Hope St', 'Avery 123 Hope Street, Providence'])('rejects unsafe display text %s with no partial artifact or database mutation', (unsafe) => {
    database.raw.prepare("UPDATE persons SET display_name = ? WHERE id = 'q00-person'").run(unsafe);
    const before = tableBytes();
    expect(domain.getLeadTriageSnapshot).toBeTypeOf('function');
    expect(() => domain.getLeadTriageSnapshot({ limit: 30 })).toThrow('Unsafe triage artifact');
    expect(tableBytes()).toEqual(before);
  });

  it.each(['organization', 'locality', 'region', 'postal'])('rejects unsafe %s text with no database mutation', (field) => {
    const sql = { organization: 'UPDATE organizations SET canonical_name = ?', locality: 'UPDATE properties SET locality = ?', region: 'UPDATE properties SET region = ?', postal: 'UPDATE properties SET postal_code = ?' }[field]!;
    database.raw.prepare(sql).run('owner@example.com');
    const before = tableBytes();
    expect(domain.getLeadTriageSnapshot).toBeTypeOf('function');
    expect(() => domain.getLeadTriageSnapshot({ limit: 30 })).toThrow('Unsafe triage artifact');
    expect(tableBytes()).toEqual(before);
  });

  it('enforces the frozen contract, recursive privacy, count/rank/ID/revision coherence and closed assessment vocabulary', async () => {
    const valid = snapshot();
    const { leadTriageSnapshotSchema, leadTriageAssessmentSchema, assertTriageArtifactSafe, leadTriageSnapshotRequestSchema } = await import('../../src/shared/contracts/leadTriageReportContract');
    expect(leadTriageSnapshotSchema.parse(valid)).toEqual(valid);
    for (const request of [{ limit: 19 }, { limit: 31 }, { limit: 20.5 }, { limit: '30' }, { limit: 30, extra: true }, {}]) {
      expect(leadTriageSnapshotRequestSchema.safeParse(request).success).toBe(false);
    }
    const invalid: unknown[] = [
      { ...valid, privacyScanPassed: false }, { ...valid, privacyScanPassed: undefined },
      { ...valid, revisionAfter: valid.revisionBefore + 1 }, { ...valid, requestedLimit: 20 },
      { ...valid, scannedQueueRows: 29 }, { ...valid, scannedQueueRows: -1 },
      { ...valid, leads: [valid.leads[0], valid.leads[0]] },
      { ...valid, leads: valid.leads.map((row, i) => i === 1 ? { ...row, salesCycleId: valid.leads[0]!.salesCycleId } : row) },
      { ...valid, leads: valid.leads.map((row, i) => i === 1 ? { ...row, queueIndex: 0 } : row) },
      { ...valid, leads: valid.leads.map((row, i) => i === 1 ? { ...row, rank: 3 } : row) },
      { ...valid, providerPayload: { nested: ['secret'] } },
    ];
    const mutations: ((lead: LeadTriageSnapshot['leads'][number]) => void)[] = [
      (lead) => { lead.personName = 'owner@example.com'; },
      (lead) => { lead.organization.label = '123 Hope Street'; },
      (lead) => { lead.locality = '+442079460958'; },
      (lead) => { lead.region = '(401) 555-0100'; },
      (lead) => { lead.postalCode = 'owner@example.com'; },
      (lead) => { lead.contacts.maskedPrimaryPhone = '+14015550100'; },
      (lead) => { lead.contacts.maskedPrimaryPhone = '••• 14015550100'; },
      (lead) => { lead.contacts.maskedPrimaryPhone = '0100'; },
      (lead) => { lead.fit.evidenceCodes = ['invented' as never]; },
      (lead) => { lead.timing.triggers[0]!.code = 'invented' as never; },
      (lead) => { lead.cloud.contributions[0]!.signalCode = 'invented' as never; },
      (lead) => { lead.organization.relationship = 'invented' as never; },
      (lead) => { lead.compliance.refusalReasonCodes = ['invented' as never]; },
      (lead) => { Object.assign(lead.contacts, { rawPayload: {} }); },
    ];
    for (const mutate of mutations) { const changed = structuredClone(valid); mutate(changed.leads[0]!); invalid.push(changed); }
    for (const value of invalid) expect(leadTriageSnapshotSchema.safeParse(value).success).toBe(false);
    for (const key of ['phone', 'email', 'streetAddress', 'providerPayload', 'rawPayload', 'messageBody', 'messageSubject']) {
      expect(() => assertTriageArtifactSafe({ safe: [{ deeper: { [key]: 'innocent' } }] })).toThrow();
    }
    for (const value of ['+14015550100', '(401) 555-0100', '401.555.0100', '+44 20 7946 0958', 'owner@example.com', '123 Hope St', '123 Hope Street']) {
      expect(() => assertTriageArtifactSafe({ safe: [{ nested: value }] })).toThrow();
      expect(() => assertTriageArtifactSafe({ [value]: null })).toThrow();
    }
    expect(() => assertTriageArtifactSafe({ safe: ['Harbor Holdings', 'Providence', '02906', '••• ••• 0100', NOW] })).not.toThrow();
    const assessment: LeadTriageAssessment = { personId: 'q00-person', salesCycleId: 'q00-cycle', recommendation: 'watch', likelyPriority: null, evidenceCodes: ['fit_low'], suggestedReviewOrder: 1 };
    expect(leadTriageAssessmentSchema.parse(assessment)).toEqual(assessment);
    for (const patch of [{ recommendation: 'invented' }, { likelyPriority: 'P2' }, { evidenceCodes: ['provider story'] }, { evidenceCodes: [] }, { suggestedReviewOrder: 0 }, { score: 99 }, { personId: 'owner@example.com' }]) expect(leadTriageAssessmentSchema.safeParse({ ...assessment, ...patch }).success).toBe(false);
  });

  it('reports a shared suppressed email handle as blocked even with no phones or compatibility flag', () => {
    const before = tableBytes();
    const lead = snapshot().leads.find((lead) => lead.personId === 'q05-person');
    expect(lead!.compliance).toEqual({ status: 'blocked', refusalReasonCodes: ['person_or_handle_opted_out'] });
    expect(lead!.contacts.evidenceCodes).toContain('compliance_blocked');
    expect(tableBytes()).toEqual(before);
  });

  it('fails closed on unresolved suppression and never returns an artifact or changes database bytes', () => {
    const before = tableBytes();
    vi.spyOn(services.outboundPermission, 'inspectPerson').mockImplementation(() => { throw new Error('Unresolved synthetic membership'); });
    expect(() => snapshot()).toThrow();
    expect(tableBytes()).toEqual(before);
  });

  it('rejects inconsistent revision and duplicate row identity in synthetic collector inputs without writes', async () => {
    const { collectLeadTriageSnapshot } = await import('../../src/main/today/leadTriageReportService');
    const rows = domain.getTriageQueue().items.slice(0, 2).map((row) => ({ cycle_id: row.salesCycleId, person_id: row.personId, display_name: row.personName, prospect_id: row.personId.replace('-person', '-prospect') }));
    const before = tableBytes();
    const revision = domain.getTriageQueue().revision;
    const input = { database, services, orderedRows: rows, request: { limit: 30 }, generatedAt: NOW, revisionBefore: revision, currentRevision: () => revision };
    expect(() => collectLeadTriageSnapshot({ ...input, currentRevision: () => revision + 1 })).toThrow();
    expect(() => collectLeadTriageSnapshot({ ...input, orderedRows: [rows[0]!, { ...rows[1]!, cycle_id: rows[0]!.cycle_id }] })).toThrow();
    expect(tableBytes()).toEqual(before);
  });

  it('preserves an empty queue and its persisted review position without resetting it', () => {
    database.raw.prepare("UPDATE sales_cycles SET resurface_at = '2027-01-01T00:00:00.000Z', resurface_reason = 'snooze' WHERE workflow_status = 'active'").run();
    const before = tableBytes();
    expect(snapshot()).toMatchObject({ leads: [], scannedQueueRows: 0 });
    expect(tableBytes()).toEqual(before);
  });

  it('uses approved whole Timing points without recomputing persisted boundary bands or null evidence', () => {
    const leads = snapshot().leads;
    expect(leads.slice(6, 11).map((lead) => [lead.timing.value, lead.timing.band]))
      .toEqual([[7, 'cold'], [8, 'warm'], [19, 'warm'], [20, 'hot'], [40, 'hot']]);
    expect(leads[4]!.timing).toEqual({ value: null, band: null, triggers: [] });
    expect(domain.getLeadDetail({ personId: 'q06-person' }).priorityContext.timingValue).toBe(7.999);
  });
});
