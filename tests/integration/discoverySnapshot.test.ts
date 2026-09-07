import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, closeDatabase } from '../../src/main/db/database';
import { createDomainServices } from '../../src/main/domain/createDomainServices';
import { FOUNDER_CHANNEL_POLICIES_V1 } from '../../src/main/domain/cadence/cadenceScheduler';
import { attachTranscript } from '../../src/main/domain/conversations/conversationsDomain';
import { DiscoveryReadService } from '../../src/main/domain/discovery/discoveryReadService';
import { collectDiscoveryEvidence } from '../../src/main/domain/discovery/discoveryEvidence';
import { evaluateDiscovery, selectDiscoveryCandidates } from '../../src/main/domain/discovery/discoveryPolicy';
import { resolveLocalDayInterval } from '../../src/main/domain/today/todayOrdering';
import { DEFAULT_TODAY_CAPACITY } from '../../src/main/domain/today/todayTypes';
import { discoveryAssessmentSchema, type DiscoveryAssessment } from '../../src/shared/contracts/discoveryContract';
import { createDiscoveryDatabase, seedDiscoveryOwner, DISCOVERY_NOW, type DiscoveryDatabase } from '../fixtures/discoveryDatabase';
import { cloudSourceEventSchema } from '../../src/shared/contracts/cloudSourceEventContract';
import { validFrboEvent } from '../fixtures/cloudSourceEvents';
import { insertOpenCycleWithAction, seedProspect } from '../fixtures/domainRows';

let f: DiscoveryDatabase;
let now: string;
beforeEach(async () => {
  f = await createDiscoveryDatabase(); now = DISCOVERY_NOW;
  f.services = createDomainServices({ database: f.database, clock: { now: () => now }, ids: { next: randomUUID } });
});
afterEach(() => { vi.restoreAllMocks(); f.close(); });
type Owner = ReturnType<typeof seedDiscoveryOwner>;
function owner(prefix: string, units: number | null = 10): Owner { return seedDiscoveryOwner(f, { prefix, units }); }
function assess(o: Owner, overrides: Partial<DiscoveryAssessment> = {}) {
  return f.services.unitOfWork.immediate(() => {
    const snapshot = collectDiscoveryEvidence({ database: f.database, services: f.services, prospectId: o.prospectId, asOf: now });
    const rule = f.services.prioritizationRepository.getActiveRuleVersion()!;
    const value = discoveryAssessmentSchema.parse({ ...evaluateDiscovery({ snapshot, rule: rule.document, asOf: now }), id: randomUUID(),
      modelVersion: null, evaluatedAt: now, expiresAt: '2026-09-08T12:00:00.000Z',
      localDate: resolveLocalDayInterval({ generatedAt: now, timezone: f.services.workspaceSettings.read().timezone }).localDate,
      overrideId: f.services.discoveryRepository.getLatestOverride(o.prospectId)?.id ?? null, ...overrides });
    f.services.discoveryRepository.appendAssessment(value); f.services.discoveryRepository.setCurrent(o.prospectId, value.id);
    return value;
  });
}
function selectedBusinessRows() {
  // Every user table, including identities, sources, consent, transcripts, jobs, discovery and SQLite revision.
  const tables = f.database.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return { tables: Object.fromEntries(tables.map(({ name }) => [name,
    f.database.raw.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all().map(row => JSON.stringify(row)).sort()])),
  revision: f.database.raw.prepare('SELECT total_changes() AS n').get() };
}
function override(o: Owner, a: DiscoveryAssessment, decision: 'watch' | 'exclude' | 'reconsider') {
  const commandId = randomUUID();
  f.services.unitOfWork.immediate(() => f.services.discoveryRepository.appendOverride({ commandId, personId: o.personId,
    assessmentId: a.id, expectedFingerprint: a.fingerprint, decision, reason: 'Founder decision', createdAt: now }));
  return commandId;
}
function statement(o: Owner, id: string, text: string) {
  f.services.unitOfWork.immediate(() => f.services.events.appendActivity({ id, personId: o.personId, prospectId: o.prospectId,
    salesCycleId: o.salesCycleId, kind: 'call', direction: 'inbound', channel: 'call', occurredAt: now, observedOutcome: 'spoke' }));
  const ids = [`${id}-consent`, `${id}-transcript`, `${id}-utterance`];
  attachTranscript({ database: f.database, clock: { now: () => now }, ids: { next: () => ids.shift()! } },
    { activityId: id, personId: o.personId, rawText: `Lead: ${text}` });
}
function setStage(o: Owner, stage: 'contacted' | 'interviewed' | 'offered') {
  const id = `${o.salesCycleId}-follow-up`;
  f.database.raw.prepare("INSERT OR IGNORE INTO next_actions (id, sales_cycle_id, action_type, status, timezone, work_intent, created_at) VALUES (?, ?, 'follow_up', 'pending', 'America/New_York', 'promised_follow_up', ?)").run(id, o.salesCycleId, now);
  f.database.raw.prepare('UPDATE sales_cycles SET stage = ?, current_next_action_id = ?, version = version + 1 WHERE id = ?').run(stage, id, o.salesCycleId);
}
const todayInput = { timezone: 'America/New_York', capacity: DEFAULT_TODAY_CAPACITY, channelPolicies: FOUNDER_CHANNEL_POLICIES_V1 };

