import { randomUUID } from 'node:crypto';
import type { RawDatabase } from '../../src/main/db/sqliteDriver';
import type { DomainServices } from '../../src/main/domain/createDomainServices';
import type { CreatePersonProspectCommand } from '../../src/main/domain/source/sourceService';

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
  const channel = input.channel ?? 'custom';
  const sourceRecord = JSON.stringify({
    formatVersion: 1,
    sourceRecord: { fixture: true },
    customSourceReason: channel === 'custom' ? 'manual_quick_add' : null,
  });
  input.database.prepare(`
    INSERT INTO source_events (
      id, person_id, channel, observed_at, source_record_json,
      referred_by_person_id, referrer_unknown_reason, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.personId,
    channel,
    DOMAIN_TIMESTAMP,
    sourceRecord,
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
      input.stage ?? 'ready',
      actionId,
      DOMAIN_TIMESTAMP,
      DOMAIN_TIMESTAMP,
      DOMAIN_TIMESTAMP,
    );
    // Pre-0010 schemas (migration tests) still carry NOT NULL due_at.
    const hasDueAt = (input.database.prepare(
      'PRAGMA table_info(next_actions)',
    ).all() as { name: string }[]).some(({ name }) => name === 'due_at');
    if (hasDueAt) {
      input.database.prepare(`
        INSERT INTO next_actions (
          id, sales_cycle_id, action_type, channel, status, due_at,
          timezone, work_intent, created_at
        ) VALUES (?, ?, 'follow_up', NULL, 'pending', ?, 'America/New_York', 'promised_follow_up', ?)
      `).run(actionId, cycleId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    } else {
      input.database.prepare(`
        INSERT INTO next_actions (
          id, sales_cycle_id, action_type, channel, status,
          timezone, work_intent, created_at
        ) VALUES (?, ?, 'follow_up', NULL, 'pending', 'America/New_York', 'promised_follow_up', ?)
      `).run(actionId, cycleId, DOMAIN_TIMESTAMP);
    }
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

/**
 * Admits named people through the real intake service the removed CSV/paste
 * importer composed: one source event per row, a direct email contact,
 * organization membership by canonical name, and a fresh Unreviewed cycle for
 * every created prospect. Test seeding only; no IPC channel exists for it.
 */
export function seedIntakePeople(
  services: Pick<DomainServices, 'sources' | 'lifecycle'>,
  input: {
    channel: 'registry' | 'custom';
    sourceName: string;
    observedAt: string;
    ids?: { next(): string };
    rows: { displayName: string; email?: string; organization?: string }[];
  },
): { personId: string; prospectId: string; sourceEventId: string }[] {
  const ids = input.ids ?? { next: randomUUID };
  const commands = input.rows.map((row, index): CreatePersonProspectCommand => {
    const base = {
      person: { displayName: row.displayName },
      contacts: row.email === undefined ? [] : [{ kind: 'email' as const, value: row.email, reachability: 'direct' as const, isPrimary: true }],
      organizations: row.organization === undefined ? [] : [{ canonicalName: row.organization }],
      properties: [] as never[],
    };
    const source = { id: ids.next(), observedAt: input.observedAt,
      sourceRecord: { formatVersion: 1, importSourceName: input.sourceName, rowNumber: index + 2 } };
    return input.channel === 'custom'
      ? { ...base, source: { ...source, channel: 'custom', customSourceReason: 'csv_import' }, segment: 'warm' }
      : { ...base, source: { ...source, channel: 'registry' } };
  });
  const results = services.sources.commitBatch(commands);
  for (const result of results) {
    if (result.disposition !== 'created') continue;
    services.lifecycle.createUnreviewedCycle({ personId: result.personId, prospectId: result.prospectId,
      entrySourceEventId: result.sourceEventId, effectiveAt: input.observedAt });
  }
  return results.map(({ personId, prospectId, sourceEventId }) => ({ personId, prospectId, sourceEventId }));
}

/**
 * The removed call-outcome command's durable effect for a 'spoke' call with a
 * promised callback: one outbound call activity carrying callback_at, the
 * cycle's resurface marker, and the current action re-dated to the promise
 * (recorded_callback). A post-stage non-call action keeps its own due date,
 * exactly as the command did. Closed cycles only receive the activity.
 */
export function recordPromisedCallback(
  services: Pick<DomainServices, 'events' | 'unitOfWork'>,
  database: RawDatabase,
  input: { personId: string; salesCycleId: string; occurredAt: string; callbackAt: string; now: string; activityId?: string },
): { activityId: string } {
  const cycle = database.prepare(
    'SELECT prospect_id, stage, workflow_status, current_next_action_id, version FROM sales_cycles WHERE id = ?',
  ).get(input.salesCycleId) as {
    prospect_id: string; stage: string; workflow_status: string; current_next_action_id: string | null; version: number;
  } | undefined;
  if (cycle === undefined) throw new Error(`Callback fixture: unknown sales cycle ${input.salesCycleId}`);
  const activityId = input.activityId ?? randomUUID();
  services.unitOfWork.immediate(() => {
    services.events.appendActivity({ id: activityId, personId: input.personId, prospectId: cycle.prospect_id,
      salesCycleId: input.salesCycleId, kind: 'call', direction: 'outbound', channel: 'phone',
      occurredAt: input.occurredAt, observedOutcome: 'spoke', callOutcome: 'spoke', callbackAt: input.callbackAt,
      metadata: { formatVersion: 1, loggedVia: 'call_outcome', loggedManually: true } });
    if (cycle.workflow_status === 'closed') return;
    const changed = database.prepare(`
      UPDATE sales_cycles
      SET resurface_at = ?, resurface_reason = 'callback', version = version + 1, updated_at = ?
      WHERE id = ? AND version = ? AND workflow_status IN ('active','onboarding')
    `).run(input.callbackAt, input.now, input.salesCycleId, cycle.version);
    if (changed.changes !== 1) throw new Error('Callback fixture: the cycle changed concurrently.');
    if (cycle.current_next_action_id === null) return;
    const independentPostStage = ['interviewed', 'offered', 'won'].includes(cycle.stage);
    const action = database.prepare(`
      UPDATE next_actions
      SET due_at = CASE WHEN ? AND action_type <> 'call' THEN due_at ELSE ? END,
        due_source = CASE WHEN ? AND action_type <> 'call' THEN due_source ELSE 'recorded_callback' END,
        version = version + 1, updated_at = ?
      WHERE id = ? AND sales_cycle_id = ? AND status = 'pending'
    `).run(Number(independentPostStage), input.callbackAt, Number(independentPostStage), input.now,
      cycle.current_next_action_id, input.salesCycleId);
    if (action.changes !== 1) throw new Error('Callback fixture: the current action changed concurrently.');
  });
  return { activityId };
}
