import { BUILTIN_CADENCES } from '../../src/main/domain/cadence/builtinCadences';
import { attachTranscript } from '../../src/main/domain/conversations/conversationsDomain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectDiscoveryEvidence, validateDiscoveryClaim, DiscoveryEvidenceDiagnosticError } from '../../src/main/domain/discovery/discoveryEvidence';
import { evaluateDiscovery } from '../../src/main/domain/discovery/discoveryPolicy';
import { BUILTIN_PRIORITIZATION_RULE_V1 } from '../../src/main/domain/prioritization/builtinPrioritizationRules';
import { mapCloudSourceEvent, buildNeedsIdentityIntakeCommand } from '../../src/main/sourcing/intakeMapper';
import { validFrboEvent, validParcelEvent } from '../fixtures/cloudSourceEvents';
import { createDiscoveryDatabase, seedDiscoveryOwner, DISCOVERY_NOW, type DiscoveryDatabase } from '../fixtures/discoveryDatabase';
import type { CloudSourceEvent } from '../../src/shared/contracts/cloudSourceEventContract';

let f: DiscoveryDatabase;
beforeEach(async () => { f = await createDiscoveryDatabase(); });
afterEach(() => f.close());
const collect = (prospectId: string, asOf = DISCOVERY_NOW) => f.services.unitOfWork.immediate(() => collectDiscoveryEvidence({ database: f.database, services: f.services, prospectId, asOf }));
function intake(event: CloudSourceEvent) {
  const mapped = mapCloudSourceEvent(event);
  if (mapped.kind === 'score-update') throw new Error('Unexpected score update');
  const command = mapped.kind === 'intake' ? mapped.command : buildNeedsIdentityIntakeCommand(mapped)!;
  const result = f.services.sources.createPersonProspect(command);
  f.services.lifecycle.createUnreviewedCycle({ personId: result.personId, prospectId: result.prospectId, entrySourceEventId: result.sourceEventId, effectiveAt: DISCOVERY_NOW });
  return result;
}
function append(owner: ReturnType<typeof seedDiscoveryOwner>, event: CloudSourceEvent, id: string) {
  return f.services.sources.appendSourceInteraction({ id, personId: owner.personId, prospectId: owner.prospectId,
    channel: event.channel as 'parcel', observedAt: new Date(event.observed_at).toISOString(), sourceRecord: { cloudSourceEvent: event } });
}
function statement(owner: ReturnType<typeof seedDiscoveryOwner>, text: string, id = 'statement', speaker = 'lead') {
  f.services.unitOfWork.immediate(() => f.services.events.appendActivity({ id, personId: owner.personId, prospectId: owner.prospectId,
    salesCycleId: owner.salesCycleId, kind: 'call', direction: 'inbound', channel: 'call', occurredAt: DISCOVERY_NOW, observedOutcome: 'spoke' }));
  const ids = [`${id}-consent`, `${id}-transcript`, `${id}-utterance`];
  attachTranscript({ database: f.database, clock: { now: () => DISCOVERY_NOW }, ids: { next: () => ids.shift()! } },
    { activityId: id, personId: owner.personId, rawText: speaker === 'unknown' ? text : `${speaker === 'lead' ? 'Lead' : 'Founder'}: ${text}` });
  return `${id}-utterance`;
}

