import type { RawDatabase } from '../../src/main/db/sqliteDriver';

export const DOMAIN_TIMESTAMP = '2026-08-30T12:00:00.000Z';

export type SeededProspect = {
  personId: string;
  prospectId: string;
  sourceEventId: string;
};

export function insertPerson(database: RawDatabase, personId: string): void {
  database.prepare(`
    INSERT INTO persons (
      id, display_name, aliases_json, opted_out, never_record, version,
      created_at, updated_at
    ) VALUES (?, ?, '[]', 0, 0, 1, ?, ?)
  `).run(personId, `Person ${personId}`, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
}

export function insertSourceEvent(input: {
  database: RawDatabase;
  id: string;
  personId: string;
  channel?: string;
  referredByPersonId?: string | null;
  referrerUnknownReason?: string | null;
}): void {
  input.database.prepare(`
    INSERT INTO source_events (
      id, person_id, channel, observed_at, source_record_json,
      referred_by_person_id, referrer_unknown_reason, created_at
    ) VALUES (?, ?, ?, ?, '{}', ?, ?, ?)
  `).run(
    input.id,
    input.personId,
    input.channel ?? 'custom',
    DOMAIN_TIMESTAMP,
    input.referredByPersonId ?? null,
    input.referrerUnknownReason ?? null,
    DOMAIN_TIMESTAMP,
  );
}

export function insertProspect(input: {
  database: RawDatabase;
  id: string;
  personId: string;
  sourceEventId: string;
}): void {
  input.database.prepare(`
    INSERT INTO prospects (
      id, person_id, original_source_event_id, segment, qualification_state,
      version, created_at, updated_at
    ) VALUES (?, ?, ?, 'warm', 'eligible', 1, ?, ?)
  `).run(
    input.id,
    input.personId,
    input.sourceEventId,
    DOMAIN_TIMESTAMP,
    DOMAIN_TIMESTAMP,
  );
}

export function seedProspect(
  database: RawDatabase,
  prefix: string,
): SeededProspect {
  const personId = `${prefix}-person`;
  const prospectId = `${prefix}-prospect`;
  const sourceEventId = `${prefix}-source`;
  insertPerson(database, personId);
  insertSourceEvent({ database, id: sourceEventId, personId });
  insertProspect({ database, id: prospectId, personId, sourceEventId });
  return { personId, prospectId, sourceEventId };
}

export function insertOpenCycleWithAction(input: {
  database: RawDatabase;
  prefix: string;
  prospect: SeededProspect;
  stage?: 'unreviewed' | 'ready' | 'contacted' | 'interviewed' | 'offered';
}): { actionId: string; cycleId: string } {
  const cycleId = `${input.prefix}-cycle`;
  const actionId = `${input.prefix}-action`;
  input.database.exec('BEGIN IMMEDIATE');
  try {
    input.database.prepare(`
      INSERT INTO sales_cycles (
        id, person_id, prospect_id, entry_source_event_id, stage,
        workflow_status, current_next_action_id, stage_entered_at,
        version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, 1, ?, ?)
    `).run(
      cycleId,
      input.prospect.personId,
      input.prospect.prospectId,
      input.prospect.sourceEventId,
      input.stage ?? 'unreviewed',
      actionId,
      DOMAIN_TIMESTAMP,
      DOMAIN_TIMESTAMP,
      DOMAIN_TIMESTAMP,
    );
    input.database.prepare(`
      INSERT INTO next_actions (
        id, sales_cycle_id, action_type, channel, status, due_at,
        timezone, created_at
      ) VALUES (?, ?, 'review_lead', NULL, 'pending', ?, 'America/New_York', ?)
    `).run(actionId, cycleId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    input.database.exec('COMMIT');
  } catch (error) {
    if (input.database.inTransaction) {
      input.database.exec('ROLLBACK');
    }
    throw error;
  }
  return { actionId, cycleId };
}

export function insertClosedCycle(input: {
  database: RawDatabase;
  prefix: string;
  prospect: SeededProspect;
}): string {
  const cycleId = `${input.prefix}-cycle`;
  input.database.prepare(`
    INSERT INTO sales_cycles (
      id, person_id, prospect_id, entry_source_event_id, stage,
      workflow_status, current_next_action_id, stage_entered_at,
      close_reason, closed_at, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'lost_nurture', 'closed', NULL, ?,
              'no_response', ?, 1, ?, ?)
  `).run(
    cycleId,
    input.prospect.personId,
    input.prospect.prospectId,
    input.prospect.sourceEventId,
    DOMAIN_TIMESTAMP,
    DOMAIN_TIMESTAMP,
    DOMAIN_TIMESTAMP,
    DOMAIN_TIMESTAMP,
  );
  return cycleId;
}

export function insertCadenceDefinition(
  database: RawDatabase,
  id: string,
): void {
  database.prepare(`
    INSERT INTO cadence_definitions (
      id, family, version, name, content_hash, attempt_cap,
      definition_json, created_at
    ) VALUES (?, 'warm', 1, ?, ?, 4, '{}', ?)
  `).run(id, id, `hash-${id}`, DOMAIN_TIMESTAMP);
}
