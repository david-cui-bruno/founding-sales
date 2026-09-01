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
import { validParcelEvent } from '../../fixtures/cloudSourceEvents';
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
});
