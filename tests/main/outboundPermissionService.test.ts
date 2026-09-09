import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { IdentityRepository } from '../../src/main/domain/identity/identityRepository';
import { JurisdictionRepository } from '../../src/main/domain/compliance/jurisdictionRepository';
import { OptOutRepository } from '../../src/main/domain/optOut/optOutRepository';
import { OutboundPermissionService } from '../../src/main/domain/optOut/outboundPermissionService';
import { todaySelectedCallReceiptV1Schema } from '../../src/main/domain/optOut/optOutTypes';
import {
  DomainRepositoryDatabaseMismatchError,
  DomainTransactionRequiredError,
  OutboundAuthorizationError,
  OutboundContactBlockedError,
} from '../../src/main/domain/support/domainErrors';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import { createDomainServices } from '../../src/main/domain/createDomainServices';
import { createFounderSalesDomain } from '../../src/main/domain/founderSalesDomain';
import { contactSnapshot } from '../../src/main/communications/contactSnapshot';
import { createOutboundCommandService } from '../../src/main/communications/outboundCommandService';
import { DOMAIN_TIMESTAMP, seedProspect, insertOpenCycleWithAction } from '../fixtures/domainRows';
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

describe('OutboundPermissionService', () => {
  const AUTHORIZATION_NOW = '2026-09-04T14:00:00.000Z';
  let database: AppDatabase;
  let temp: TempDatabase;
  let unitOfWork: DomainUnitOfWork;
  let identities: IdentityRepository;
  let optOuts: OptOutRepository;
  let jurisdictions: JurisdictionRepository;
  let permissions: OutboundPermissionService;
  let id = 0;

  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${temp.path}.backups`, workspaceKey: key,
    });
    unitOfWork = new DomainUnitOfWork(database);
    const dependencies = {
      database, unitOfWork, clock: { now: () => DOMAIN_TIMESTAMP },
      ids: { next: () => `generated-${++id}` },
    };
    identities = new IdentityRepository(dependencies);
    optOuts = new OptOutRepository({ database, unitOfWork });
    jurisdictions = new JurisdictionRepository({ database, unitOfWork });
    permissions = new OutboundPermissionService({
      database, unitOfWork, identities, optOuts, jurisdictions,
    });
  });

  afterEach(() => {
    closeDatabase(database);
    temp.cleanup();
  });

  function createPerson(phone: string): string {
    return unitOfWork.immediate(() => {
      const person = identities.createPerson({ displayName: `Person ${id}` });
      identities.addContactMethod({
        personId: person.id, kind: 'phone', normalizedValue: phone,
        validationState: 'valid', reachability: 'direct',
      });
      return person.id;
    });
  }

  function contactId(personId: string): string {
    return identities.listContactMethodsForPerson(personId)[0]!.id;
  }

  function authorizeRegion(personId: string): void {
    database.raw.prepare(`INSERT INTO person_outbound_jurisdictions
      (person_id, region_code, timezone, source, effective_at, updated_at)
      VALUES (?, 'RI', 'America/New_York', 'manual_review', ?, ?)`)
      .run(personId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    for (const channel of ['call', 'text'] as const) {
      database.raw.prepare(`INSERT OR REPLACE INTO outbound_jurisdiction_clearances
        (region_code, channel, decision, registration_confirmed,
         state_dnc_subscription_confirmed, consent_rule_confirmed, source,
         effective_at, expires_at, updated_at)
        VALUES ('RI', ?, 'allowed', 1, 1, 1, 'test',
                '2026-08-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', ?)`)
        .run(channel, DOMAIN_TIMESTAMP);
    }
  }

  function makeFederalEvidenceClear(contactMethodId: string): void {
    database.raw.prepare(`UPDATE person_contact_methods SET
      federal_status = 'verified_clear', compliance_tcpa_flag = 0,
      covered_area_code = '401', compliance_source = 'ftc_download',
      scrubbed_at = '2026-08-15T00:00:00.000Z',
      compliance_expires_at = '2026-09-15T00:00:00.000Z'
      WHERE id = ?`).run(contactMethodId);
  }

  function block(personId: string, phone: string, tombstoneId: string): void {
    const activityId = `${tombstoneId}-activity`;
    database.raw.prepare(`
      INSERT INTO activities (
        id, person_id, kind, direction, channel, occurred_at, observed_outcome,
        metadata_json, created_at
      ) VALUES (?, ?, 'text', 'inbound', 'imessage', ?, 'opted_out', '{}', ?)
    `).run(activityId, personId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    unitOfWork.immediate(() => {
      optOuts.insertTombstone({
        id: tombstoneId, personId, requestedAt: DOMAIN_TIMESTAMP,
        observedChannel: 'imessage', sourceActivityId: activityId, evidenceRef: null,
        policyVersion: 'founder_opt_out_v1', createdAt: DOMAIN_TIMESTAMP,
      });
      optOuts.insertBlockedHandle({
        id: `${tombstoneId}-handle`, tombstoneId, kind: 'phone',
        normalizedValue: phone, createdAt: DOMAIN_TIMESTAMP,
      });
    });
  }

  it('inspects Person and every handle on each read and blocks re-imported identities', () => {
    const blockedPerson = createPerson('+14015550100');
    block(blockedPerson, '+14015550100', 'blocked-tombstone');
    const reimported = createPerson('+14015550100');
    const clean = createPerson('+14015550101');

    expect(permissions.inspectPerson(clean)).toEqual({ kind: 'allowed' });
    expect(permissions.inspectPerson(blockedPerson)).toEqual({
      kind: 'blocked', tombstoneIds: ['blocked-tombstone'],
      matchedHandles: [{ kind: 'phone', normalizedValue: '+14015550100' }],
    });
    expect(permissions.inspectPerson(reimported)).toEqual({
      kind: 'blocked', tombstoneIds: ['blocked-tombstone'],
      matchedHandles: [{ kind: 'phone', normalizedValue: '+14015550100' }],
    });
    expect(() => permissions.assertMayContactHandle('phone', '(401) 555-0100'))
      .toThrow(OutboundContactBlockedError);
  });

  it('requires an exact active scope for authoritative execution and exposes no contact values', () => {
    const personId = createPerson('+14015550100');
    const selectedContactId = contactId(personId);
    block(personId, '+14015550100', 'execute-tombstone');
    expect(() => permissions.assertMayExecuteOutbound({
      personId, contactMethodId: selectedContactId, channel: 'call', now: DOMAIN_TIMESTAMP,
    })).toThrow(DomainTransactionRequiredError);

    let thrown: unknown;
    unitOfWork.immediate(() => {
      try {
        permissions.assertMayExecuteOutbound({
          personId, contactMethodId: selectedContactId, channel: 'call', now: DOMAIN_TIMESTAMP,
        });
      } catch (error) {
        thrown = error;
      }
    });
    expect(thrown).toMatchObject({ reasonCode: 'person_or_handle_opted_out' });
    expect(JSON.stringify(thrown)).not.toContain('+14015550100');
  });

  it('returns stable refusal codes for every explicit gate', () => {
    const personId = createPerson('+14015550100');
    const selectedContactId = contactId(personId);
    const inspect = () => unitOfWork.immediate(() => permissions.inspectOutbound({
      personId, contactMethodId: selectedContactId, channel: 'call', now: AUTHORIZATION_NOW,
    }));

    expect(inspect()).toEqual({ kind: 'refused', reasonCode: 'federal_status_unknown' });
    database.raw.prepare("UPDATE person_contact_methods SET federal_status = 'listed' WHERE id = ?")
      .run(selectedContactId);
    expect(inspect()).toEqual({ kind: 'refused', reasonCode: 'federal_dnc_listed' });
    makeFederalEvidenceClear(selectedContactId);
    database.raw.prepare("UPDATE person_contact_methods SET compliance_expires_at = '2026-09-04T13:00:00.000Z' WHERE id = ?")
      .run(selectedContactId);
    expect(inspect()).toEqual({ kind: 'refused', reasonCode: 'federal_evidence_stale' });
    makeFederalEvidenceClear(selectedContactId);
    database.raw.prepare("UPDATE person_contact_methods SET covered_area_code = '212' WHERE id = ?")
      .run(selectedContactId);
    expect(inspect()).toEqual({ kind: 'refused', reasonCode: 'federal_area_code_mismatch' });
    makeFederalEvidenceClear(selectedContactId);
    database.raw.prepare('UPDATE person_contact_methods SET compliance_tcpa_flag = NULL WHERE id = ?')
      .run(selectedContactId);
    expect(inspect()).toEqual({ kind: 'refused', reasonCode: 'tcpa_status_unknown' });
    database.raw.prepare('UPDATE person_contact_methods SET compliance_tcpa_flag = 1 WHERE id = ?')
      .run(selectedContactId);
    expect(inspect()).toEqual({ kind: 'refused', reasonCode: 'tcpa_blocked' });
    makeFederalEvidenceClear(selectedContactId);
    expect(inspect()).toEqual({ kind: 'refused', reasonCode: 'jurisdiction_unknown' });
    authorizeRegion(personId);
    expect(inspect()).toEqual({ kind: 'allowed' });

    database.raw.prepare("UPDATE outbound_jurisdiction_clearances SET decision = 'blocked' WHERE region_code = 'RI' AND channel = 'call'").run();
    expect(inspect()).toEqual({ kind: 'refused', reasonCode: 'jurisdiction_blocked' });
    database.raw.prepare("UPDATE outbound_jurisdiction_clearances SET decision = 'allowed', registration_confirmed = 0 WHERE region_code = 'RI' AND channel = 'call'").run();
    expect(inspect()).toEqual({ kind: 'refused', reasonCode: 'state_registration_missing' });
    database.raw.prepare("UPDATE outbound_jurisdiction_clearances SET registration_confirmed = 1, state_dnc_subscription_confirmed = 0 WHERE region_code = 'RI' AND channel = 'call'").run();
    expect(inspect()).toEqual({ kind: 'refused', reasonCode: 'state_dnc_subscription_missing' });
    database.raw.prepare("UPDATE outbound_jurisdiction_clearances SET state_dnc_subscription_confirmed = 1, consent_rule_confirmed = 0 WHERE region_code = 'RI' AND channel = 'call'").run();
    expect(inspect()).toEqual({ kind: 'refused', reasonCode: 'state_consent_rule_unknown' });
    database.raw.prepare("UPDATE outbound_jurisdiction_clearances SET consent_rule_confirmed = 1 WHERE region_code = 'RI' AND channel = 'call'").run();
    expect(unitOfWork.immediate(() => permissions.inspectOutbound({
      personId, contactMethodId: selectedContactId, channel: 'call',
      now: '2026-09-05T00:00:00.000Z',
    }))).toEqual({ kind: 'refused', reasonCode: 'outside_recipient_window' });
  });

  it('rejects invalid and unverified contact methods', () => {
    const personId = createPerson('+14015550100');
    const selectedContactId = contactId(personId);
    for (const state of ['invalid', 'unverified'] as const) {
      database.raw.prepare('UPDATE person_contact_methods SET validation_state = ? WHERE id = ?')
        .run(state, selectedContactId);
      expect(unitOfWork.immediate(() => permissions.inspectOutbound({
        personId, contactMethodId: selectedContactId, channel: 'call', now: DOMAIN_TIMESTAMP,
      }))).toEqual({ kind: 'refused', reasonCode: 'contact_validation_unusable' });
    }
  });

  it('authorizes the exact selected contact and preserves opt-out precedence', () => {
    const personId = createPerson('+14015550100');
    const firstContactId = contactId(personId);
    const secondContact = unitOfWork.immediate(() => identities.addContactMethod({
      personId, kind: 'phone', normalizedValue: '+14015550101',
      validationState: 'valid', reachability: 'direct',
    }));
    makeFederalEvidenceClear(firstContactId);
    authorizeRegion(personId);
    block(personId, '+14015550101', 'selected-tombstone');

    const decision = unitOfWork.immediate(() => permissions.inspectOutbound({
      personId, contactMethodId: secondContact.id, channel: 'call', now: DOMAIN_TIMESTAMP,
    }));
    expect(decision).toEqual({ kind: 'refused', reasonCode: 'person_or_handle_opted_out' });
    expect(() => unitOfWork.immediate(() => permissions.assertMayExecuteOutbound({
      personId, contactMethodId: secondContact.id, channel: 'call', now: DOMAIN_TIMESTAMP,
    }))).toThrow(OutboundAuthorizationError);
  });

  it('rejects mixed repository/service bindings before reads', () => {
    const otherUnit = new DomainUnitOfWork(database);
    expect(() => new OutboundPermissionService({
      database, unitOfWork: otherUnit, identities, optOuts,
    })).toThrow(DomainRepositoryDatabaseMismatchError);
    expect(() => permissions.assertBoundTo(database, otherUnit))
      .toThrow(DomainRepositoryDatabaseMismatchError);
  });

  it('rechecks actual authorization after preflight applies an opt-out, ignoring the earlier allowed advice', async () => {
    const prospect = seedProspect(database.raw, 'final-gate');
    const { cycleId } = insertOpenCycleWithAction({ database: database.raw, prefix: 'final-gate', prospect });
    const contact = unitOfWork.immediate(() => identities.addContactMethod({
      personId: prospect.personId, kind: 'phone', normalizedValue: '+14015550100',
      validationState: 'valid', reachability: 'direct',
    }));
    makeFederalEvidenceClear(contact.id);
    authorizeRegion(prospect.personId);
    expect(unitOfWork.immediate(() => permissions.inspectOutbound({
      personId: prospect.personId, contactMethodId: contact.id, channel: 'call', now: AUTHORIZATION_NOW,
    }))).toEqual({ kind: 'allowed' });
    const dependencies = { database, clock: { now: () => AUTHORIZATION_NOW }, ids: { next: () => `final-${++id}` } };
    const services = createDomainServices(dependencies);
    const domain = createFounderSalesDomain({ ...dependencies, services });
    const priorOwner = createPerson('+14015550100');
    let dispatches = 0;
    const commands = createOutboundCommandService({
      domain: { withDomain: async (operation) => operation(domain) },
      phone: {
        inspectCapability: async () => ({ state: 'available', reasonCode: null }),
        dispatch: async () => { dispatches++; return { status: 'handoff_accepted', reasonCode: null }; },
      },
      readiness: {
        getCapability: () => ({ state: 'available', reasonCode: null }),
        check: async (personId) => {
          block(priorOwner, '+14015550100', 'during-preflight');
          return readyReply(personId);
        },
        assertCurrent: assertCurrentReadiness,
      },
    });
    const receipt = await commands.beginOutbound({
      commandId: '00000000-0000-4000-8000-000000000001', channel: 'call',
      personId: prospect.personId, salesCycleId: cycleId, contactMethodId: contact.id,
      expectedContactSnapshot: contactSnapshot(contact),
    });
    expect(receipt).toMatchObject({ status: 'refused', reasonCode: 'person_or_handle_opted_out' });
    expect(dispatches).toBe(0);
    expect(database.raw.prepare("SELECT kind, direction FROM activities WHERE adapter = 'callie_outbound_v1' ORDER BY rowid").all())
      .toEqual([{ kind: 'system', direction: 'internal' }, { kind: 'system', direction: 'internal' }]);
    expect(database.raw.prepare("SELECT COUNT(*) AS n FROM activities WHERE direction = 'outbound'").get()).toEqual({ n: 0 });
  });

  it('strictly validates the deferred Today selected-call receipt envelope', () => {
    const canonical = {
      version: 1 as const, kind: 'discretionary_call' as const,
      currentActionId: 'action-1', queueGeneratedAt: DOMAIN_TIMESTAMP,
      queueTimezone: 'America/New_York', queueLocalDate: '2026-08-30',
    };
    expect(todaySelectedCallReceiptV1Schema.parse(canonical)).toEqual(canonical);
    expect(() => todaySelectedCallReceiptV1Schema.parse({ ...canonical, extra: true })).toThrow();
    expect(() => todaySelectedCallReceiptV1Schema.parse({
      ...canonical, queueLocalDate: '08/30/2026',
    })).toThrow();
    expect(() => todaySelectedCallReceiptV1Schema.parse({
      ...canonical, queueTimezone: 'Not/AZone',
    })).toThrow();
    expect(() => todaySelectedCallReceiptV1Schema.parse({
      ...canonical, queueLocalDate: '2026-08-29',
    })).toThrow();
  });

  it('validates selected-call receipts only for the still-current discretionary call', () => {
    const prospect = seedProspect(database.raw, 'selected-call');
    database.raw.exec('BEGIN IMMEDIATE');
    try {
      database.raw.prepare(`
        INSERT INTO sales_cycles (
          id, person_id, prospect_id, entry_source_event_id, stage, workflow_status,
          current_next_action_id, stage_entered_at, version, created_at, updated_at
        ) VALUES ('selected-cycle', ?, ?, ?, 'ready', 'active', 'selected-action',
                  ?, 1, ?, ?)
      `).run(
        prospect.personId, prospect.prospectId, prospect.sourceEventId,
        DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP,
      );
      database.raw.prepare(`
        INSERT INTO next_actions (
          id, sales_cycle_id, action_type, channel, status, timezone,
          work_intent, version, created_at, updated_at
        ) VALUES ('selected-action', 'selected-cycle', 'call', 'phone', 'pending',
                  'America/New_York', 'discretionary_prospecting', 1, ?, ?)
      `).run(DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
      database.raw.exec('COMMIT');
    } catch (error) {
      if (database.raw.inTransaction) database.raw.exec('ROLLBACK');
      throw error;
    }
    const receipt = {
      version: 1 as const, kind: 'discretionary_call' as const,
      currentActionId: 'selected-action', queueGeneratedAt: DOMAIN_TIMESTAMP,
      queueTimezone: 'America/New_York', queueLocalDate: '2026-08-30',
    };
    unitOfWork.immediate(() => permissions.assertCurrentSelectedCallReceipt({
      personId: prospect.personId, receipt,
    }));
    expect(() => unitOfWork.immediate(() => permissions.assertCurrentSelectedCallReceipt({
      personId: prospect.personId,
      receipt: { ...receipt, currentActionId: 'stale-action' },
    }))).toThrow();
  });
});
