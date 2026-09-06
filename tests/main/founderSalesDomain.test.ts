import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contactSnapshot } from '../../src/main/communications/contactSnapshot';
import { createOutboundCommandService } from '../../src/main/communications/outboundCommandService';
import type { OutboundRequest, OutboundReason, HandoffResult } from '../../src/shared/contracts/outboundContract';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import { DomainRepositoryDatabaseMismatchError } from '../../src/main/domain/support/domainErrors';

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

describe('FounderSalesDomain', () => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let services: DomainServices;
  let clock: FixedClock;
  let domain: FounderSalesDomain;

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
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeDatabase(database);
    temp.cleanup();
  });

  function seedLead(prefix: string, stage: 'unreviewed' | 'ready' = 'unreviewed'): {
    prospect: SeededProspect;
    cycleId: string;
    actionId: string;
  } {
    const prospect = seedProspect(database.raw, prefix);
    const { cycleId, actionId } = insertOpenCycleWithAction({
      database: database.raw, prefix, prospect, stage,
    });
    return { prospect, cycleId, actionId };
  }

  const listAll = () => domain.listLeadRows({
    query: '', stages: [], priorities: [], sort: 'priority', cursor: null, limit: 50,
  });

  describe('durable outbound preparation (Task4, not live dispatch)', () => {
    function setup(prefix = 'outbound', enrolled = false): OutboundRequest {
      const prospect = seedProspect(database.raw, prefix);
      let cycleId: string;
      if (enrolled) {
        database.raw.prepare("UPDATE prospects SET qualification_state = 'unreviewed' WHERE id = ?").run(prospect.prospectId);
        cycleId = services.lifecycle.createUnreviewedCycle({
          personId: prospect.personId, prospectId: prospect.prospectId,
          entrySourceEventId: prospect.sourceEventId, effectiveAt: DOMAIN_TIMESTAMP,
        }).id;
        domain.confirmTransition({ transition: 'review_to_ready', salesCycleId: cycleId, expectedRevision: 0 });
      } else {
        cycleId = insertOpenCycleWithAction({ database: database.raw, prefix, prospect, stage: 'ready' }).cycleId;
      }
      const contact = services.unitOfWork.immediate(() => services.identities.addContactMethod({
        personId: prospect.personId, kind: 'phone', normalizedValue: '+14015550100',
        validationState: 'valid', reachability: 'direct',
      }));
      database.raw.prepare(`UPDATE person_contact_methods SET federal_status = 'verified_clear',
        compliance_tcpa_flag = 0, covered_area_code = '401', compliance_source = 'ftc_download',
        scrubbed_at = '2026-08-15T00:00:00.000Z', compliance_expires_at = '2026-09-15T00:00:00.000Z'
        WHERE id = ?`).run(contact.id);
      database.raw.prepare(`INSERT INTO person_outbound_jurisdictions
        (person_id, region_code, timezone, source, effective_at, updated_at)
        VALUES (?, 'RI', 'America/New_York', 'manual_review', ?, ?)`)
        .run(prospect.personId, CLOCK_NOW, CLOCK_NOW);
      database.raw.prepare(`INSERT OR REPLACE INTO outbound_jurisdiction_clearances
        (region_code, channel, decision, registration_confirmed, state_dnc_subscription_confirmed,
         consent_rule_confirmed, source, effective_at, expires_at, updated_at)
        VALUES ('RI', 'call', 'allowed', 1, 1, 1, 'test',
          '2026-08-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', ?)`)
        .run(CLOCK_NOW);
      return { commandId: '00000000-0000-4000-8000-000000000001', channel: 'call',
        personId: prospect.personId, salesCycleId: cycleId, contactMethodId: contact.id,
        expectedContactSnapshot: contactSnapshot(contact) };
    }
    const facts = () => database.raw.prepare("SELECT * FROM activities WHERE adapter = 'callie_outbound_v1' ORDER BY rowid").all();
    function workflow() {
      return Object.fromEntries(['sales_cycles', 'stage_events', 'next_actions', 'cadence_enrollments',
        'cadence_action_components'].map((table) =>
        [table, database.raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    }
    const communications = () => database.raw.prepare("SELECT * FROM activities WHERE kind IN ('call','text','email') ORDER BY rowid").all();
    function expectRefusal(request: OutboundRequest, reasonCode: OutboundReason, status = 'refused') {
      const beforeWorkflow = workflow();
      const beforeCommunications = communications();
      expect(domain.prepareOutboundDispatch(request)).toMatchObject({ kind: 'receipt',
        receipt: { commandId: request.commandId, status, reasonCode } });
      expect(facts()).toHaveLength(2);
      expect(facts().map((row: { provider_idempotency_key: string }) => row.provider_idempotency_key))
        .toEqual([`${request.commandId}:requested`, `${request.commandId}:${status}`]);
      expect(workflow()).toEqual(beforeWorkflow);
      expect(communications()).toEqual(beforeCommunications);
    }

    it('disables the old MutationReceipt API with a fixed safe error and zero writes', () => {
      const request = setup();
      const before = database.raw.prepare('SELECT total_changes() AS n').get();
      expect(() => domain.beginOutbound({ channel: request.channel, personId: request.personId,
        salesCycleId: request.salesCycleId, contactMethodId: request.contactMethodId }))
        .toThrow(expect.objectContaining({ code: 'ACTION_NOT_SUPPORTED', message: 'Phone handoff is not integrated yet.' }));
      expect(database.raw.prepare('SELECT total_changes() AS n').get()).toEqual(before);
    });

    it('commits requested+dispatching under actual authorization without touching manual evidence or workflow', () => {
      const request = setup('outbound', true);
      services.unitOfWork.immediate(() => services.events.appendActivity({
        id: 'old-manual-call', personId: request.personId, salesCycleId: request.salesCycleId,
        prospectId: 'outbound-prospect', kind: 'call', direction: 'outbound', channel: 'phone',
        observedOutcome: 'no_answer', occurredAt: CLOCK_NOW, metadata: { provenance: 'manual' },
      }));
      const before = workflow();
      expect(before.cadence_enrollments).toHaveLength(1);
      const manual = communications();
      const authorize = vi.spyOn(services.outboundPermission, 'assertMayExecuteOutbound');
      const prepared = domain.prepareOutboundDispatch(request);
      expect(prepared).toEqual({ kind: 'dispatch', canonicalPhone: '+14015550100',
        mutation: { revision: expect.any(Number), affectedPersonIds: [request.personId], affectedSalesCycleIds: [request.salesCycleId] } });
      expect(authorize).toHaveBeenCalledWith({ personId: request.personId, contactMethodId: request.contactMethodId, channel: 'call', now: CLOCK_NOW });
      expect(database.raw.inTransaction).toBe(false);
      expect(facts()).toHaveLength(2);
      expect(domain.inspectOutboundCommand(request)).toMatchObject({ status: 'unknown', reasonCode: 'handoff_uncertain' });
      expect(domain.prepareOutboundDispatch(request)).toMatchObject({ kind: 'receipt', receipt: { status: 'unknown' } });
      expect(authorize).toHaveBeenCalledTimes(1);
      expect(facts()).toHaveLength(2);
      domain.recordOutboundResult(request, { status: 'handoff_accepted', reasonCode: null });
      expect(facts()).toHaveLength(3);
      expect(communications()).toEqual(manual);
      expect(workflow()).toEqual(before);
      expect(JSON.stringify(facts())).not.toContain('+14015550100');
    });

    it('rejects a facade graph with a substitute UOW before any query or clock/ID access', () => {
      const prepare = vi.spyOn(database.raw, 'prepare');
      const now = vi.spyOn(clock, 'now');
      const ids = { next: vi.fn(() => 'unused') };
      expect(() => createFounderSalesDomain({ database, clock, ids,
        services: { ...services, unitOfWork: new DomainUnitOfWork(database) } }))
        .toThrow(DomainRepositoryDatabaseMismatchError);
      expect(prepare).not.toHaveBeenCalled(); expect(now).not.toHaveBeenCalled(); expect(ids.next).not.toHaveBeenCalled();
    });

    it.each([
      ["normalized_value = '+14015550101'", 'stale_contact'],
      ["validation_state = 'invalid'", 'stale_contact'],
      ["updated_at = '2026-08-31T15:01:00.000Z'", 'stale_contact'],
      ["kind = 'email'", 'stale_contact'],
      ["compliance_expires_at = '2026-08-31T15:00:00.000Z'", 'federal_evidence_stale'],
      ["federal_status = 'listed'", 'federal_dnc_listed'],
    ] as const)('reloads changed contact evidence: %s', (set, reason) => {
      const request = setup();
      database.raw.prepare(`UPDATE person_contact_methods SET ${set} WHERE id = ?`).run(request.contactMethodId);
      expectRefusal(request, reason);
    });

    it.each([
      ["UPDATE outbound_jurisdiction_clearances SET expires_at = '2026-08-31T15:00:00.000Z'", 'jurisdiction_unknown'],
      ["UPDATE outbound_jurisdiction_clearances SET decision = 'blocked'", 'jurisdiction_blocked'],
      ["UPDATE prospects SET qualification_state = 'unreviewed'", 'cycle_not_executable'],
      ["UPDATE prospects SET qualification_state = 'merge_review'", 'cycle_not_executable'],
      ["UPDATE sales_cycles SET stage = 'unreviewed'", 'cycle_not_executable'],
    ] as const)('reloads current cycle/state evidence: %s', (sql, reason) => {
      const request = setup(); database.raw.exec(sql); expectRefusal(request, reason);
    });

    it('refuses a currently closed cycle without reopening it or settling another action', () => {
      const request = setup();
      domain.dismissLead({ salesCycleId: request.salesCycleId, personId: request.personId,
        qualificationGateReason: 'out_of_area', expectedRevision: 1 });
      expectRefusal(request, 'cycle_not_executable');
    });

    it('checks a fresh clock after current-contact reads, not the confirmation or pre-UOW time', () => {
      const request = setup();
      const original = database.raw.prepare.bind(database.raw);
      vi.spyOn(database.raw, 'prepare').mockImplementation((sql) => {
        if (sql.includes('normalized_value AS normalizedValue')) clock.set('2026-09-01T00:00:00.000Z');
        return original(sql);
      });
      expectRefusal(request, 'outside_recipient_window');
    });

    it('checks durable tombstones with the actual permission service and persists refusal without nested UOW', () => {
      const request = setup();
      const priorOwner = services.unitOfWork.immediate(() => services.identities.createPerson({ displayName: 'Prior fixture owner' }));
      services.unitOfWork.immediate(() => services.events.appendActivity({
        id: 'opt-source', personId: priorOwner.id, kind: 'system', direction: 'internal', channel: 'manual',
      }));
      database.raw.prepare(`INSERT INTO opt_out_tombstones
        (id, person_id, requested_at, observed_channel, source_activity_id, evidence_ref, policy_version, created_at)
        VALUES ('tombstone', ?, ?, 'manual', 'opt-source', 'fixture', 'founder_opt_out_v1', ?)`)
        .run(priorOwner.id, CLOCK_NOW, CLOCK_NOW);
      database.raw.prepare(`INSERT INTO opt_out_handles (id, tombstone_id, kind, normalized_value, created_at)
        VALUES ('blocked-phone', 'tombstone', 'phone', '+14015550100', ?)`).run(CLOCK_NOW);
      expectRefusal(request, 'person_or_handle_opted_out');
    });

    it.each(['deleted', 'missing-person', 'wrong-cycle', 'missing-contact', 'changed-contact-owner'])(
      'rejects %s safely with no orphan facts in either preparation or capability refusal', (kind) => {
        let request = setup();
        const other = seedLead('other', 'ready');
        if (kind === 'deleted') database.raw.prepare('UPDATE persons SET deleted_at = ? WHERE id = ?').run(CLOCK_NOW, request.personId);
        if (kind === 'missing-person') request = { ...request, personId: 'absent' };
        if (kind === 'wrong-cycle') request = { ...request, salesCycleId: other.cycleId };
        if (kind === 'missing-contact') request = { ...request, contactMethodId: 'absent' };
        if (kind === 'changed-contact-owner') database.raw.prepare('UPDATE person_contact_methods SET person_id = ? WHERE id = ?').run(other.prospect.personId, request.contactMethodId);
        const code = kind === 'deleted' || kind === 'missing-person' ? 'LEAD_NOT_FOUND'
          : kind === 'wrong-cycle' ? 'CYCLE_NOT_FOUND' : 'CONTACT_METHOD_NOT_FOUND';
        expect(() => domain.prepareOutboundDispatch(request)).toThrow(expect.objectContaining({ code }));
        expect(() => domain.recordOutboundRefusal(request, 'phone_route_unverified')).toThrow(expect.objectContaining({ code }));
        expect(facts()).toEqual([]);
      });

    it.each(['tel:+14015550100', '+14015550100\n', '+14015550100;123', '+911', '+14015550100?x', '4015550100'])(
      'refuses unsafe canonical targets even with a matching snapshot: %j', (value) => {
        const request = setup();
        database.raw.prepare('UPDATE person_contact_methods SET normalized_value = ? WHERE id = ?').run(value, request.contactMethodId);
        const current = services.identities.getContactMethod(request.contactMethodId)!;
        expectRefusal({ ...request, expectedContactSnapshot: contactSnapshot({ ...current, normalizedValue: value }) }, 'invalid_target');
      });

    it.each(['invalid', 'unverified'] as const)('refuses matching but %s contact validation', (state) => {
      const request = setup();
      database.raw.prepare('UPDATE person_contact_methods SET validation_state = ? WHERE id = ?').run(state, request.contactMethodId);
      expectRefusal({ ...request, expectedContactSnapshot: contactSnapshot(services.identities.getContactMethod(request.contactMethodId)!) }, 'contact_validation_unusable');
    });

    it.each(['phone_route_unverified', 'inbound_safety_unwired', 'channel_unavailable', 'workspace_inactive', 'outbound_busy', 'operation_interrupted'] as const)(
      'persists preflight %s atomically with fixed status semantics and no communication', (reason) => {
        const request = setup(); const before = workflow();
        const receipt = domain.recordOutboundRefusal(request, reason);
        expect(receipt).toMatchObject({ status: ['outbound_busy', 'operation_interrupted'].includes(reason) ? 'refused' : 'unavailable', reasonCode: reason });
        expect(domain.recordOutboundRefusal(request, reason)).toEqual(receipt);
        expect(facts()).toHaveLength(2); expect(communications()).toEqual([]); expect(workflow()).toEqual(before);
      });

    it('allows a currently eligible Won/onboarding cycle without changing its action or stage', () => {
      const request = setup();
      database.raw.prepare("UPDATE sales_cycles SET stage = 'won', workflow_status = 'onboarding' WHERE id = ?").run(request.salesCycleId);
      const before = workflow();
      expect(domain.prepareOutboundDispatch(request).kind).toBe('dispatch');
      expect(workflow()).toEqual(before); expect(communications()).toEqual([]);
    });

    it.each(['text', 'email'] as const)('never returns a Phone target for direct %s preparation', (channel) => {
      const original = setup();
      if (channel === 'email') database.raw.prepare("UPDATE person_contact_methods SET kind = 'email', normalized_value = 'fixture@example.invalid' WHERE id = ?").run(original.contactMethodId);
      const request = { ...original, channel, expectedContactSnapshot: contactSnapshot(services.identities.getContactMethod(original.contactMethodId)!) };
      expectRefusal(request, 'channel_unavailable', 'unavailable');
    });

    it('refuses a current contact of the wrong channel kind without executing', () => {
      const original = setup();
      expectRefusal({ ...original, channel: 'email' }, 'channel_contact_kind_mismatch');
    });

    it('rejects a result without dispatch evidence, malformed results and conflict refusals with no orphan rows', () => {
      const request = setup();
      expect(() => domain.recordOutboundResult(request, { status: 'handoff_accepted', reasonCode: null }))
        .toThrow(expect.objectContaining({ reasonCode: 'command_evidence_invalid' }));
      for (const reason of ['command_conflict', 'command_evidence_invalid'] as const) {
        expect(() => domain.recordOutboundRefusal(request, reason)).toThrow();
      }
      expect(facts()).toEqual([]);
      services.unitOfWork.immediate(() => services.outboundCommands.append({ request,
        phase: 'requested', reasonCode: null, occurredAt: CLOCK_NOW }, 'outbound-prospect'));
      expect(() => domain.recordOutboundResult(request, { status: 'handoff_accepted', reasonCode: null }))
        .toThrow(expect.objectContaining({ reasonCode: 'command_evidence_invalid' }));
      expect(() => domain.recordOutboundResult(request, { status: 'handoff_accepted', reasonCode: null, body: 'private' } as HandoffResult)).toThrow();
      expect(facts()).toHaveLength(1);
      expect(domain.prepareOutboundDispatch(request)).toMatchObject({ kind: 'receipt', receipt: { status: 'unknown' } });
    });

    it('rolls back the requested row when refusal insertion fails', () => {
      const request = setup();
      database.raw.exec(`CREATE TRIGGER reject_refusal AFTER INSERT ON activities
        WHEN NEW.provider_idempotency_key LIKE '%:unavailable'
        BEGIN SELECT RAISE(ABORT, 'fixture refusal failure'); END`);
      expect(() => domain.recordOutboundRefusal(request, 'phone_route_unverified')).toThrow('fixture refusal failure');
      expect(facts()).toEqual([]);
    });

    it('rolls back both preparation facts if dispatch-intent insertion fails', () => {
      const request = setup(); const before = workflow();
      database.raw.exec(`CREATE TRIGGER reject_dispatch BEFORE INSERT ON activities
        WHEN NEW.provider_idempotency_key LIKE '%:dispatching'
        BEGIN SELECT RAISE(ABORT, 'fixture dispatch failure'); END`);
      expect(() => domain.prepareOutboundDispatch(request)).toThrow('fixture dispatch failure');
      expect(facts()).toEqual([]); expect(workflow()).toEqual(before); expect(communications()).toEqual([]);
    });

    it('persists results in a separate idempotent UOW and rejects competing terminals or changed owner', () => {
      const request = setup(); const before = workflow();
      domain.prepareOutboundDispatch(request);
      const result: HandoffResult = { status: 'handoff_accepted', reasonCode: null };
      const receipt = domain.recordOutboundResult(request, result);
      clock.set('2026-08-31T15:01:00.000Z');
      expect(domain.recordOutboundResult(request, result)).toEqual(receipt);
      expect(() => domain.recordOutboundResult(request, { status: 'unknown', reasonCode: 'handoff_uncertain' }))
        .toThrow(expect.objectContaining({ reasonCode: 'command_evidence_invalid' }));
      expect(() => domain.recordOutboundRefusal({ ...request, personId: 'other' }, 'outbound_busy'))
        .toThrow(expect.objectContaining({ reasonCode: 'command_conflict' }));
      expect(facts()).toHaveLength(3); expect(communications()).toEqual([]); expect(workflow()).toEqual(before);
    });

    it('leaves committed dispatch unknown after result-write failure and suppresses redispatch after encrypted reopen', async () => {
      const request = setup();
      database.raw.exec(`CREATE TRIGGER reject_result AFTER INSERT ON activities
        WHEN NEW.provider_idempotency_key LIKE '%:handoff_accepted'
        BEGIN SELECT RAISE(ABORT, 'fixture result failure'); END`);
      const dispatch = vi.fn(async (): Promise<HandoffResult> => ({ status: 'handoff_accepted', reasonCode: null }));
      const makeService = () => createOutboundCommandService({
        domain: { withDomain: async (operation) => operation(domain) },
        readiness: { getCapability: () => ({ state: 'available', reasonCode: null }), check: async () => ({ kind: 'ready' }) },
        phone: { inspectCapability: async () => ({ state: 'available', reasonCode: null }), dispatch },
      });
      expect(await makeService().beginOutbound(request)).toMatchObject({ status: 'unknown', reasonCode: 'result_not_persisted' });
      const before = facts();
      closeDatabase(database);
      database = openDatabase({ path: temp.path, key: createTestWorkspaceKey() });
      const ids = { next: () => 'must-not-allocate' };
      services = createDomainServices({ database, clock, ids });
      domain = createFounderSalesDomain({ services, database, clock, ids });
      expect(await makeService().beginOutbound(request)).toMatchObject({ status: 'unknown', reasonCode: 'handoff_uncertain' });
      expect(dispatch).toHaveBeenCalledTimes(1); expect(facts()).toEqual(before); expect(communications()).toEqual([]);
    });
  });

  describe('leads', () => {
    it('lists seeded people with strict rows and no blended score', () => {
      seedLead('alpha');
      seedLead('beta');
      const page = listAll();
      expect(page.total).toBe(2);
      expect(page.rows.map((row) => row.personName)).toHaveLength(2);
      for (const row of page.rows) {
        expect(row.initials.length).toBeGreaterThan(0);
        expect(Object.keys(row)).not.toContain('score');
        if (row.priorityContext !== null) {
          expect(row.priorityContext.fitPoints).toBeLessThanOrEqual(30);
          expect(row.priorityContext.timingValue).toBeLessThanOrEqual(40);
        }
      }
    });

    it('filters by query and paginates with a stable cursor', () => {
      seedLead('alpha');
      seedLead('beta');
      const filtered = domain.listLeadRows({
        query: 'alpha', stages: [], priorities: [], sort: 'priority', cursor: null, limit: 50,
      });
      expect(filtered.total).toBe(1);
      const first = domain.listLeadRows({
        query: '', stages: [], priorities: [], sort: 'priority', cursor: null, limit: 1,
      });
      expect(first.rows).toHaveLength(1);
      expect(first.nextCursor).not.toBeNull();
      const second = domain.listLeadRows({
        query: '', stages: [], priorities: [], sort: 'priority',
        cursor: first.nextCursor, limit: 1,
      });
      expect(second.rows).toHaveLength(1);
      expect(second.rows[0]!.personId).not.toBe(first.rows[0]!.personId);
    });

    it('updates a person name through the field update command', () => {
      const { prospect } = seedLead('alpha');
      const receipt = domain.updateLeadField({
        personId: prospect.personId, field: 'person_name', value: 'Renamed Person',
      });
      expect(receipt.affectedPersonIds).toEqual([prospect.personId]);
      const page = listAll();
      expect(page.rows.some((row) => row.personName === 'Renamed Person')).toBe(true);
    });

    it('bulk-updates the same field across people', () => {
      const first = seedLead('alpha');
      const second = seedLead('beta');
      const receipt = domain.bulkUpdateLeads({
        personIds: [first.prospect.personId, second.prospect.personId],
        field: 'person_name',
        value: 'Same Name',
      });
      expect(receipt.affectedPersonIds).toHaveLength(2);
      const page = listAll();
      expect(page.rows.filter((row) => row.personName === 'Same Name')).toHaveLength(2);
    });

    it('returns a strict lead detail for a seeded person', () => {
      const { prospect, cycleId } = seedLead('alpha');
      const detail = domain.getLeadDetail({ personId: prospect.personId });
      expect(detail.personId).toBe(prospect.personId);
      expect(detail.salesCycleId).toBe(cycleId);
      expect(detail.stage).toBe('unreviewed');
      expect(detail.optedOut).toBe(false);
      expect(detail.revision).toBeGreaterThanOrEqual(0);
    });
  });

  describe('lifecycle transitions', () => {
    it('confirms review_to_ready and reflects the new stage', () => {
      const prospect = seedProspect(database.raw, 'alpha');
      database.raw.prepare(`
        UPDATE prospects SET qualification_state = 'unreviewed' WHERE id = ?
      `).run(prospect.prospectId);
      const cycle = services.lifecycle.createUnreviewedCycle({
        personId: prospect.personId, prospectId: prospect.prospectId,
        entrySourceEventId: prospect.sourceEventId, effectiveAt: DOMAIN_TIMESTAMP,
      });
      const receipt = domain.confirmTransition({
        transition: 'review_to_ready', salesCycleId: cycle.id, expectedRevision: 0,
      });
      expect(receipt.affectedSalesCycleIds).toEqual([cycle.id]);
      const detail = domain.getLeadDetail({ personId: prospect.personId });
      expect(detail.stage).toBe('ready');
    });

    it('completes the primary action through the lifecycle service', () => {
      const prospect = seedProspect(database.raw, 'alpha');
      database.raw.prepare(`
        UPDATE prospects SET qualification_state = 'unreviewed' WHERE id = ?
      `).run(prospect.prospectId);
      const cycle = services.lifecycle.createUnreviewedCycle({
        personId: prospect.personId, prospectId: prospect.prospectId,
        entrySourceEventId: prospect.sourceEventId, effectiveAt: DOMAIN_TIMESTAMP,
      });
      domain.confirmTransition({
        transition: 'review_to_ready', salesCycleId: cycle.id, expectedRevision: 0,
      });
      const current = database.raw.prepare(`
        SELECT current_next_action_id AS action_id FROM sales_cycles WHERE id = ?
      `).get(cycle.id) as { action_id: string };
      const receipt = domain.completePrimaryAction({
        salesCycleId: cycle.id,
        actionId: current.action_id,
        outcome: 'accepted',
        activityId: null,
      });
      expect(receipt.affectedSalesCycleIds).toEqual([cycle.id]);
      const after = database.raw.prepare(`
        SELECT status FROM next_actions WHERE id = ?
      `).get(current.action_id) as { status: string };
      expect(after.status).toBe('completed');
      const next = database.raw.prepare(`
        SELECT current_next_action_id AS action_id FROM sales_cycles WHERE id = ?
      `).get(cycle.id) as { action_id: string };
      expect(next.action_id).not.toBe(current.action_id);
    });
  });

  describe('today', () => {
    it('maps every internal lane to its contract id and never duplicates a cycle', () => {
      // Reviewed (ready) so the overdue promise stays in the Overdue lane;
      // unreviewed backlog is summarized separately.
      const active = seedLead('alpha', 'ready');
      const backlog = seedLead('beta');
      const onboarding = seedProspect(database.raw, 'gamma');
      database.raw.exec('BEGIN IMMEDIATE');
      try {
        database.raw.prepare(`
          INSERT INTO sales_cycles (
            id, person_id, prospect_id, entry_source_event_id, stage,
            workflow_status, current_next_action_id, stage_entered_at,
            version, created_at, updated_at
          ) VALUES ('gamma-cycle', ?, ?, ?, 'won', 'onboarding', 'gamma-action', ?, 1, ?, ?)
        `).run(
          onboarding.personId, onboarding.prospectId, onboarding.sourceEventId,
          DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP,
        );
        database.raw.prepare(`
          INSERT INTO next_actions (
            id, sales_cycle_id, action_type, channel, status,
            timezone, work_intent, created_at
          ) VALUES ('gamma-action', 'gamma-cycle', 'onboard_client', NULL, 'pending',
                    'America/New_York', 'promised_follow_up', ?)
        `).run(DOMAIN_TIMESTAMP);
        database.raw.exec('COMMIT');
      } catch (error) {
        if (database.raw.inTransaction) database.raw.exec('ROLLBACK');
        throw error;
      }
      const snapshot = domain.getToday();
      expect(snapshot.lanes.map((lane) => lane.id)).toEqual([
        'onboarding', 'fresh_inbound', 'due_cadence', 'new_p0', 'p1',
        'exploration', 'later',
      ]);
      const itemsByLane = new Map(snapshot.lanes.map((lane) => [lane.id, lane.items]));
      expect(itemsByLane.get('onboarding')!.map((item) => item.salesCycleId))
        .toEqual(['gamma-cycle']);
      // The default seeded promise lands in Due cadence.
      expect(itemsByLane.get('due_cadence')!.map((item) => item.salesCycleId))
        .toEqual([active.cycleId]);
      // The unreviewed cycle is only a backlog count, never a row.
      expect(snapshot.unreviewedBacklogCount).toBe(1);
      const allIds = snapshot.lanes.flatMap((lane) => lane.items.map((item) => item.salesCycleId));
      expect(allIds).not.toContain(backlog.cycleId);
      expect(new Set(allIds).size).toBe(allIds.length);
    });

    it('returns a strict snapshot with dial capacity from settings', () => {
      seedLead('alpha');
      const snapshot = domain.getToday();
      expect(snapshot.dialBudget).toBeGreaterThan(0);
      expect(snapshot.lanes.length).toBeGreaterThan(0);
      const laneIds = snapshot.lanes.map((lane) => lane.id);
      expect(new Set(laneIds).size).toBe(laneIds.length);
    });

    it('logs an internal note as a plain activity', () => {
      const { prospect, cycleId } = seedLead('alpha');
      const receipt = domain.logPastActivity({
        personId: prospect.personId,
        salesCycleId: cycleId,
        kind: 'note',
        direction: 'internal',
        occurredAt: DOMAIN_TIMESTAMP,
        summary: 'Spoke at the RIREIG meetup.',
        outcome: null,
      });
      expect(receipt.affectedPersonIds).toEqual([prospect.personId]);
      const detail = domain.getLeadDetail({ personId: prospect.personId });
      expect(detail.activities.some(
        (activity) => activity.summary.includes('RIREIG'),
      )).toBe(true);
    });
  });

  describe('pipeline and review', () => {
    it('returns all seven fixed stages in order including empty ones', () => {
      seedLead('alpha');
      const snapshot = domain.getPipelineProjection();
      expect(snapshot.stages.map((stage) => stage.stage)).toEqual([
        'unreviewed', 'ready', 'contacted', 'interviewed', 'offered', 'won', 'lost_nurture',
      ]);
      expect(snapshot.stages[0]!.cards).toHaveLength(1);
      expect(snapshot.stages[5]!.cards).toEqual([]);
    });

    it('projects stages without renderer-forbidden fields', () => {
      seedLead('alpha');
      const snapshot = domain.getPipelineProjection();
      const stages = snapshot.stages.map((stage) => stage.stage);
      expect(stages).toContain('unreviewed');
      const serialized = JSON.stringify(snapshot);
      expect(serialized).not.toMatch(/normalized_value|key_envelope/);
    });

    it('lists review items as an empty strict snapshot when none exist', () => {
      const snapshot = domain.listReviewItems({ kinds: [], limit: 50 });
      expect(snapshot.items).toEqual([]);
    });
  });

  describe('friday report and founder jobs', () => {
    it('returns the strict shape with zero metrics on an empty database', () => {
      const report = domain.getFridayReport();
      expect(report.jobs).toEqual([]);
      expect(report.sourceRows).toEqual([]);
      expect(report.periodStartsAt < report.periodEndsAt).toBe(true);
      const byId = new Map(report.metrics.map((metric) => [metric.id, metric]));
      expect(byId.get('interviews')!.numericValue).toBe(0);
      expect(byId.get('wins')!.numericValue).toBe(0);
      expect(byId.get('fill_rate')!.displayValue).toBe('—');
      expect(byId.get('fill_rate')!.numericValue).toBeNull();
      expect(byId.get('offer_rate')!.displayValue).toBe('—');
    });

    it('reports metrics and manages the founder job lifecycle', () => {
      const report = domain.getFridayReport();
      expect(report.metrics.length).toBeGreaterThan(0);
      const metricIds = report.metrics.map((metric) => metric.id);
      expect(metricIds).toContain('jobs_requested');
      expect(metricIds).toContain('fill_rate');

      domain.createJobRequest({
        jobId: 'job-1', salesCycleId: null, requestedAt: CLOCK_NOW,
      });
      let jobs = domain.getFridayReport().jobs;
      expect(jobs.some((job) => job.id === 'job-1' && job.status === 'requested')).toBe(true);

      domain.markJobFilled({ jobId: 'job-1', contractorAcceptedAt: CLOCK_NOW });
      jobs = domain.getFridayReport().jobs;
      expect(jobs.some((job) => job.id === 'job-1' && job.status === 'filled')).toBe(true);

      domain.createJobRequest({
        jobId: 'job-2', salesCycleId: null, requestedAt: CLOCK_NOW,
      });
      domain.cancelJobRequest({ jobId: 'job-2' });
      jobs = domain.getFridayReport().jobs;
      expect(jobs.some((job) => job.id === 'job-2' && job.status === 'cancelled')).toBe(true);
    });

    it('drills into a metric without leaking internals', () => {
      const drilldown = domain.getMetricDrilldown({ metricId: 'interviews' });
      expect(drilldown.metricId).toBe('interviews');
      expect(Array.isArray(drilldown.rows)).toBe(true);
    });
  });

  describe('csv import', () => {
    const CSV = 'Name,Phone,Company\nPat Owner,4015550100,Oak Realty\nSam Owner,4015550101,Elm Estates\n';

    it('previews, remaps, commits, and reports the import job', () => {
      const preview = domain.previewLeadImport({ kind: 'csv', sourceName: 'leads.csv', content: CSV });
      expect(preview.rowCount).toBe(2);
      expect(preview.columns).toEqual(['Name', 'Phone', 'Company']);
      expect(preview.contentHash).toMatch(/^[a-f0-9]{64}$/);

      const remapped = domain.remapLeadImport({
        previewId: preview.previewId,
        contentHash: preview.contentHash,
        mapping: { Name: 'person_name', Phone: 'phone', Company: 'organization' },
      });
      expect(remapped.validCount).toBe(2);

      const receipt = domain.commitLeadImport({
        previewId: preview.previewId,
        contentHash: preview.contentHash,
        mapping: { Name: 'person_name', Phone: 'phone', Company: 'organization' },
        source: { channel: 'custom', referredByPersonId: null },
        duplicateDecisions: [],
      });
      expect(receipt.importedRowCount).toBe(2);
      expect(receipt.importedPersonIds).toHaveLength(2);

      const status = domain.getImportJob({ jobId: receipt.jobId });
      expect(status.state).toBe('succeeded');

      const page = listAll();
      expect(page.rows.some((row) => row.personName === 'Pat Owner')).toBe(true);
    });

    it('rejects a commit whose content hash does not match the preview', () => {
      const preview = domain.previewLeadImport({ kind: 'csv', sourceName: 'leads.csv', content: CSV });
      expect(() => domain.commitLeadImport({
        previewId: preview.previewId,
        contentHash: 'a'.repeat(64),
        mapping: { Name: 'person_name' },
        source: { channel: 'custom', referredByPersonId: null },
        duplicateDecisions: [],
      })).toThrow(/expired or changed/);
    });

    it('does not duplicate people when the same content is imported again', () => {
      const mapping = { Name: 'person_name', Phone: 'phone', Company: 'organization' } as const;
      const commit = () => {
        const preview = domain.previewLeadImport({
          kind: 'csv', sourceName: 'leads.csv', content: CSV,
        });
        return domain.commitLeadImport({
          previewId: preview.previewId,
          contentHash: preview.contentHash,
          mapping,
          source: { channel: 'custom', referredByPersonId: null },
          duplicateDecisions: [],
        });
      };
      const first = commit();
      const second = commit();
      expect(second.jobId).toBe(first.jobId);
      const persons = database.raw.prepare(
        'SELECT COUNT(*) AS count FROM persons',
      ).get() as { count: number };
      expect(persons.count).toBe(2);
      const cycles = database.raw.prepare(
        'SELECT COUNT(*) AS count FROM sales_cycles',
      ).get() as { count: number };
      expect(cycles.count).toBe(2);
    });
  });
});