describe('encrypted read-only discovery composition', () => {
  it('reports an unfinished durable scan page as running even between completed job batches', () => {
    const o = owner('cursor-progress');
    f.services.unitOfWork.immediate(() => f.services.discoveryRepository.writeScanCursor(o.prospectId));
    const before = selectedBusinessRows();
    expect(f.services.discoveryRead.get().processing).toBe('running');
    expect(selectedBusinessRows()).toEqual(before);
  });

  it('reports actual owned queued work and does not hide an older failure behind a newer success', () => {
    owner('actual-jobs');
    const jobs = f.services.jobs;
    const queued = jobs.enqueue({ type: 'discovery_assessment', payload: {}, at: now });
    expect(f.services.discoveryRead.get().processing).toBe('running');
    jobs.start(queued.id); jobs.fail(queued.id, { code: 'invalid_evidence', message: 'Synthetic invalid evidence' });
    const newer = jobs.enqueue({ type: 'priority_projection_rebuild_v1', payload: {}, at: '2026-09-06T12:00:01.000Z' });
    jobs.start(newer.id); jobs.succeed(newer.id, {});
    const before = selectedBusinessRows();
    expect(f.services.discoveryRead.get().processing).toBe('error');
    expect(selectedBusinessRows()).toEqual(before);
  });
  it('composes an idle Not assessed read without writes, jobs or capability claims', () => {
    const o = owner('pending'); const before = selectedBusinessRows();
    expect(f.services.discoveryRead).toBeDefined();
    expect(f.services.discoveryRead.get()).toMatchObject({ prepared: [], judgment: [], counts: { unassessed: 1, research: 0, watch: 0, excluded: 0 }, processing: 'idle', researchCapability: 'not_configured' });
    expect(f.services.discoveryRead.getBrief(o.personId)).toMatchObject({ personId: o.personId, salesCycleId: o.salesCycleId, assessment: null, stale: false, pilotNextStep: null });
    expect(selectedBusinessRows()).toEqual(before);
  });

  it('ranks 40 owners independently of pointer insertion order with exploration, stale, conflict and founder gates', () => {
    const owners = Array.from({ length: 40 }, (_, i) => owner(`owner-${i}`, i >= 38 ? null : 10));
    f.database.raw.prepare('UPDATE properties SET door_count = 99 WHERE id = ?').run(f.services.identities.listPropertiesForProspect(owners[0]!.prospectId)[0]!.id);
    const assessments = owners.map((o, i) => assess(o, i === 1 ? { evaluatedAt: '2026-09-05T12:00:00.000Z', expiresAt: now } : {}));
    override(owners[2]!, assessments[2]!, 'watch'); assess(owners[2]!);
    const before = selectedBusinessRows();
    const first = f.services.discoveryRead.get();
    expect(first.revision).toBe((before.revision as { n: number }).n);
    expect(first.prepared).toHaveLength(10);
    expect(first.prepared.filter(b => b.assessment?.axes.fit === null)).toHaveLength(2);
    expect(new Set(first.prepared.map(b => b.personId)).size).toBe(10);
    expect(first.prepared.map(b => b.personId)).not.toContain(owners[1]!.personId);
    expect(first.prepared.map(b => b.personId)).not.toContain(owners[2]!.personId);
    expect(first.judgment.map(b => b.personId)).toEqual([owners[0]!.personId]);
    expect(first.counts).toMatchObject({ unassessed: 1, watch: 1 });
    expect(f.services.discoveryRead.getBrief(owners[1]!.personId).stale).toBe(true);
    expect(f.services.discoveryRead.get()).toEqual(first);
    expect(selectedBusinessRows()).toEqual(before);
    // Reinsert the actual immutable pointers in reverse order, not new random identities.
    const pointers = f.database.raw.prepare('SELECT * FROM discovery_current ORDER BY rowid DESC').all() as { prospect_id: string; assessment_id: string; version: number }[];
    f.database.raw.prepare('DELETE FROM discovery_current').run();
    for (const p of pointers) f.database.raw.prepare('INSERT INTO discovery_current VALUES (?, ?, ?)').run(p.prospect_id, p.assessment_id, p.version);
    expect(f.services.discoveryRead.get().prepared).toEqual(first.prepared);
  });

  it('globally ranks before the 50-check bound and does not starve exploration behind 60 primaries', () => {
    const owners = Array.from({ length: 60 }, (_, i) => owner(`primary-${i}`));
    const winner = [...owners].sort((a, b) => a.prospectId < b.prospectId ? -1 : 1).at(-1)!;
    // A canonical direct contact outranks all otherwise equal primaries, even at the LAST prospect ID.
    f.database.raw.prepare("INSERT INTO person_contact_methods (id, person_id, kind, normalized_value, validation_state, reachability, is_primary, created_at, updated_at) VALUES ('rank-phone', ?, 'phone', '+14015554002', 'valid', 'direct', 1, ?, ?)").run(winner.personId, now, now);
    const rows = owners.map(o => assess(o));
    const exploratory = [assess(owner('explore-a', null)), assess(owner('explore-b', null))];
    const spy = vi.spyOn(f.services.prioritizationRepository, 'loadQualificationInputs');
    const before = selectedBusinessRows(); const result = f.services.discoveryRead.get();
    expect(result.prepared[0]?.personId).toBe(winner.personId);
    expect(result.prepared.map(b => b.assessment!.id)).toEqual(selectDiscoveryCandidates({ assessments: [...rows, ...exploratory], limit: 10 }).map(a => a.id));
    expect(result.prepared.filter(b => b.assessment!.axes.fit === null)).toHaveLength(2);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(50);
    expect(result.counts.unassessed).toBeGreaterThanOrEqual(12);
    expect(selectedBusinessRows()).toEqual(before);
  });

  it('shares one 50-snapshot budget with judgment and reports stale/unverified remainder as pending', () => {
    for (let i = 0; i < 70; i++) {
      const o = owner(`budget-${i}`);
      if (i < 25) f.database.raw.prepare('UPDATE properties SET door_count = 99 WHERE id = ?').run(f.services.identities.listPropertiesForProspect(o.prospectId)[0]!.id);
      assess(o);
      if (i >= 25) f.database.raw.prepare('UPDATE persons SET version = version + 1 WHERE id = ?').run(o.personId);
    }
    const spy = vi.spyOn(f.services.prioritizationRepository, 'loadQualificationInputs');
    const result = f.services.discoveryRead.get();
    expect(spy.mock.calls.length).toBeLessThanOrEqual(50);
    expect(result.prepared).toEqual([]);
    expect(result.judgment.length).toBeLessThanOrEqual(20);
    expect(result.judgment.length).toBeGreaterThan(0);
    expect(result.counts.unassessed).toBeGreaterThanOrEqual(45);
    expect(result.processing).toBe('idle');
  });

  it.each(['date', 'expiry', 'trigger-expiry', 'rule', 'fingerprint', 'override'])('rejects stale %s independently of collector admission caches', reason => {
    const o = owner(`stale-${reason}`);
    if (reason === 'trigger-expiry') {
      const event = validFrboEvent(); event.signal_flags.vacancy = true; const property = f.services.identities.listPropertiesForProspect(o.prospectId)[0]!;
      event.entity.person = { full_name: f.services.identities.getPerson(o.personId)!.displayName, org_names: [], phones: [], emails: [], mailing_address: null };
      event.entity.property!.situs_address = { line1: property.addressLine1, locality: property.locality, region: property.region.toUpperCase(), country_code: property.countryCode.toUpperCase(), postal_code: property.postalCode };
      event.entity.property!.parcel_id = null; event.entity.property!.unit_count = 10;
      f.services.sources.appendSourceInteraction({ id: 'expiry-frbo', personId: o.personId, prospectId: o.prospectId,
        channel: 'frbo', observedAt: event.observed_at, sourceRecord: { cloudSourceEvent: cloudSourceEventSchema.parse(event) } });
      f.services.unitOfWork.immediate(() => {
        const snapshot = collectDiscoveryEvidence({ database: f.database, services: f.services, prospectId: o.prospectId, asOf: now });
        expect(snapshot.triggers).toHaveLength(1);
        const trigger = snapshot.triggers[0]!;
        f.services.prioritization.scopedWriter().recordTriggerEvent({ id: trigger.id, prospectId: o.prospectId,
          triggerType: trigger.triggerType, effectiveAt: trigger.effectiveAt, sourceExpiresAt: '2026-09-06T12:30:00.000Z',
          strengthMultiplier: 1, verificationState: trigger.verificationState,
          evidence: { ...trigger.evidence, evidenceRefs: [trigger.evidence.evidenceRefs[0]!] } });
      });
    }
    const a = assess(o);
    if (reason === 'date') now = '2026-09-07T05:00:00.000Z';
    if (reason === 'expiry') now = a.expiresAt;
    if (reason === 'trigger-expiry') now = '2026-09-06T12:30:00.000Z';
    if (reason === 'fingerprint') f.database.raw.prepare('UPDATE persons SET version = version + 1 WHERE id = ?').run(o.personId);
    if (reason === 'override') override(o, a, 'exclude');
    if (reason === 'rule') f.services.unitOfWork.immediate(() => {
      const rule = f.services.prioritizationRepository.getActiveRuleVersion()!;
      f.services.prioritizationRepository.installRuleVersion({ ...rule.document, id: 'discovery-test-rule-v2', version: 2 });
      f.services.prioritizationRepository.activateRuleVersion({ ruleVersionId: 'discovery-test-rule-v2', expectedActiveRuleVersionId: rule.id });
    });
    const before = selectedBusinessRows();
    expect(f.services.discoveryRead.get().prepared).toEqual([]);
    expect(f.services.discoveryRead.get().counts.unassessed).toBe(1);
    expect(f.services.discoveryRead.getBrief(o.personId).stale).toBe(true);
    expect(selectedBusinessRows()).toEqual(before);
  });

  it('shows override provenance against fresh evidence, not just the persisted current fingerprint', () => {
    const o = owner('override'); const a = assess(o); const id = override(o, a, 'watch'); assess(o);
    expect(f.services.discoveryRead.get().counts.watch).toBe(1);
    expect(f.services.discoveryRead.getBrief(o.personId).latestOverride).toMatchObject({ id, evidenceChanged: false });
    f.database.raw.prepare('UPDATE persons SET version = version + 1 WHERE id = ?').run(o.personId);
    expect(f.services.discoveryRead.getBrief(o.personId)).toMatchObject({ stale: true, latestOverride: { id, evidenceChanged: true } });
    assess(o);
    expect(f.services.discoveryRead.get().prepared.map(b => b.personId)).toEqual([o.personId]);
  });

  it('preserves Today calculation and transaction ownership, counts completed and queued dials exactly once', () => {
    for (let i = 0; i < 12; i++) assess(owner(`capacity-${i}`));
    const promise = seedProspect(f.database.raw, 'promise');
    const due = insertOpenCycleWithAction({ database: f.database.raw, prefix: 'promise', prospect: promise });
    const prospect = seedProspect(f.database.raw, 'queued');
    const work = { cycleId: 'queued-cycle', actionId: 'queued-call-action' };
    f.services.unitOfWork.immediate(() => {
    f.database.raw.prepare("INSERT INTO sales_cycles (id, person_id, prospect_id, entry_source_event_id, stage, workflow_status, current_next_action_id, stage_entered_at, version, created_at, updated_at) VALUES (?, ?, ?, ?, 'ready', 'active', ?, ?, 1, ?, ?)").run(work.cycleId, prospect.personId, prospect.prospectId, prospect.sourceEventId, work.actionId, now, now, now);
    f.database.raw.prepare("INSERT INTO next_actions (id, sales_cycle_id, action_type, channel, status, timezone, work_intent, created_at) VALUES (?, ?, 'call', 'phone', 'pending', 'America/New_York', 'discretionary_prospecting', ?)").run(work.actionId, work.cycleId, now);
    });
    f.database.raw.prepare("INSERT INTO person_contact_methods (id, person_id, kind, normalized_value, validation_state, reachability, is_primary, created_at, updated_at) VALUES ('queued-phone', ?, 'phone', '+14015554001', 'valid', 'direct', 1, ?, ?)").run(prospect.personId, now, now);
    f.services.prioritization.recalculateProspect({ evaluationId: 'queued-eval', prospectId: prospect.prospectId, ruleVersionId: 'founder-priority-v1', evaluatedAt: now, expectedProjectionVersion: null });
    f.services.unitOfWork.immediate(() => f.services.events.appendActivity({ id: 'completed', personId: prospect.personId, prospectId: prospect.prospectId,
      salesCycleId: work.cycleId, kind: 'call', direction: 'outbound', channel: 'phone', occurredAt: now,
      metadata: { todaySelectedCallReceipt: { version: 1, kind: 'discretionary_call', currentActionId: work.actionId, queueGeneratedAt: now, queueTimezone: 'America/New_York', queueLocalDate: '2026-09-06' } } }));
    f.database.raw.prepare('UPDATE workspace_settings SET daily_dial_capacity = 7').run();
    const input = { ...todayInput, capacity: { ...DEFAULT_TODAY_CAPACITY, dialBudget: 7 } };
    const before = f.services.today.build(input);
    expect(before.completedDiscretionaryDialCount).toBe(1);
    expect(before.queuedDiscretionaryDialCount).toBe(1);
    expect(before.remainingDiscretionaryDialCount).toBe(5);
    expect(() => f.services.today.buildInCurrentSnapshot({ ...input, generatedAt: now })).toThrow();
    expect(() => f.services.discoveryRead.remainingCapacityInScope(now)).toThrow();
    f.database.raw.exec('BEGIN');
    try {
      expect(f.services.today.buildInCurrentSnapshot({ ...input, generatedAt: now })).toEqual(before);
      expect(f.services.discoveryRead.remainingCapacityInScope(now)).toBe(5);
      expect(() => f.services.discoveryRead.get()).toThrow('DISCOVERY_READ_SCOPE_REQUIRED');
      expect(() => f.services.discoveryRead.getBrief(promise.personId)).toThrow('DISCOVERY_READ_SCOPE_REQUIRED');
      expect(f.database.raw.inTransaction).toBe(true);
    } finally { f.database.raw.exec('ROLLBACK'); }
    expect(f.services.discoveryRead.get().prepared).toHaveLength(5);
    expect(f.services.today.build(input)).toEqual(before);
    expect(before.lanes.flatMap(l => l.items).map(i => i.cycleId)).toContain(due.cycleId);
    f.database.raw.prepare('UPDATE workspace_settings SET daily_dial_capacity = 0').run();
    expect(f.services.discoveryRead.get().prepared).toEqual([]);
  });

  it('pins capacity and evidence to one encrypted read snapshot despite an independent writer', () => {
    for (let i = 0; i < 12; i++) assess(owner(`coherent-${i}`));
    const other = openDatabase({ path: f.temp.path, key: f.key });
    const read = f.services.workspaceSettings.read.bind(f.services.workspaceSettings);
    vi.spyOn(f.services.workspaceSettings, 'read').mockImplementationOnce(() => {
      const settings = read(); other.raw.prepare('UPDATE workspace_settings SET daily_dial_capacity = 0').run(); return settings;
    });
    try {
      expect(f.services.discoveryRead.get().prepared).toHaveLength(10);
      expect(f.services.discoveryRead.get().prepared).toEqual([]);
    } finally { closeDatabase(other); }
  });

  it('derives pilot questions only from current-cycle unamended accepted conversations and actual follow-up', () => {
    const o = owner('conversation'); setStage(o, 'contacted'); assess(o);
    expect(f.services.discoveryRead.getBrief(o.personId).pilotNextStep).toBeNull();
    statement(o, 'buyer-call', 'I self-manage conversation hope st.'); assess(o);
    expect(f.services.discoveryRead.getBrief(o.personId).pilotNextStep).toMatchObject({ label: expect.stringMatching(/discovery conversation/i), activityIds: ['buyer-call'] });
    setStage(o, 'interviewed'); assess(o);
    expect(f.services.discoveryRead.getBrief(o.personId).pilotNextStep).toMatchObject({ label: expect.stringMatching(/discuss.*supervised trial/i), activityIds: ['buyer-call'] });
    setStage(o, 'offered');
    f.database.raw.prepare("INSERT INTO next_actions (id, sales_cycle_id, action_type, status, timezone, work_intent, created_at) VALUES ('offer-follow-up', ?, 'follow_up', 'pending', 'America/New_York', 'promised_follow_up', ?)").run(o.salesCycleId, now);
    f.database.raw.prepare("UPDATE sales_cycles SET current_next_action_id = 'offer-follow-up' WHERE id = ?").run(o.salesCycleId); assess(o);
    expect(f.services.discoveryRead.getBrief(o.personId).pilotNextStep).toMatchObject({ label: expect.stringContaining(`Existing follow up (recorded ${now})`) });
    f.services.unitOfWork.immediate(() => f.services.events.appendActivityAmendment({ activityId: 'buyer-call', amendmentKind: 'marked_in_error', correction: {}, reason: 'Incorrect transcript' }));
    const stale = f.services.discoveryRead.getBrief(o.personId);
    expect(stale.stale).toBe(true); expect(stale.pilotNextStep).toBeNull();
    expect(stale.assessment?.claims.some(c => c.refs.some(r => r.kind === 'utterance'))).toBe(false);
    assess(o); expect(f.services.discoveryRead.getBrief(o.personId).pilotNextStep).toBeNull();
  });

  it('does not promote old-cycle statements or malformed transcript quotes to current buyer intent', () => {
    const o = owner('old');
    // Rebind a real historical conversation to a closed historical cycle while retaining the current owner graph.
    const oldCycleId = 'old-closed-cycle';
    f.database.raw.prepare("INSERT INTO sales_cycles (id, person_id, prospect_id, entry_source_event_id, stage, workflow_status, stage_entered_at, close_reason, closed_at, version, created_at, updated_at) VALUES (?, ?, ?, ?, 'lost_nurture', 'closed', ?, 'no_response', ?, 1, ?, ?)").run(oldCycleId, o.personId, o.prospectId, o.sourceEventId, now, now, now, now);
    statement({ ...o, salesCycleId: oldCycleId }, 'old-call', 'I self-manage old hope st.');
    setStage(o, 'interviewed'); assess(o);
    expect(f.services.discoveryRead.getBrief(o.personId).pilotNextStep).toBeNull();
    statement(o, 'current-call', 'I self-manage old hope st.'); assess(o);
    // Deliberate on-disk corruption, never a supported writer operation.
    f.database.raw.exec('DROP TRIGGER immutable_transcript_utterances');
    f.database.raw.prepare("UPDATE transcript_utterances SET text = 'Fabricated paid intent' WHERE id = 'current-call-utterance'").run();
    const brief = f.services.discoveryRead.getBrief(o.personId);
    expect(brief.pilotNextStep).toBeNull();
    expect(JSON.stringify(brief)).not.toContain('Fabricated paid intent');
  });

  it('keeps oversized evidence visible as research/pending and propagates unrelated stored corruption with rollback', () => {
    const o = owner('oversize'); assess(o);
    f.services.unitOfWork.immediate(() => f.services.events.appendActivity({ personId: o.personId, prospectId: o.prospectId,
      salesCycleId: o.salesCycleId, kind: 'note', direction: 'internal', channel: 'note', metadata: { synthetic: 'x'.repeat(1_050_000) } }));
    expect(f.services.discoveryRead.get()).toMatchObject({ prepared: [], judgment: [], counts: { unassessed: 1, research: 1 } });
    expect(f.services.discoveryRead.getBrief(o.personId).stale).toBe(true);
    expect(f.database.raw.inTransaction).toBe(false);
    f.database.raw.prepare("UPDATE workspace_settings SET timezone = 'Not/A_Zone'").run();
    expect(() => f.services.discoveryRead.get()).toThrow();
    expect(f.database.raw.inTransaction).toBe(false);
  });

  it('uses durable discovery job state only and never enqueues on reads', () => {
    owner('jobs'); const jobs = f.services.jobs;
    const unrelated = jobs.enqueue({ type: 'other', payload: {}, at: now }); jobs.start(unrelated.id);
    expect(f.services.discoveryRead.get().processing).toBe('idle');
    const j = jobs.enqueue({ type: 'discovery_assessment', payload: {}, at: now });
    expect(f.services.discoveryRead.get().processing).toBe('running');
    jobs.start(j.id); expect(f.services.discoveryRead.get().processing).toBe('running');
    jobs.fail(j.id, { code: 'test_error', message: 'Synthetic failure' });
    expect(f.services.discoveryRead.get().processing).toBe('error');
    jobs.retryFailed(j.id, now); jobs.start(j.id); jobs.succeed(j.id, {});
    now = '2026-09-06T12:00:01.000Z';
    const paused = jobs.enqueue({ type: 'discovery_assessment', payload: {}, at: now });
    jobs.cancel(paused.id); expect(f.services.discoveryRead.get().processing).toBe('paused');
    now = '2026-09-06T12:00:02.000Z';
    const succeeded = jobs.enqueue({ type: 'discovery_assessment', payload: {}, at: now });
    jobs.start(succeeded.id); jobs.succeed(succeeded.id, {});
    expect(f.services.discoveryRead.get().processing).toBe('idle');
    const before = selectedBusinessRows(); f.services.discoveryRead.get(); expect(selectedBusinessRows()).toEqual(before);
  });
});


