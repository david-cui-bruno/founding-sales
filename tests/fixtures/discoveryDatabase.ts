import { createHash, randomUUID } from 'node:crypto';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import type { DomainServices } from '../../src/main/domain/createDomainServices';
import type { RawDatabase } from '../../src/main/db/sqliteDriver';
import type { CreatePersonProspectCommand } from '../../src/main/domain/source/sourceService';
import { DomainRuntime } from '../../src/main/domain/domainRuntime';
import { mapCloudSourceEvent } from './intakeMapper';
import type { WorkspaceKey } from '../../src/main/security/workspaceKeyTypes';
import { cloudSourceEventSchema } from '../../src/shared/contracts/cloudSourceEventContract';
import { discoveryAssessmentSchema, type DiscoveryAssessment } from '../../src/shared/contracts/discoveryContract';
import { validParcelEvent } from './cloudSourceEvents';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from './tempDatabase';

export const DISCOVERY_NOW = '2026-09-06T12:00:00.000Z';
export type DiscoveryDatabase = {
  database: AppDatabase; services: DomainServices; temp: TempDatabase; key: WorkspaceKey;
  close(): void;
};

export async function createDiscoveryDatabase(): Promise<DiscoveryDatabase> {
  const temp = createTempDatabase();
  const key = createTestWorkspaceKey();
  const database = openDatabase({ path: temp.path, key });
  try {
    await migrateToLatest(database, { backupDirectory: `${temp.path}.backups`, workspaceKey: key });
    const runtime = new DomainRuntime({ database, clock: { now: () => DISCOVERY_NOW }, ids: { next: randomUUID } });
    runtime.initialize();
    return { database, services: runtime.getServices(), temp, key, close() {
      runtime.shutdown();
      if (database.raw.open) closeDatabase(database);
      key.bytes.fill(0);
      temp.cleanup();
    } };
  } catch (error) {
    closeDatabase(database); key.bytes.fill(0); temp.cleanup(); throw error;
  }
}

export function seedDiscoveryOwner(
  fixture: Pick<DiscoveryDatabase, 'services'> & { database?: AppDatabase },
  input: { prefix: string; units: number | null; legacyUnreviewed?: boolean },
): { personId: string; prospectId: string; salesCycleId: string; sourceEventId: string } {
  const event = validParcelEvent();
  const fingerprint = createHash('sha256').update(input.prefix).digest('hex');
  event.idempotency_key = fingerprint;
  event.id = `se_0${fingerprint.slice(0, 25).toUpperCase()}`;
  event.entity.cloud_entity_id = `ce_0${fingerprint.slice(0, 25).toUpperCase()}`;
  event.entity.person!.org_names = [];
  event.entity.property!.parcel_id = `SYNTHETIC-${input.prefix}`;
  event.source_uri = `fixture:parcel:${input.prefix}`;
  event.entity.person!.full_name = `${input.prefix} Property Owner`;
  event.entity.person!.phones = [];
  event.entity.person!.emails = [];
  event.entity.property!.situs_address.line1 = `${input.prefix} Hope St`;
  event.entity.property!.unit_count = input.units;
  const validated = cloudSourceEventSchema.parse(event);
  const mapped = mapCloudSourceEvent(validated);
  if (mapped.kind !== 'intake') throw new Error('Expected synthetic parcel intake.');
  const intake = fixture.services.sources.createPersonProspect(mapped.command);
  // Historical migration fixtures must use the historical schema, not today's
  // writer, which intentionally requires dated actions from migration 0018.
  if (input.legacyUnreviewed) {
    if (!fixture.database) throw new Error('Legacy fixture requires its database.');
    const id = randomUUID();
    fixture.services.unitOfWork.immediate(() => {
      fixture.database!.raw.prepare(`INSERT INTO sales_cycles (id, person_id, prospect_id, entry_source_event_id,
        stage, workflow_status, current_next_action_id, stage_entered_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'unreviewed', 'active', NULL, ?, ?, ?)`)
        .run(id, intake.personId, intake.prospectId, intake.sourceEventId, DISCOVERY_NOW, DISCOVERY_NOW, DISCOVERY_NOW);
      fixture.services.events.appendStageEvent({ id: randomUUID(), salesCycleId: id, fromStage: null,
        toStage: 'unreviewed', effectiveAt: DISCOVERY_NOW, confirmedAt: DISCOVERY_NOW,
        confirmationKind: 'mechanical', transitionSequence: 1 });
    });
    return { personId: intake.personId, prospectId: intake.prospectId, sourceEventId: intake.sourceEventId, salesCycleId: id };
  }
  const cycle = fixture.services.lifecycle.createUnreviewedCycle({
    personId: intake.personId, prospectId: intake.prospectId,
    entrySourceEventId: intake.sourceEventId, effectiveAt: DISCOVERY_NOW,
  });
  return { personId: intake.personId, prospectId: intake.prospectId,
    sourceEventId: intake.sourceEventId, salesCycleId: cycle.id };
}

export function discoveryAssessment(
  owner: ReturnType<typeof seedDiscoveryOwner>, overrides: Partial<DiscoveryAssessment> = {},
): DiscoveryAssessment {
  return discoveryAssessmentSchema.parse({
    id: randomUUID(), personId: owner.personId, prospectId: owner.prospectId,
    salesCycleId: owner.salesCycleId, fingerprint: 'a'.repeat(64), policyVersion: 'discovery-v1',
    ruleVersionId: 'founder-priority-v1', modelVersion: null,
    evaluatedAt: DISCOVERY_NOW, expiresAt: '2026-09-07T12:00:00.000Z', localDate: '2026-09-06',
    overrideId: null, disposition: 'candidate', reasonCodes: ['supported_owner'],
    axes: { fit: { points: 15, band: 'medium', completeness: 'partial' },
      timing: { milliPoints: 0, band: 'cold', hasSupportedTrigger: false }, reachability: 'none' },
    claims: [{ id: 'observation', label: 'Parcel source observed', value: '2026-08-30T00:00:00.000Z', certainty: 'fact',
      refs: [{ kind: 'source', sourceEventId: owner.sourceEventId, field: 'observed_at',
        observedAt: '2026-08-30T00:00:00.000Z' }] }],
    unknowns: ['Management style'], questions: ['How is maintenance handled?'],
    identitySupported: true, needsResearch: false,
    ranking: { priority: 'p3', earliestTriggerExpiresAt: null, dataConfidence: 2,
      lastContactAt: null, latestSourceObservedAt: '2026-08-30T00:00:00.000Z' },
    ...overrides,
  });
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