describe('coherent collector evidence admission', () => {
  it('uses the owner index for both source reads without changing evidence as unrelated sources grow', () => {
    const owner = seedDiscoveryOwner(f, { prefix: 'indexed-owner', units: 10 });
    const other = seedDiscoveryOwner(f, { prefix: 'indexed-other', units: 99 });
    const raw = f.database.raw;
    const source = f.services.sourceRepository.getById(owner.sourceEventId)!;
    const event = source.sourceRecord.cloudSourceEvent as CloudSourceEvent;
    const personOnly = f.services.sources.appendSourceInteraction({ id: 'indexed-person-only', personId: owner.personId,
      prospectId: null, channel: 'parcel', observedAt: source.observedAt, sourceRecord: { cloudSourceEvent: event } });
    const link = raw.prepare('INSERT INTO cloud_entity_links (cloud_entity_id, person_id, linked_at) VALUES (?, ?, ?)');
    link.run(event.entity.cloud_entity_id, owner.personId, DISCOVERY_NOW);
    link.run('indexed-unreferenced-owned', owner.personId, DISCOVERY_NOW);
    link.run('indexed-unrelated', other.personId, DISCOVERY_NOW);
    const expected = collect(owner.prospectId);
    expect(expected.validatedClaims.some(c => c.refs.some(r => r.kind === 'source' && r.sourceEventId === personOnly.id))).toBe(true);
    expect(expected.properties[0]?.doorCount).toBe(10);

    // Grow unrelated encrypted rows without changing any of this owner's evidence.
    const insert = raw.prepare(`INSERT INTO source_events (id, person_id, prospect_id, channel, observed_at, source_record_json, created_at)
      SELECT ?, person_id, prospect_id, channel, observed_at, source_record_json, created_at FROM source_events WHERE id = ?`);
    raw.transaction(() => { for (let i = 0; i < 128; i++) insert.run(`indexed-unrelated-${i}`, other.sourceEventId); })();
    const prepare = raw.prepare.bind(raw);
    const reads: Array<{ sql: string; bindings: unknown[]; rows: unknown[] }> = [];
    const restoreStatements: Array<() => void> = [];
    // Observe the SQL, bindings and rows actually used by the collector. Every
    // statement still executes unchanged against the real encrypted database.
    const observer = vi.spyOn(raw, 'prepare').mockImplementation(sql => {
      const statement = prepare(sql);
      if (/^SELECT \* FROM (source_events|cloud_entity_links) WHERE/.test(sql)) {
        const all = statement.all.bind(statement);
        const execution = vi.spyOn(statement, 'all').mockImplementation((...bindings: unknown[]) => {
          const rows = all(...bindings);
          reads.push({ sql, bindings, rows });
          return rows;
        });
        restoreStatements.push(() => execution.mockRestore());
      }
      return statement;
    });
    try {
      const snapshot = collect(owner.prospectId);
      expect(snapshot).toEqual(expected); // Includes the complete fingerprint and citations.
      for (const claim of snapshot.validatedClaims) expect(validateDiscoveryClaim({ snapshot, claim })).toBe(true);
    } finally {
      observer.mockRestore();
      restoreStatements.forEach(restore => restore());
    }
    expect(reads).toHaveLength(2);
    const sourceRead = reads.find(read => read.sql.startsWith('SELECT * FROM source_events'))!;
    const cloudRead = reads.find(read => read.sql.startsWith('SELECT * FROM cloud_entity_links'))!;
    expect(sourceRead.rows).toEqual(prepare('SELECT * FROM source_events WHERE person_id = ? OR prospect_id = ? ORDER BY observed_at, id')
      .all(owner.personId, owner.prospectId));
    expect(cloudRead.rows).toEqual(prepare(`SELECT * FROM cloud_entity_links WHERE person_id = ?
      OR cloud_entity_id IN (SELECT json_extract(source_record_json, '$.sourceRecord.cloudSourceEvent.entity.cloud_entity_id')
        FROM source_events WHERE (person_id = ? OR prospect_id = ?) AND json_valid(source_record_json))
      ORDER BY cloud_entity_id`).all(owner.personId, owner.personId, owner.prospectId));
    for (const read of reads) {
      const plan = prepare(`EXPLAIN QUERY PLAN ${read.sql}`).all(...read.bindings) as Array<{ detail: string }>;
      const sourceSteps = plan.filter(step => /\bsource_events\b/.test(step.detail)).map(step => step.detail);
      expect.soft(sourceSteps, read.sql).toEqual([expect.stringContaining('SEARCH source_events USING INDEX source_events_person_observed_idx (person_id=?)')]);
      expect.soft(sourceSteps.some(step => /\bSCAN source_events\b/.test(step)), read.sql).toBe(false);
    }
    expect(raw.pragma('foreign_key_check')).toEqual([]);
  });

  it('rejects a source that references another person\'s prospect under the admitted composite foreign key', () => {
    const owner = seedDiscoveryOwner(f, { prefix: 'fk-owner', units: 10 });
    const other = seedDiscoveryOwner(f, { prefix: 'fk-other', units: 99 });
    const before = collect(owner.prospectId);
    expect(f.database.raw.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(() => f.database.raw.prepare(`INSERT INTO source_events
      (id, person_id, prospect_id, channel, observed_at, source_record_json, created_at)
      SELECT 'foreign-owner-source', ?, ?, channel, observed_at, source_record_json, created_at FROM source_events WHERE id = ?`)
      .run(other.personId, owner.prospectId, other.sourceEventId)).toThrow(/FOREIGN KEY constraint failed/);
    expect(collect(owner.prospectId)).toEqual(before);
    expect(f.database.raw.pragma('foreign_key_check')).toEqual([]);
  });

  it('validates real owned structured activity values without promoting arbitrary metadata semantics', () => {
    const owner = seedDiscoveryOwner(f, { prefix: 'structured', units: 10 });
    f.services.unitOfWork.immediate(() => f.services.events.appendActivity({ id: 'structured-call', personId: owner.personId,
      prospectId: owner.prospectId, kind: 'call', direction: 'inbound', channel: 'call', occurredAt: DISCOVERY_NOW,
      callOutcome: 'spoke', metadata: { self_managed: true, willingness_to_pay: true } }));
    const snapshot = collect(owner.prospectId);
    const claim = snapshot.validatedClaims.find(c => c.refs.some(r => r.kind === 'activity' && r.activityId === 'structured-call' && r.field === 'call_outcome'));
    expect(claim).toMatchObject({ value: 'spoke', certainty: 'fact' });
    expect(validateDiscoveryClaim({ snapshot, claim: claim! })).toBe(true);
    expect(validateDiscoveryClaim({ snapshot, claim: { ...claim!, value: 'interview_booked' } })).toBe(false);
    expect(validateDiscoveryClaim({ snapshot, claim: { ...claim!, value: true, label: 'Willingness to pay',
      refs: [{ kind: 'activity', activityId: 'structured-call', field: 'metadata.willingness_to_pay', observedAt: DISCOVERY_NOW }] } })).toBe(false);
    expect(snapshot.properties[0]?.maintenanceProfile).toBeNull();
  });

  it('also runs in an already-owned query-only read transaction', () => {
    const owner = seedDiscoveryOwner(f, { prefix: 'read-only', units: 10 });
    const expected = collect(owner.prospectId);
    f.database.raw.exec('PRAGMA query_only = ON; BEGIN');
    try {
      expect(collectDiscoveryEvidence({ database: f.database, services: f.services, prospectId: owner.prospectId, asOf: DISCOVERY_NOW })).toEqual(expected);
    } finally { f.database.raw.exec('ROLLBACK; PRAGMA query_only = OFF'); }
  });

  it('classifies contradictory owned statements before truncation even without an existing profile', () => {
    const owner = seedDiscoveryOwner(f, { prefix: 'contradictory', units: 10 });
    const property = f.services.identities.listPropertiesForProspect(owner.prospectId)[0]!;
    statement(owner, `I self-manage ${property.addressLine1}.`, 'self');
    statement(owner, `A third-party manager manages ${property.addressLine1}.`, 'third');
    expect(collect(owner.prospectId).conflicts.some(c => c.kind === 'property')).toBe(true);
  });

  it('does not assign a building-wide source to a different unit address', () => {
    const owner = seedDiscoveryOwner(f, { prefix: 'unit', units: 10 });
    const p = f.services.identities.listPropertiesForProspect(owner.prospectId)[0]!;
    f.database.raw.prepare('UPDATE properties SET address_line_2 = ? WHERE id = ?').run('unit 2', p.id);
    expect(collect(owner.prospectId).properties).toEqual([]);
  });

  it('honors an actual conflicting cloud entity link even when the names match', () => {
    const owner = seedDiscoveryOwner(f, { prefix: 'cloud-owner', units: 10 });
    const other = seedDiscoveryOwner(f, { prefix: 'cloud-other', units: 3 });
    const source = f.services.sourceRepository.getById(owner.sourceEventId)!;
    const event = source.sourceRecord.cloudSourceEvent as CloudSourceEvent;
    f.database.raw.prepare('INSERT INTO cloud_entity_links (cloud_entity_id, person_id, linked_at) VALUES (?, ?, ?)').run(event.entity.cloud_entity_id, other.personId, DISCOVERY_NOW);
    const snapshot = collect(owner.prospectId);
    expect(snapshot.properties).toEqual([]);
    expect(snapshot.conflicts.some(c => c.kind === 'ownership')).toBe(true);
  });

  it('does not turn a future-dated listing into a current vacancy', () => {
    const event = validFrboEvent(); event.entity.person = validParcelEvent().entity.person;
    event.signal_flags.vacancy = true; event.payload.listed_at = '2026-10-01T00:00:00.000Z';
    const owner = intake(event);
    expect(collect(owner.prospectId).triggers).toEqual([]);
  });

  it('leaves municipal open dates and heuristic pain as dated context, not timing or buyer intent', () => {
    const event = validParcelEvent(); event.channel = 'violation';
    event.payload = { violation_kind: 'heat', status: 'open', opened_at: '2026-08-29', case_ref: 'synthetic-case' };
    event.trigger = { type: 'violation_opened', weight: 2, half_life_days: null,
      window: { opens_at: '2026-08-29T00:00:00.000Z', peaks_at: '2026-09-01T00:00:00.000Z', closes_at: '2026-09-10T00:00:00.000Z' } };
    const owner = intake(event);
    const snapshot = collect(owner.prospectId);
    expect(snapshot.triggers).toEqual([]);
    expect(snapshot.validatedClaims.some(c => c.value === '2026-08-29')).toBe(true);
    expect(snapshot.properties[0]?.maintenanceProfile).toBeNull();
  });

  it.each(['valid', 'new-cycle', 'source-cycle', 'rule-type'])('checks a real consumed-rule receipt and full proof: %s', mismatch => {
    const owner = seedDiscoveryOwner(f, { prefix: 'receipt', units: 10 });
    const ready = f.services.lifecycle.reviewToReady({ cycleId: owner.salesCycleId, expectedCycleVersion: 1, expectedProspectVersion: 1, effectiveAt: DISCOVERY_NOW });
    const activatedAt = '2026-09-07T12:00:00.000Z';
    f.services.lifecycle.closeLostNurture({ cycleId: owner.salesCycleId, expectedCycleVersion: ready.version,
      expectedCurrentActionId: ready.currentNextActionId!, reason: 'bad_timing', qualificationGateReason: null,
      notes: null, effectiveAt: DISCOVERY_NOW, manualReactivationDueAt: activatedAt, expectedProspectVersion: null });
    const rule = f.database.raw.prepare('SELECT id FROM reactivation_rules WHERE sales_cycle_id = ? AND rule_type = ?').get(owner.salesCycleId, 'manual') as { id: string };
    const cadence = BUILTIN_CADENCES.find(c => c.family === 'cadence_b')!;
    const result = f.services.lifecycle.reactivateFromRule({ ruleId: rule.id, expectedRuleVersion: 1, personId: owner.personId,
      prospectId: owner.prospectId, sourceCycleId: owner.salesCycleId, entrySourceEventId: owner.sourceEventId, newCycleId: 'receipt-new-cycle',
      activatedAt, ruleType: 'manual', trigger: { kind: 'due', dueAt: activatedAt },
      cadence: { definitionId: cadence.id, family: 'cadence_b', version: cadence.version, contentHash: cadence.contentHash } });
    expect(result.kind).toBe('reactivated');
    const stored = f.services.prioritization.recordTriggerEvent({ id: 'receipt-trigger', prospectId: owner.prospectId,
      triggerType: 'nurture_resurrection', effectiveAt: activatedAt, sourceExpiresAt: null, strengthMultiplier: 1, verificationState: 'verified',
      evidence: { formatVersion: 1, triggerType: 'nurture_resurrection', authoredUnderRuleVersionId: 'founder-priority-v1',
        evidenceRefs: [`rule:${rule.id}`], function: 'windowed', startsAt: activatedAt, endsAt: '2026-09-21T12:00:00.000Z',
        proof: { kind: 'reactivation_rule_receipt', activationKey: `rule:${rule.id}`, ruleId: rule.id,
          ruleType: mismatch === 'rule-type' ? 'seasonal:heating-oct1' : 'manual',
          sourceCycleId: mismatch === 'source-cycle' ? 'not-the-source' : owner.salesCycleId,
          newCycleId: mismatch === 'new-cycle' ? owner.salesCycleId : 'receipt-new-cycle', activatedAt } } });
    const before = f.database.raw.prepare('SELECT total_changes() AS n').get();
    const snapshot = collect(owner.prospectId, activatedAt);
    expect(snapshot.salesCycleId).toBe('receipt-new-cycle');
    expect(snapshot.triggers).toEqual(mismatch === 'valid' ? [stored] : []);
    expect(f.database.raw.prepare('SELECT total_changes() AS n').get()).toEqual(before);
  });

  it.each(['valid', 'arbitrary-ref', 'no-vacancy'])('requires actual FRBO value support for existing canonical trigger proof: %s', mode => {
    const event = validFrboEvent(); event.entity.person = validParcelEvent().entity.person;
    event.signal_flags.vacancy = mode === 'no-vacancy' ? null : true;
    const owner = intake(event);
    const stored = f.services.prioritization.recordTriggerEvent({ id: 'existing-trigger', prospectId: owner.prospectId,
      triggerType: 'live_vacancy', effectiveAt: event.observed_at, sourceExpiresAt: null, strengthMultiplier: 1, verificationState: 'verified',
      evidence: { formatVersion: 1, triggerType: 'live_vacancy', authoredUnderRuleVersionId: 'founder-priority-v1', function: 'decaying',
        evidenceRefs: [mode === 'arbitrary-ref' ? 'trust-me' : event.payload.listing_url as string],
        proof: { kind: 'source_event', sourceEventId: owner.sourceEventId, sourceObservedAt: event.observed_at } } });
    expect(collect(owner.prospectId).triggers).toEqual(mode === 'valid' ? [stored] : []);
  });

  it('does not admit an unattached transcript as canonical property proof', () => {
    const owner = seedDiscoveryOwner(f, { prefix: 'unattached', units: 10 });
    const property = f.services.identities.listPropertiesForProspect(owner.prospectId)[0]!;
    const text = `I self-manage ${property.addressLine1}.`;
    f.services.unitOfWork.immediate(() => f.services.events.appendActivity({ id: 'unattached', personId: owner.personId, prospectId: owner.prospectId,
      kind: 'call', direction: 'inbound', channel: 'call', occurredAt: DISCOVERY_NOW }));
    f.database.raw.prepare(`INSERT INTO transcripts (id, activity_id, person_id, source, format_version, raw_text, created_at) VALUES ('unattached-t', 'unattached', ?, 'manual_paste', 1, ?, ?)`).run(owner.personId, text, DISCOVERY_NOW);
    f.database.raw.prepare(`INSERT INTO transcript_utterances VALUES ('unattached-u', 'unattached-t', 0, 'lead', ?)`).run(text);
    f.database.raw.prepare('UPDATE properties SET maintenance_profile_json = ? WHERE id = ?').run(JSON.stringify({ formatVersion: 1, management: 'self_managed', relevantProfile: 'unknown', evidenceRefs: ['unattached-u'] }), property.id);
    expect(collect(owner.prospectId).properties[0]?.maintenanceProfile).toBeNull();
  });

  it('requires a transaction and is SELECT-only, stable and sourced even when verifiedAt is null', () => {
    const owner = seedDiscoveryOwner(f, { prefix: 'owner', units: 10 });
    expect(() => collectDiscoveryEvidence({ database: f.database, services: f.services, prospectId: owner.prospectId, asOf: DISCOVERY_NOW })).toThrow();
    const before = f.database.raw.prepare('SELECT total_changes() AS n').get();
    const snapshot = collect(owner.prospectId);
    expect(snapshot.properties).toHaveLength(1);
    expect(snapshot.properties[0]).toMatchObject({ doorCount: 10, verifiedAt: null, maintenanceProfile: null });
    expect(snapshot).toMatchObject({ unresolvedIdentity: false, identitySupported: true, conflicts: [] });
    expect(collect(owner.prospectId)).toEqual(snapshot);
    expect(collect(owner.prospectId, '2026-09-07T12:00:00.000Z').inputFingerprint).toBe(snapshot.inputFingerprint);
    expect(f.database.raw.prepare('SELECT total_changes() AS n').get()).toEqual(before);
    const assessment = evaluateDiscovery({ snapshot, rule: BUILTIN_PRIORITIZATION_RULE_V1, asOf: DISCOVERY_NOW });
    expect(assessment.axes.fit?.points).toBe(15);
    expect(assessment.ranking.latestSourceObservedAt).toBe('2026-08-30T00:00:00.000Z');
  });

  it('distinguishes real owner entities from unknown-owner placeholders without inferring management', () => {
    const entity = validParcelEvent(); entity.entity.person!.full_name = null;
    const owner = intake(entity);
    const snapshot = collect(owner.prospectId);
    expect(snapshot.identitySupported).toBe(true);
    expect(snapshot.claims.some(c => c.label === 'Self-managed' && c.certainty === 'fact')).toBe(false);
    const placeholderEvent = validFrboEvent();
    const placeholder = intake(placeholderEvent);
    expect(collect(placeholder.prospectId)).toMatchObject({ identitySupported: false, unresolvedIdentity: true, properties: [], triggers: [] });
  });

  it('collects all linked properties and organizations and treats source replay as no change', () => {
    const event = validParcelEvent(); const owner = intake(event);
    const mapped = mapCloudSourceEvent(event); if (mapped.kind !== 'intake') throw new Error('Expected intake');
    const before = collect(owner.prospectId);
    expect(f.services.sources.createPersonProspect(mapped.command).personId).toBe(owner.personId);
    expect(collect(owner.prospectId).inputFingerprint).toBe(before.inputFingerprint);
    const second = validParcelEvent(); second.idempotency_key = 'd'.repeat(64); second.id = 'se_01JC0000000000000000000003';
    second.entity.property!.situs_address.line1 = 'Second St'; second.entity.property!.parcel_id = 'SECOND'; second.entity.property!.unit_count = 8;
    second.entity.person!.org_names.push('SECOND LLC');
    const m = mapCloudSourceEvent(second); if (m.kind !== 'intake') throw new Error('Expected intake');
    f.services.sources.createPersonProspect(m.command);
    const snapshot = collect(owner.prospectId);
    expect(snapshot.properties.map(p => p.doorCount).sort()).toEqual([3, 8]);
    expect(snapshot.validatedClaims.some(c => c.value === 'SECOND LLC')).toBe(true);
    expect(snapshot.inputFingerprint).not.toBe(before.inputFingerprint);
  });

  it('rejects mismatched owner, value, arbitrary source paths, date and label laundering', () => {
    const owner = seedDiscoveryOwner(f, { prefix: 'owned', units: 10 });
    const other = seedDiscoveryOwner(f, { prefix: 'other', units: 99 });
    const snapshot = collect(owner.prospectId);
    const doors = snapshot.validatedClaims.find(c => c.value === 10)!;
    expect(doors).toBeDefined();
    expect(validateDiscoveryClaim({ snapshot, claim: { ...doors, id: 'another-id' } })).toBe(true);
    for (const claim of [ { ...doors, value: 99 }, { ...doors, label: 'Willing to pay' },
      { ...doors, refs: [] }, { ...doors, refs: [{ kind: 'source' as const, sourceEventId: other.sourceEventId, field: 'entity.property.unit_count', observedAt: '2026-08-30T00:00:00.000Z' }] },
      { ...doors, refs: doors.refs.map(ref => ({ ...ref, observedAt: DISCOVERY_NOW })) },
      { ...doors, refs: [{ kind: 'source' as const, sourceEventId: owner.sourceEventId, field: '__proto__.owner', observedAt: '2026-08-30T00:00:00.000Z' }] } ]) {
      expect(validateDiscoveryClaim({ snapshot, claim })).toBe(false);
    }
    const wrong = validParcelEvent(); wrong.entity.property!.situs_address.line1 = 'owned Hope St'; wrong.entity.property!.parcel_id = 'SYNTHETIC-owned';
    append(owner, wrong, 'wrong-owner');
    expect(collect(owner.prospectId).conflicts.some(c => c.kind === 'identity')).toBe(true);
  });

  it('requires full channel payload validation, not an envelope or source label', () => {
    const event = validFrboEvent(); event.entity.person = validParcelEvent().entity.person; event.signal_flags.vacancy = true;
    event.payload = { listing_url: 'not a valid listing' };
    const owner = intake(event);
    const snapshot = collect(owner.prospectId);
    expect(snapshot.properties).toEqual([]);
    expect(snapshot.triggers).toEqual([]);
    expect(snapshot.identitySupported).toBe(false);
  });

  it('does not promote FRBO management heuristics or unsupported canonical profile refs', () => {
    const event = validFrboEvent(); event.entity.person = validParcelEvent().entity.person;
    const owner = intake(event);
    const property = f.services.identities.listPropertiesForProspect(owner.prospectId)[0]!;
    f.database.raw.prepare('UPDATE properties SET maintenance_profile_json = ?, verified_at = ? WHERE id = ?').run(JSON.stringify({ formatVersion: 1, management: 'self_managed', relevantProfile: true, evidenceRefs: ['arbitrary', owner.sourceEventId] }), DISCOVERY_NOW, property.id);
    const snapshot = collect(owner.prospectId);
    expect(snapshot.properties[0]?.maintenanceProfile).toBeNull();
    expect(snapshot.claims.find(c => c.label === 'Self-managed')?.certainty).toBe('inference');
    expect(evaluateDiscovery({ snapshot, rule: BUILTIN_PRIORITIZATION_RULE_V1, asOf: DISCOVERY_NOW }).axes.fit?.points ?? 0).toBeLessThan(8);
  });

  it('admits only explicit lead statements naming the exact linked property and excludes amended activities', () => {
    const owner = seedDiscoveryOwner(f, { prefix: 'spoken', units: 10 });
    const property = f.services.identities.listPropertiesForProspect(owner.prospectId)[0]!;
    const quote = `I self-manage ${property.addressLine1}.`;
    const ref = statement(owner, quote);
    f.database.raw.prepare('UPDATE properties SET maintenance_profile_json = ? WHERE id = ?').run(JSON.stringify({ formatVersion: 1, management: 'self_managed', relevantProfile: 'unknown', evidenceRefs: [ref] }), property.id);
    const snapshot = collect(owner.prospectId);
    expect(snapshot.properties[0]?.maintenanceProfile?.management).toBe('self_managed');
    const claim = snapshot.validatedClaims.find(c => c.value === 'self_managed')!;
    expect(claim.refs[0]).toMatchObject({ kind: 'utterance', quote, utteranceId: ref });
    expect(validateDiscoveryClaim({ snapshot, claim: { ...claim, refs: claim.refs.map(r => ({ ...r, quote: 'I own it.' })) } })).toBe(false);
    f.services.unitOfWork.immediate(() => f.services.events.appendActivityAmendment({ activityId: 'statement', amendmentKind: 'marked_in_error', correction: {}, reason: 'Wrong conversation' }));
    const amended = collect(owner.prospectId);
    expect(amended.properties[0]?.maintenanceProfile).toBeNull();
    expect(amended.conversationActivityIds).toEqual([]);
    expect(amended.inputFingerprint).not.toBe(snapshot.inputFingerprint);
  });

  it.each(['other-locality', 'normalized-unit'])('does not attribute an ambiguous street-only statement across linked properties: %s', context => {
    const event = validParcelEvent(); const owner = intake(event);
    const property = f.services.identities.listPropertiesForProspect(owner.prospectId)[0]!;
    if (context === 'other-locality') {
      const second = validParcelEvent(); second.idempotency_key = 'e'.repeat(64); second.id = 'se_01JC0000000000000000000004';
      second.entity.property!.parcel_id = 'AMBIGUOUS-SECOND'; second.entity.property!.situs_address.locality = 'Pawtucket';
      const mapped = mapCloudSourceEvent(second); if (mapped.kind !== 'intake') throw new Error('Expected intake');
      expect(f.services.sources.createPersonProspect(mapped.command).personId).toBe(owner.personId);
    } else {
      f.services.unitOfWork.immediate(() => {
        const unit = f.services.identities.createProperty({ addressLine1: `  ${property.addressLine1.toUpperCase()}  `,
          addressLine2: 'unit 2', locality: property.locality, region: property.region, countryCode: property.countryCode });
        f.services.identities.linkProperty({ prospectId: owner.prospectId, propertyId: unit.id });
      });
    }
    const linked = f.services.identities.listPropertiesForProspect(owner.prospectId);
    expect(linked).toHaveLength(2);
    const baselineFit = evaluateDiscovery({ snapshot: collect(owner.prospectId), rule: BUILTIN_PRIORITIZATION_RULE_V1, asOf: DISCOVERY_NOW }).axes.fit?.points;
    const cycle = f.database.raw.prepare('SELECT id FROM sales_cycles WHERE prospect_id = ?').get(owner.prospectId) as { id: string };
    const quote = `I self-manage ${property.addressLine1}.`;
    const ref = statement({ ...owner, salesCycleId: cycle.id }, quote, 'ambiguous-management');
    for (const p of linked) f.database.raw.prepare('UPDATE properties SET maintenance_profile_json = ? WHERE id = ?').run(
      JSON.stringify({ formatVersion: 1, management: 'self_managed', relevantProfile: 'unknown', evidenceRefs: [ref] }), p.id);
    const before = f.database.raw.prepare('SELECT total_changes() AS n').get();
    const snapshot = collect(owner.prospectId);
    expect(snapshot.properties).toHaveLength(context === 'other-locality' ? 2 : 1);
    expect(snapshot.properties.every(p => p.maintenanceProfile === null)).toBe(true);
    expect(snapshot.validatedClaims.some(c => c.value === 'self_managed')).toBe(false);
    expect(snapshot.conflicts).toEqual([]);
    expect(snapshot.validatedClaims.find(c => c.value === quote)?.refs[0]).toMatchObject({ kind: 'utterance', utteranceId: ref, quote });
    const assessment = evaluateDiscovery({ snapshot, rule: BUILTIN_PRIORITIZATION_RULE_V1, asOf: DISCOVERY_NOW });
    expect(assessment.unknowns).toContain('Management style is unknown');
    expect(assessment.axes.fit?.points).toBe(baselineFit);
    expect(f.database.raw.prepare('SELECT total_changes() AS n').get()).toEqual(before);
  });

  it.each(['wrong-person', 'wrong-property', 'founder', 'unknown', 'unsupported'])('rejects %s statement proof', (kind) => {
    const owner = seedDiscoveryOwner(f, { prefix: 'speaker', units: 10 });
    const other = seedDiscoveryOwner(f, { prefix: 'other-speaker', units: 5 });
    const property = f.services.identities.listPropertiesForProspect(owner.prospectId)[0]!;
    const quote = kind === 'unsupported' ? 'We are busy.' : `I self-manage ${kind === 'wrong-property' ? 'Elsewhere St' : property.addressLine1}.`;
    const ref = statement(kind === 'wrong-person' ? other : owner, quote, 'bad-statement', ['founder', 'unknown'].includes(kind) ? kind : 'lead');
    f.database.raw.prepare('UPDATE properties SET maintenance_profile_json = ? WHERE id = ?').run(JSON.stringify({ formatVersion: 1, management: 'self_managed', relevantProfile: true, evidenceRefs: [ref] }), property.id);
    expect(collect(owner.prospectId).properties[0]?.maintenanceProfile).toBeNull();
  });

  it('detects all source/founder conflicts before presentation truncation', () => {
    const owner = seedDiscoveryOwner(f, { prefix: 'conflict', units: 10 });
    const original = f.services.sourceRepository.getById(owner.sourceEventId)!;
    const event = original.sourceRecord.cloudSourceEvent as CloudSourceEvent;
    for (let i = 0; i < 25; i++) append(owner, event, `repeat-${i}`);
    const changed = structuredClone(event); changed.entity.property!.unit_count = 11;
    append(owner, changed, 'zzz-conflict');
    const snapshot = collect(owner.prospectId);
    expect(snapshot.validatedClaims.length).toBeGreaterThan(100);
    expect(snapshot.claims.length).toBeLessThanOrEqual(100);
    expect(snapshot.conflicts.some(c => c.kind === 'property')).toBe(true);
    expect(evaluateDiscovery({ snapshot, rule: BUILTIN_PRIORITIZATION_RULE_V1, asOf: DISCOVERY_NOW }).disposition).toBe('judgment');
    expect(f.services.identities.listPropertiesForProspect(owner.prospectId)[0]?.doorCount).toBe(10);
  });

  it.each([
    ['line1', 'address_line_1', '99 Founder St'], ['locality', 'locality', 'Cranston'],
    ['region', 'region', 'MA'], ['country_code', 'country_code', 'CA'], ['postal_code', 'postal_code', '99999'],
  ])('retains known-parcel %s disagreement for judgment despite another supported property and display truncation', (field, column, storedValue) => {
    const event = validParcelEvent(); const owner = intake(event);
    const property = f.services.identities.listPropertiesForProspect(owner.prospectId)[0]!;
    const second = validParcelEvent(); second.idempotency_key = '9'.repeat(64); second.id = 'se_01JC0000000000000000000006';
    second.entity.property!.parcel_id = 'INDEPENDENT-SECOND'; second.entity.property!.situs_address.line1 = 'Second St';
    second.entity.property!.unit_count = 10;
    const mapped = mapCloudSourceEvent(second); if (mapped.kind !== 'intake') throw new Error('Expected intake');
    expect(f.services.sources.createPersonProspect(mapped.command).personId).toBe(owner.personId);
    for (let i = 0; i < 20; i++) f.services.sources.appendSourceInteraction({ id: `address-repeat-${i}`, personId: owner.personId,
      prospectId: owner.prospectId, channel: 'parcel', observedAt: second.observed_at, sourceRecord: { cloudSourceEvent: second } });
    f.database.raw.prepare(`UPDATE properties SET ${column} = ? WHERE id = ?`).run(storedValue, property.id);
    const rows = f.database.raw.prepare('SELECT * FROM properties ORDER BY id').all();
    const sources = f.database.raw.prepare('SELECT * FROM source_events ORDER BY id').all();
    const changes = f.database.raw.prepare('SELECT total_changes() AS n').get();
    const snapshot = collect(owner.prospectId);
    expect(snapshot.properties).toHaveLength(1);
    expect(snapshot.properties[0]?.doorCount).toBe(10);
    const assessment = evaluateDiscovery({ snapshot, rule: BUILTIN_PRIORITIZATION_RULE_V1, asOf: DISCOVERY_NOW });
    expect(assessment.disposition).toBe('judgment');
    expect(assessment.axes.fit).toBeNull();
    expect(snapshot.conflicts.some(c => c.kind === 'property')).toBe(true);
    expect(snapshot.validatedClaims.length).toBeGreaterThan(100);
    const sourceAddress = event.entity.property!.situs_address;
    const sourceValue = sourceAddress[field as keyof typeof sourceAddress];
    const sourceClaim = snapshot.validatedClaims.find(c => c.refs.some(r => r.kind === 'source'
      && r.sourceEventId === owner.sourceEventId && r.field === `entity.property.situs_address.${field}`))!;
    expect(sourceClaim).toMatchObject({ value: sourceValue, certainty: 'fact', refs: [{ kind: 'source',
      sourceEventId: owner.sourceEventId, field: `entity.property.situs_address.${field}`, observedAt: event.observed_at }] });
    expect(validateDiscoveryClaim({ snapshot, claim: sourceClaim })).toBe(true);
    expect(validateDiscoveryClaim({ snapshot, claim: { ...sourceClaim, value: storedValue } })).toBe(false);
    expect(snapshot.conflicts.some(c => c.claimIds.includes(sourceClaim.id))).toBe(true);
    expect(snapshot.claims).toContainEqual(sourceClaim);
    expect(assessment.claims).toContainEqual(sourceClaim);
    const storedClaim = snapshot.claims.find(c => c.value === storedValue)!;
    expect(storedClaim).toMatchObject({ certainty: 'unknown', refs: [] });
    expect(validateDiscoveryClaim({ snapshot, claim: storedClaim })).toBe(false);
    expect(assessment.claims).toContainEqual(storedClaim);
    expect(f.database.raw.prepare('SELECT * FROM properties ORDER BY id').all()).toEqual(rows);
    expect(f.database.raw.prepare('SELECT * FROM source_events ORDER BY id').all()).toEqual(sources);
    expect(f.database.raw.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
  });

  it('refuses ambiguous linked parcel identifiers rather than choosing one exact civic match', () => {
    const owner = seedDiscoveryOwner(f, { prefix: 'duplicate-parcel', units: 10 });
    const property = f.services.identities.listPropertiesForProspect(owner.prospectId)[0]!;
    f.services.unitOfWork.immediate(() => {
      const duplicate = f.services.identities.createProperty({ addressLine1: 'Another St', locality: property.locality,
        region: property.region, countryCode: property.countryCode, sourceRecord: property.sourceRecord });
      f.services.identities.linkProperty({ prospectId: owner.prospectId, propertyId: duplicate.id });
    });
    const snapshot = collect(owner.prospectId);
    expect(snapshot.properties).toEqual([]);
    expect(snapshot.conflicts.some(c => c.kind === 'ownership')).toBe(true);
  });

  it('does not globally match an unrelated source parcel to an unlinked property', () => {
    const owner = seedDiscoveryOwner(f, { prefix: 'unlinked-parcel', units: 10 });
    const event = structuredClone(f.services.sourceRepository.getById(owner.sourceEventId)!.sourceRecord.cloudSourceEvent) as CloudSourceEvent;
    event.entity.property!.parcel_id = 'UNLINKED-PARCEL'; event.entity.property!.situs_address.line1 = 'Unlinked St';
    event.entity.property!.unit_count = 99;
    f.services.unitOfWork.immediate(() => f.services.identities.createProperty({ addressLine1: 'Different Stored St', locality: 'Providence',
      region: 'RI', countryCode: 'US', sourceRecord: { parcelId: 'UNLINKED-PARCEL' } }));
    append(owner, event, 'unlinked-source');
    const snapshot = collect(owner.prospectId);
    expect(snapshot.conflicts).toEqual([]);
    expect(snapshot.properties).toHaveLength(1);
    expect(snapshot.properties[0]?.doorCount).toBe(10);
    expect(snapshot.validatedClaims.some(c => c.refs.some(r => r.kind === 'source' && r.sourceEventId === 'unlinked-source'))).toBe(false);
  });

  it('does not invent a missing property attachment or support from a verified timestamp', () => {
    const event = validParcelEvent(); event.entity.property!.situs_address.locality = null;
    const owner = intake(event);
    expect(collect(owner.prospectId).properties).toEqual([]);
    f.services.unitOfWork.immediate(() => {
      const p = f.services.identities.createProperty({ addressLine1: 'Unproven St', locality: 'Providence', region: 'RI', countryCode: 'US', doorCount: 80, verifiedAt: DISCOVERY_NOW });
      f.services.identities.linkProperty({ prospectId: owner.prospectId, propertyId: p.id });
    });
    expect(collect(owner.prospectId).properties).toEqual([]);
  });

  it('bounds full evidence to 1 MiB with a retryable research diagnostic, never identity conflict', () => {
    const owner = seedDiscoveryOwner(f, { prefix: 'large', units: 10 });
    f.services.sources.appendSourceInteraction({ id: 'large-source', personId: owner.personId, channel: 'parcel', observedAt: DISCOVERY_NOW, sourceRecord: { raw: 'x'.repeat(1024 * 1024) } });
    try { collect(owner.prospectId); throw new Error('Expected diagnostic'); } catch (error) {
      expect(error).toBeInstanceOf(DiscoveryEvidenceDiagnosticError);
      expect(error).toMatchObject({ code: 'evidence_too_large', retryable: true, disposition: 'research' });
    }
  });
});