describe('discovery admission and integrity boundaries', () => {
  it.each(['watch', 'exclude'] as const)('does not suggest a new pilot step through a founder %s decision', decision => {
    const o = owner(`pilot-${decision}`); setStage(o, 'contacted');
    statement(o, 'suppressed-conversation', 'We spoke about property maintenance.');
    const a = assess(o); override(o, a, decision); assess(o);
    expect(f.services.discoveryRead.getBrief(o.personId).pilotNextStep).toBeNull();
  });

  it('rejects a substituted Today graph rather than reading capacity from another UOW', () => {
    const other = createDomainServices({ database: f.database, clock: { now: () => now }, ids: { next: randomUUID } });
    expect(() => new DiscoveryReadService({ database: f.database, unitOfWork: f.services.unitOfWork,
      clock: { now: () => now }, services: { ...f.services, today: other.today } })).toThrow();
  });

  it('keeps actual opt-outs excluded, stale results pending, and discovery exclusion separate from lifecycle', () => {
    const blocked = owner('optout'); assess(blocked);
    f.services.optOut.apply({ personId: blocked.personId, tombstoneId: 'optout-tombstone', requestedAt: now,
      policyVersion: 'founder_opt_out_v1', decision: { kind: 'founder_confirmed', channel: 'manual' },
      terminalStageEventId: 'optout-terminal', evidence: { kind: 'append_activity', activity: {
        id: 'optout-evidence', personId: blocked.personId, kind: 'note', direction: 'internal', channel: 'manual',
        occurredAt: now, observedOutcome: 'opted_out', metadata: {},
      } } });
    expect(f.services.discoveryRead.get()).toMatchObject({ prepared: [], counts: { unassessed: 1 } });
    assess(blocked);
    const excluded = owner('excluded'); const a = assess(excluded); override(excluded, a, 'exclude'); assess(excluded);
    const before = selectedBusinessRows();
    expect(f.services.discoveryRead.get()).toMatchObject({ prepared: [], counts: { unassessed: 0, excluded: 2 } });
    expect(f.services.discoveryRead.getBrief(excluded.personId).latestOverride?.decision).toBe('exclude');
    expect(f.services.identities.getCanonicalProspect(excluded.personId)?.qualificationState).toBe('unreviewed');
    expect(selectedBusinessRows()).toEqual(before);
  });

  it('counts actual research, stale judgment and missing assessments without asserting all work is done', () => {
    const research = owner('research');
    f.database.raw.prepare('UPDATE persons SET display_name = ? WHERE id = ?').run('Unresolved different name', research.personId);
    // An unsupported but schema-valid source owner mismatch is an identity judgment.
    const judgment = assess(research); expect(judgment.disposition).toBe('judgment');
    const missing = seedProspect(f.database.raw, 'unsupported-source');
    const cycle = insertOpenCycleWithAction({ database: f.database.raw, prefix: 'unsupported-source', prospect: missing });
    const researchAssessment = assess({ ...missing, salesCycleId: cycle.cycleId });
    expect(researchAssessment.disposition).toBe('research');
    owner('not-assessed');
    const first = f.services.discoveryRead.get();
    expect(first.counts).toEqual({ unassessed: 1, research: 1, watch: 0, excluded: 0 });
    expect(first.judgment).toHaveLength(1);
    now = '2026-09-07T05:00:00.000Z';
    const next = f.services.discoveryRead.get();
    expect(next.judgment).toEqual([]); expect(next.counts.unassessed).toBe(3); expect(next.counts.research).toBe(0);
  });

  it('keeps policy-local dates tied to workspace timezone and rejects future evaluation timestamps', () => {
    const o = owner('localdate'); assess(o);
    now = '2026-09-07T03:59:59.999Z';
    expect(f.services.discoveryRead.get().prepared).toHaveLength(1);
    now = '2026-09-07T04:00:00.000Z';
    expect(f.services.discoveryRead.get().prepared).toEqual([]);
    now = DISCOVERY_NOW; assess(o, { evaluatedAt: '2026-09-06T13:00:00.000Z' });
    expect(f.services.discoveryRead.get().prepared).toEqual([]);
    expect(f.services.discoveryRead.getBrief(o.personId).stale).toBe(true);
  });

  it('propagates malformed immutable assessment JSON instead of hiding corruption as empty research', () => {
    const o = owner('corrupt'); const a = assess(o);
    f.database.raw.exec('DROP TRIGGER discovery_assessments_no_update');
    const json = { ...a, ranking: { ...a.ranking, dataConfidence: 'not a number' } };
    f.database.raw.prepare('UPDATE discovery_assessments SET assessment_json = ? WHERE id = ?').run(JSON.stringify(json), a.id);
    const before = selectedBusinessRows();
    expect(() => f.services.discoveryRead.get()).toThrow('Discovery storage is corrupt');
    expect(() => f.services.discoveryRead.getBrief(o.personId)).toThrow('Discovery storage is corrupt');
    expect(f.database.raw.inTransaction).toBe(false); expect(selectedBusinessRows()).toEqual(before);
  });

  it('rolls back failed getters but never closes the caller transaction, including the scoped helper failure', () => {
    expect(() => f.services.discoveryRead.getBrief('missing')).toThrow('DISCOVERY_PERSON_NOT_FOUND');
    expect(f.database.raw.inTransaction).toBe(false);
    f.database.raw.exec('BEGIN');
    try {
      expect(() => f.services.today.buildInCurrentSnapshot({ ...todayInput, generatedAt: 'invalid' })).toThrow();
      expect(f.database.raw.inTransaction).toBe(true);
    } finally { f.database.raw.exec('ROLLBACK'); }
  });
});
