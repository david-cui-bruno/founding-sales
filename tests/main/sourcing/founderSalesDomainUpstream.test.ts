import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../../src/main/db/database';
import { migrateToLatest } from '../../../src/main/db/migrate';
import {
  createDomainServices,
  type DomainServices,
} from '../../../src/main/domain/createDomainServices';
import {
  createFounderSalesDomain,
  type FounderSalesDomain,
} from '../../../src/main/domain/founderSalesDomain';
import {
  BUILTIN_PRIORITIZATION_RULE_V1,
} from '../../../src/main/domain/prioritization/builtinPrioritizationRules';
import { mapCloudSourceEvent } from '../../../src/main/sourcing/intakeMapper';
import { validParcelEvent, validEnrichmentEvent } from '../../fixtures/cloudSourceEvents';
import { insertPerson, insertOpenCycleWithAction, DOMAIN_TIMESTAMP, seedProspect } from '../../fixtures/domainRows';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../../fixtures/tempDatabase';

const NOW = '2026-08-31T15:00:00.000Z';
const CE_ID = 'ce_01JC0000000000000000000009';

class SequentialIds {
  private counter = 0;

  next(): string {
    this.counter += 1;
    return `generated-${this.counter}`;
  }
}

describe('FounderSalesDomain upstream outbox and membership', () => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let services: DomainServices;
  let domain: FounderSalesDomain;

  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${temp.path}.backups`, workspaceKey: key,
    });
    const clock = { now: () => NOW };
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
    closeDatabase(database);
    temp.cleanup();
  });

  /** Imports the parcel fixture and returns its person + cycle. */
  function importLinkedLead(): { personId: string; cycleId: string } {
    const mapped = mapCloudSourceEvent(validParcelEvent());
    if (mapped.kind !== 'intake') throw new Error('expected intake');
    const result = domain.importCloudSourceEvent({
      command: mapped.command,
      cloudEntityId: mapped.cloudEntityId,
    });
    const cycle = database.raw.prepare(
      'SELECT id FROM sales_cycles WHERE person_id = ?',
    ).get(result.personId) as { id: string };
    return { personId: result.personId, cycleId: cycle.id };
  }

  function insertStageEvent(input: {
    id: string;
    cycleId: string;
    toStage: string;
    sequence: number;
  }): void {
    database.raw.prepare(`
      INSERT INTO stage_events (
        id, sales_cycle_id, from_stage, to_stage, effective_at, confirmed_at,
        confirmation_kind, transition_sequence, created_at
      ) VALUES (?, ?, 'contacted', ?, ?, ?, 'founder', ?, ?)
    `).run(
      input.id, input.cycleId, input.toStage, NOW, NOW, input.sequence, NOW,
    );
  }

  it('enqueues outcome labels for linked persons when listing unflushed rows', () => {
    const { cycleId } = importLinkedLead();
    insertStageEvent({ id: 'event-int', cycleId, toStage: 'interviewed', sequence: 5 });

    const rows = domain.listUnflushedCloudOutcomes();

    expect(rows).toEqual([{
      id: 'stage:event-int',
      cloudEntityId: validParcelEvent().entity.cloud_entity_id,
      label: 'interviewed',
      lossReasonCode: null,
      overrideDirection: null,
      observedAt: NOW,
    }]);
  });

  it('never enqueues outcomes for persons without a cloud entity link', () => {
    const prospect = seedProspect(database.raw, 'local');
    const { cycleId } = insertOpenCycleWithAction({
      database: database.raw, prefix: 'local', prospect, stage: 'contacted',
    });
    insertStageEvent({ id: 'event-local', cycleId, toStage: 'won', sequence: 2 });

    expect(domain.listUnflushedCloudOutcomes()).toEqual([]);
  });

  it('maps lost_nurture to the lost label and carries the close reason', () => {
    const { cycleId } = importLinkedLead();
    database.raw.prepare(`
      UPDATE sales_cycles
      SET stage = 'lost_nurture', workflow_status = 'closed',
        current_next_action_id = NULL, close_reason = 'price', closed_at = ?
      WHERE id = ?
    `).run(NOW, cycleId);
    insertStageEvent({ id: 'event-lost', cycleId, toStage: 'lost_nurture', sequence: 6 });

    expect(domain.listUnflushedCloudOutcomes()).toEqual([{
      id: 'stage:event-lost',
      cloudEntityId: validParcelEvent().entity.cloud_entity_id,
      label: 'lost',
      lossReasonCode: 'price',
      overrideDirection: null,
      observedAt: NOW,
    }]);
  });

  it('is idempotent: repeated sweeps never duplicate outbox rows', () => {
    const { cycleId } = importLinkedLead();
    insertStageEvent({ id: 'event-won', cycleId, toStage: 'won', sequence: 7 });

    domain.listUnflushedCloudOutcomes();
    domain.listUnflushedCloudOutcomes();

    expect(database.raw.prepare<[], { count: number }>(
      'SELECT COUNT(*) AS count FROM sourcing_outcome_outbox',
    ).get()).toEqual({ count: 1 });
  });

  it('marks rows flushed so the next listing skips them', () => {
    const { cycleId } = importLinkedLead();
    insertStageEvent({ id: 'event-off', cycleId, toStage: 'offered', sequence: 8 });
    const [row] = domain.listUnflushedCloudOutcomes();

    domain.markCloudOutcomesFlushed({ ids: [row!.id] });

    expect(domain.listUnflushedCloudOutcomes()).toEqual([]);
    expect(database.raw.prepare<[string], { flushed_at: string }>(
      'SELECT flushed_at FROM sourcing_outcome_outbox WHERE id = ?',
    ).get(row!.id)).toEqual({ flushed_at: NOW });
  });

  it('builds the membership snapshot: linked entity ids plus manual contacts', () => {
    importLinkedLead();
    // A manually-added person (no cloud entity link) with two handles.
    insertPerson(database.raw, 'manual-person');
    database.raw.prepare(`
      INSERT INTO person_contact_methods (
        id, person_id, kind, normalized_value, validation_state, reachability,
        is_primary, created_at, updated_at
      ) VALUES
        ('contact-1', 'manual-person', 'phone', '+14015550100', 'valid', 'direct', 1, ?, ?),
        ('contact-2', 'manual-person', 'email', 'manual@example.com', 'valid', 'direct', 0, ?, ?)
    `).run(DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);

    const membership = domain.listCloudMembership();

    expect(membership.cloudEntityIds).toEqual([
      validParcelEvent().entity.cloud_entity_id,
    ]);
    // The linked (cloud-minted) person's handles never appear as manual
    // contacts; only the manually-added person's handles do.
    expect(membership.manualContacts).toEqual([
      { kind: 'email', normalizedValue: 'manual@example.com' },
      { kind: 'phone', normalizedValue: '+14015550100' },
    ]);
  });

  it('records manual score overrides in the outbox with a direction', () => {
    const { personId } = importLinkedLead();

    const receipt = domain.enqueueCloudScoreOverride({ personId, direction: 'down' });

    expect(receipt.affectedPersonIds).toEqual([personId]);
    expect(database.raw.prepare<[], {
      cloud_entity_id: string; label: string; override_direction: string;
      loss_reason_code: string | null; observed_at: string; flushed_at: string | null;
    }>(`
      SELECT cloud_entity_id, label, override_direction, loss_reason_code,
        observed_at, flushed_at
      FROM sourcing_outcome_outbox WHERE label = 'override'
    `).all()).toEqual([{
      cloud_entity_id: validParcelEvent().entity.cloud_entity_id,
      label: 'override',
      override_direction: 'down',
      loss_reason_code: null,
      observed_at: NOW,
      flushed_at: null,
    }]);
  });

  it('rejects a score override for a person without a cloud entity link', () => {
    insertPerson(database.raw, CE_ID.replace('ce_', 'person-'));
    expect(() => domain.enqueueCloudScoreOverride({
      personId: CE_ID.replace('ce_', 'person-'), direction: 'up',
    })).toThrow(/cloud entity link/i);
  });

  it('persists a scorer re-emission onto the original prospect idempotently', () => {
    const { personId } = importLinkedLead();
    const receiptKey = `cloud:${validParcelEvent().idempotency_key}`;

    const applied = domain.applyCloudScoreUpdate({
      receiptKey,
      scoresVersion: 1,
      fit: 62,
      timing: 41,
      reasons: [
        { signal: 'portfolio_in_band', contribution: 15 },
        { signal: 'permit_filed_recent', contribution: 12 },
      ],
    });

    expect(applied).toBe(true);
    const prospect = database.raw.prepare(`
      SELECT cloud_fit, cloud_timing, cloud_scores_version, cloud_scored_at
      FROM prospects WHERE person_id = ?
    `).get(personId) as {
      cloud_fit: number; cloud_timing: number;
      cloud_scores_version: number; cloud_scored_at: string;
    };
    expect(prospect).toEqual({
      cloud_fit: 62, cloud_timing: 41, cloud_scores_version: 1, cloud_scored_at: NOW,
    });

    // A same-version re-emission is a correction: files process in key
    // (chronological) order, so the latest emission wins. True replays
    // carry identical values and are no-ops by content.
    domain.applyCloudScoreUpdate({
      receiptKey,
      scoresVersion: 1,
      fit: 47,
      timing: 41,
      reasons: [{ signal: 'llc_owner_no_pm', contribution: 7 }],
    });
    expect((database.raw.prepare(
      'SELECT cloud_fit FROM prospects WHERE person_id = ?',
    ).get(personId) as { cloud_fit: number }).cloud_fit).toBe(47);

    // A newer version updates in place.
    domain.applyCloudScoreUpdate({
      receiptKey,
      scoresVersion: 2,
      fit: 70,
      timing: 55,
      reasons: [{ signal: 'live_vacancy', contribution: 15 }],
    });
    expect((database.raw.prepare(
      'SELECT cloud_fit, cloud_timing FROM prospects WHERE person_id = ?',
    ).get(personId) as { cloud_fit: number; cloud_timing: number })).toEqual({
      cloud_fit: 70, cloud_timing: 55,
    });
  });

  it('returns false for a score update whose receipt is unknown', () => {
    expect(domain.applyCloudScoreUpdate({
      receiptKey: `cloud:${'f'.repeat(64)}`,
      scoresVersion: 1,
      fit: 10,
      timing: 10,
      reasons: [{ signal: 'no_signals', contribution: 0 }],
    })).toBe(false);
  });

  it('serves cloud scores through the leads grid rows and the lead detail', () => {
    const { personId } = importLinkedLead();
    domain.applyCloudScoreUpdate({
      receiptKey: `cloud:${validParcelEvent().idempotency_key}`,
      scoresVersion: 1,
      fit: 62,
      timing: 41,
      reasons: [
        { signal: 'portfolio_in_band', contribution: 15 },
        { signal: 'pre_1940_stock', contribution: 8 },
      ],
    });

    const page = domain.listLeadRows({
      query: '', stages: [], priorities: [], sort: 'priority', cursor: null, limit: 10,
    });
    const row = page.rows.find((candidate) => candidate.personId === personId);
    expect(row?.cloudScores).toEqual({ fit: 62, timing: 41 });

    const detail = domain.getLeadDetail({ personId });
    expect(detail.cloudScores).toEqual({
      scores: { fit: 62, timing: 41 },
      reasons: [
        { signal: 'portfolio_in_band', contribution: 15 },
        { signal: 'pre_1940_stock', contribution: 8 },
      ],
      scoredAt: NOW,
    });
  });

  it('rejects a replayed same-version update with an OLDER scoredAt', () => {
    const { personId } = importLinkedLead();
    const receiptKey = `cloud:${validParcelEvent().idempotency_key}`;
    domain.applyCloudScoreUpdate({
      receiptKey, scoresVersion: 1, fit: 62, timing: 41,
      reasons: [{ signal: 'portfolio_in_band', contribution: 15 }],
      scoredAt: '2026-08-31T12:00:00.000Z',
    });

    // A replayed OLD same-version correction must not regress the score.
    domain.applyCloudScoreUpdate({
      receiptKey, scoresVersion: 1, fit: 20, timing: 10,
      reasons: [{ signal: 'stale_replay', contribution: 1 }],
      scoredAt: '2026-08-30T12:00:00.000Z',
    });
    expect(database.raw.prepare(
      'SELECT cloud_fit, cloud_scored_at FROM prospects WHERE person_id = ?',
    ).get(personId)).toEqual({
      cloud_fit: 62, cloud_scored_at: '2026-08-31T12:00:00.000Z',
    });

    // A same-version correction with a NEWER scoredAt applies.
    domain.applyCloudScoreUpdate({
      receiptKey, scoresVersion: 1, fit: 47, timing: 44,
      reasons: [{ signal: 'llc_owner_no_pm', contribution: 7 }],
      scoredAt: '2026-08-31T13:00:00.000Z',
    });
    expect((database.raw.prepare(
      'SELECT cloud_fit FROM prospects WHERE person_id = ?',
    ).get(personId) as { cloud_fit: number }).cloud_fit).toBe(47);

    // A HIGHER version wins even with an older timestamp.
    domain.applyCloudScoreUpdate({
      receiptKey, scoresVersion: 2, fit: 70, timing: 55,
      reasons: [{ signal: 'live_vacancy', contribution: 15 }],
      scoredAt: '2026-08-29T00:00:00.000Z',
    });
    expect((database.raw.prepare(
      'SELECT cloud_fit FROM prospects WHERE person_id = ?',
    ).get(personId) as { cloud_fit: number }).cloud_fit).toBe(70);

    // A LOWER version never regresses.
    domain.applyCloudScoreUpdate({
      receiptKey, scoresVersion: 1, fit: 5, timing: 5,
      reasons: [{ signal: 'stale', contribution: 1 }],
      scoredAt: '2026-09-30T00:00:00.000Z',
    });
    expect((database.raw.prepare(
      'SELECT cloud_fit FROM prospects WHERE person_id = ?',
    ).get(personId) as { cloud_fit: number }).cloud_fit).toBe(70);
  });

  it('imports enrichment contacts with DNC flags and blocks the dial gate', () => {
    // First the parcel identity event mints the person.
    importLinkedLead();
    // Then the enrichment event appends flagged contacts to the same entity.
    const mapped = mapCloudSourceEvent(validEnrichmentEvent());
    if (mapped.kind !== 'intake') throw new Error('expected intake');
    const result = domain.importCloudSourceEvent({
      command: mapped.command,
      cloudEntityId: mapped.cloudEntityId,
    });

    const contacts = database.raw.prepare(`
      SELECT normalized_value, validation_state, is_primary, dnc_listed, tcpa_flag,
        source_label, vendor_rank, phone_kind, ownership_state, evidence_observed_at
      FROM person_contact_methods
      WHERE person_id = ? AND kind = 'phone'
      ORDER BY normalized_value ASC
    `).all(result.personId) as Array<{
      normalized_value: string; validation_state: string; is_primary: number;
      dnc_listed: number; tcpa_flag: number; source_label: string | null;
      vendor_rank: number | null; phone_kind: string | null; ownership_state: string;
      evidence_observed_at: string | null;
    }>;
    expect(contacts).toEqual([
      // Appended enrichment contacts keep the established primary: rank 1
      // would be primary on a fresh person, but the parcel event's phone
      // already holds one_primary_contact_per_kind.
      {
        normalized_value: '+14015550100', validation_state: 'unverified',
        is_primary: 0, dnc_listed: 0, tcpa_flag: 0, source_label: 'tracerfy',
        vendor_rank: 1, phone_kind: 'mobile', ownership_state: 'vendor_candidate',
        evidence_observed_at: '2026-09-02T02:59:00.000Z',
      },
      {
        normalized_value: '+14015550101', validation_state: 'unverified',
        is_primary: 0, dnc_listed: 1, tcpa_flag: 0, source_label: 'tracerfy',
        vendor_rank: 2, phone_kind: 'landline', ownership_state: 'vendor_candidate',
        evidence_observed_at: '2026-09-02T02:59:00.000Z',
      },
      // The original parcel event's phone keeps default (0) flags.
      {
        normalized_value: '+14015551234', validation_state: 'valid',
        is_primary: 1, dnc_listed: 0, tcpa_flag: 0, source_label: null,
        vendor_rank: null, phone_kind: null, ownership_state: 'unknown',
        evidence_observed_at: null,
      },
    ]);

    domain.importCloudSourceEvent({ command: mapped.command, cloudEntityId: mapped.cloudEntityId });
    expect(database.raw.prepare(`
      SELECT COUNT(*) AS count FROM person_contact_methods WHERE person_id = ?
    `).get(result.personId)).toEqual({ count: 5 });
    expect(database.raw.prepare(`
      SELECT vendor_rank FROM person_contact_methods
      WHERE person_id = ? AND normalized_value = '+14015550100'
    `).get(result.personId)).toEqual({ vendor_rank: 1 });

    const detail = domain.getLeadDetail({ personId: result.personId });
    const flagged = detail.phones.find((phone) => phone.value === '+14015550101');
    expect(flagged?.compliance).toMatchObject({
      status: 'compliance_unknown',
      callRefusalReason: 'contact_validation_unusable',
      textRefusalReason: 'contact_validation_unusable',
    });

    const blockedContact = database.raw.prepare(
      "SELECT id FROM person_contact_methods WHERE person_id = ? AND normalized_value = '+14015550101'",
    ).get(result.personId) as { id: string };
    expect(() => services.unitOfWork.immediate(() => services.outboundPermission.assertMayExecuteOutbound({
      channel: 'call', personId: result.personId, contactMethodId: blockedContact.id, now: NOW,
    }))).toThrowError(expect.objectContaining({ reasonCode: 'contact_validation_unusable' }));

    // A legacy/unknown contact is not authorized merely because compatibility flags are clear.
    const cleanContact = database.raw.prepare(
      "SELECT id FROM person_contact_methods WHERE person_id = ? AND normalized_value = '+14015550100'",
    ).get(result.personId) as { id: string };
    expect(() => services.unitOfWork.immediate(() => services.outboundPermission.assertMayExecuteOutbound({
      channel: 'call', personId: result.personId, contactMethodId: cleanContact.id, now: NOW,
    }))).toThrowError(expect.objectContaining({ reasonCode: 'contact_validation_unusable' }));
  });

  it('merges later compliance evidence into an existing cloud-linked phone', () => {
    const { personId } = importLinkedLead();

    services.sources.createPersonProspectForPerson({
      person: { displayName: 'Existing cloud lead' },
      contacts: [{
        kind: 'phone', value: '+14015551234', reachability: 'direct',
        complianceEvidence: {
          federalStatus: 'listed', tcpaFlag: false, coveredAreaCode: null,
          source: 'manual_import', scrubbedAt: NOW, expiresAt: null,
        },
      }],
      source: {
        id: 'later-compliance-source', channel: 'registry', observedAt: NOW,
        sourceRecord: { recordId: 'later-compliance-source' }, evidenceRef: 'registry-row-1',
      },
    }, personId);

    const contact = services.identities.listContactMethodsForPerson(personId)
      .find(({ normalizedValue }) => normalizedValue === '+14015551234');
    expect(contact?.complianceEvidence.federalStatus).toBe('listed');
    expect(database.raw.prepare(`
      SELECT operation, resulting_reason_code FROM contact_compliance_audit_events
      WHERE contact_method_id = ? AND operation = 'intake_merge'
    `).get(contact?.id)).toEqual({
      operation: 'intake_merge', resulting_reason_code: 'federal_dnc_listed',
    });
  });

  it('blocks outbound to a tcpa-flagged contact too', () => {
    const { personId } = importLinkedLead();
    database.raw.prepare(`UPDATE person_contact_methods SET
      federal_status = 'verified_clear', compliance_tcpa_flag = 1,
      covered_area_code = '401', compliance_source = 'ftc_download',
      scrubbed_at = '2026-08-15T00:00:00.000Z',
      compliance_expires_at = '2026-09-15T00:00:00.000Z'
      WHERE person_id = ?`).run(personId);
    const contact = database.raw.prepare(
      "SELECT id FROM person_contact_methods WHERE person_id = ? AND kind = 'phone' LIMIT 1",
    ).get(personId) as { id: string };
    expect(() => services.unitOfWork.immediate(() => services.outboundPermission.assertMayExecuteOutbound({
      channel: 'call', personId, contactMethodId: contact.id, now: NOW,
    }))).toThrowError(expect.objectContaining({ reasonCode: 'tcpa_blocked' }));
  });

  it('prunes processed-file ledger rows older than 90 days', () => {
    const old = '2026-05-01T00:00:00.000Z'; // > 90 days before NOW
    const recent = '2026-08-01T00:00:00.000Z'; // < 90 days before NOW
    database.raw.prepare(
      'INSERT INTO sourcing_processed_files (key, processed_at) VALUES (?, ?)',
    ).run('events/2026-05-01/old.ndjson', old);
    database.raw.prepare(
      'INSERT INTO sourcing_processed_files (key, processed_at) VALUES (?, ?)',
    ).run('events/2026-08-01/recent.ndjson', recent);

    const pruned = domain.pruneProcessedFileLedger();

    expect(pruned).toBe(1);
    expect(database.raw.prepare(
      'SELECT key FROM sourcing_processed_files ORDER BY key ASC',
    ).all()).toEqual([{ key: 'events/2026-08-01/recent.ndjson' }]);
  });
});
