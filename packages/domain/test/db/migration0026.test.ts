import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { readAppliedSchemaVersion } from '../../db/migrationRunner.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { consumeTerminalStops } from '../../sequences/terminalStops.ts';
import { seedCrm, type SeededCrm } from './support/crmFixtures.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from './support/fixtures.ts';

/**
 * Migration 0026 on a database at schema 25 that holds what production could hold
 * (review of PR 335, P1-1 and P1-2).
 *
 *   * A **spent** permission (valid at 25): the pairing CHECK would refuse it unless the
 *     file backfills `consumed_reason = 'sent'` first.
 *   * A stop event **still queued** for the drain, and one the drain **already
 *     consumed**: the first gets the firm's live set at migration time, the second keeps
 *     NULL. After cutover an enrollment created at the same firm must survive the queued
 *     event, which the old drain-time fallback would have stopped.
 */
describe('migration 0026 on a database at schema 25', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  let crm: SeededCrm;
  let versionId = '';
  let permissionId = '';
  let queuedEventId = '';
  let consumedEventId = '';
  let owedBeforeCutover = '';
  let consumedFirmEnrollment = '';
  let otherFirmId = '';

  const workspaceId = (): string => seeded.alpha.workspaceId;
  const worker = (): RepositoryContext =>
    repositoryContext(workspaceScope(workspaceId(), { kind: 'system', component: 'worker' }), database.session);

  async function id(sql: string, values: readonly unknown[]): Promise<string> {
    const { rows } = await database.session.query<{ id: string }>(sql, values);
    const value = rows[0]?.id;
    if (value === undefined) throw new Error(`no row: ${sql.slice(0, 60)}`);
    return value;
  }

  async function contact(firmId: string, name: string): Promise<string> {
    return await id('INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, $3) RETURNING id', [
      workspaceId(),
      firmId,
      name,
    ]);
  }

  async function opportunityOf(firmId: string): Promise<string> {
    return await id(
      `INSERT INTO opportunities (workspace_id, firm_id, stage_id, control_mode_changed_at)
       SELECT $1, $2, id, now() FROM pipeline_stages WHERE workspace_id = $1 ORDER BY position LIMIT 1
       RETURNING id`,
      [workspaceId(), firmId],
    );
  }

  /** A live prospecting enrollment, in the column list schema 25 knows. */
  async function enrol(firmId: string, opportunityId: string, contactId: string): Promise<string> {
    return await id(
      `INSERT INTO sequence_enrollments
         (workspace_id, sequence_version_id, opportunity_id, firm_id, contact_id, assigned_user_id,
          firm_time_zone, holiday_calendar_version, origin_kind)
       VALUES ($1, $2, $3, $4, $5, $6, 'America/New_York', 'none.1', 'prospecting')
       RETURNING id`,
      [workspaceId(), versionId, opportunityId, firmId, contactId, seeded.alpha.admin.userId],
    );
  }

  async function state(enrollmentId: string): Promise<{ state: string; end_reason: string | null }> {
    const { rows } = await database.session.query<{ state: string; end_reason: string | null }>(
      'SELECT state, end_reason FROM sequence_enrollments WHERE id = $1',
      [enrollmentId],
    );
    return rows[0] ?? { state: 'missing', end_reason: null };
  }

  beforeAll(async () => {
    database = await createTestDatabase({ throughVersion: 25 });
    seeded = await seedTwoWorkspaces(database.session);
    crm = await seedCrm(database.session, seeded);
    const sequenceId = await id(
      'INSERT INTO sequences (workspace_id, name, created_by_user_id) VALUES ($1, $2, $3) RETURNING id',
      [workspaceId(), 'Schema 25 sequence', seeded.alpha.admin.userId],
    );
    versionId = await id(
      `INSERT INTO sequence_versions (workspace_id, sequence_id, version, state, published_at, published_by_user_id)
       VALUES ($1, $2, 1, 'published', now(), $3) RETURNING id`,
      [workspaceId(), sequenceId, seeded.alpha.admin.userId],
    );

    // P1-1: a spent permission, as the dispatch claim leaves one at 25.
    permissionId = await id(
      `INSERT INTO follow_up_permissions
         (workspace_id, firm_id, contact_id, kind, scope, booking_reference, max_steps,
          expires_at, granted_by_user_id, consumed_at)
       VALUES ($1, $2, $3, 'request', 'contextual_reply', 'cal-schema-25', 1,
               now() + interval '14 days', $4, now())
       RETURNING id`,
      [workspaceId(), crm.alpha.firmId, crm.alpha.contactId, seeded.alpha.admin.userId],
    );

    // P1-2: a stop the drain already consumed, at another firm, with a live enrollment
    // there that the stop was not about (it started after the stop was drained). The
    // cursor is written the way the schema-25 drain wrote it: through a JavaScript Date,
    // so truncated to the millisecond — the trap that would make the consumed event read
    // as queued.
    otherFirmId = await id(
      `INSERT INTO firms (workspace_id, name, time_zone, time_zone_confidence, time_zone_source, time_zone_rule_version)
       VALUES ($1, 'Consumed Stop Holdings', 'America/New_York', 'medium', 'state_default', 'firm-zone.1') RETURNING id`,
      [workspaceId()],
    );
    const otherOpportunity = await opportunityOf(otherFirmId);
    consumedEventId = await id(
      `INSERT INTO crm_domain_events (workspace_id, event_kind, firm_id, opportunity_id, dedupe_key, actor_kind, occurred_at)
       VALUES ($1, 'opportunity.manual_mode', $2, $3, 'consumed-at-25', 'system', now() - interval '1 hour')
       RETURNING id`,
      [workspaceId(), otherFirmId, otherOpportunity],
    );
    await database.session.query(
      `INSERT INTO sequence_event_cursors (workspace_id, subscriber, last_event_at, last_event_id)
       SELECT workspace_id, 'sequences.terminal_stop', date_trunc('milliseconds', occurred_at), id
         FROM crm_domain_events WHERE id = $1`,
      [consumedEventId],
    );
    consumedFirmEnrollment = await enrol(otherFirmId, otherOpportunity, await contact(otherFirmId, 'After The Stop'));

    // And a stop still queued: the seeded firm went manual, and the drain has not run.
    owedBeforeCutover = await enrol(crm.alpha.firmId, crm.alpha.opportunityId, crm.alpha.contactId);
    queuedEventId = await id(
      `INSERT INTO crm_domain_events (workspace_id, event_kind, firm_id, opportunity_id, dedupe_key, actor_kind, detail)
       VALUES ($1, 'opportunity.manual_mode', $2, $3, 'queued-at-25', 'system', '{"origin":"human_reply"}')
       RETURNING id`,
      [workspaceId(), crm.alpha.firmId, crm.alpha.opportunityId],
    );

    const { applyMigrations } = await import('../../db/migrationRunner.ts');
    await applyMigrations(database.session, { throughVersion: 26 });
  });

  afterAll(async () => {
    await database.drop();
  });

  it('reaches 26', async () => {
    expect(await readAppliedSchemaVersion(database.session)).toBe(26);
  });

  it('backfills the spent permission as sent, so the pairing CHECK holds (P1-1)', async () => {
    const { rows } = await database.session.query<{ consumed_reason: string | null }>(
      'SELECT consumed_reason FROM follow_up_permissions WHERE id = $1',
      [permissionId],
    );
    expect(rows).toEqual([{ consumed_reason: 'sent' }]);
  });

  it('snapshots the queued event and leaves the consumed one NULL (P1-2)', async () => {
    const { rows } = await database.session.query<{ id: string; owed_enrollment_ids: string[] | null }>(
      'SELECT id, owed_enrollment_ids FROM crm_domain_events WHERE id = ANY($1::uuid[])',
      [[queuedEventId, consumedEventId]],
    );
    const byId = new Map(rows.map(row => [row.id, row.owed_enrollment_ids]));
    expect(byId.get(queuedEventId)).toEqual([owedBeforeCutover]);
    expect(byId.get(consumedEventId)).toBeNull();
  });

  it('after cutover: the queued event stops exactly its set, and a new enrollment at the firm survives', async () => {
    const afterCutover = await enrol(
      crm.alpha.firmId,
      crm.alpha.opportunityId,
      await contact(crm.alpha.firmId, 'Enrolled After Cutover'),
    );
    const report = await consumeTerminalStops(worker(), { limit: 50 });
    expect(report.unmarkedEvents).toBe(0);
    expect(await state(owedBeforeCutover)).toEqual({ state: 'stopped', end_reason: 'human_reply' });
    expect(await state(afterCutover)).toEqual({ state: 'active', end_reason: null });
  });

  it('flags, and never widens, an unmarked stop event the drain meets again', async () => {
    // Only a reset cursor can make the drain re-read an event consumed before 0026.
    await database.session.query('DELETE FROM sequence_event_cursors WHERE workspace_id = $1', [workspaceId()]);
    const report = await consumeTerminalStops(worker(), { limit: 50 });
    expect(report.unmarkedEvents).toBe(1);
    expect(await state(consumedFirmEnrollment)).toEqual({ state: 'active', end_reason: null });
    const { rows } = await database.session.query<{ subject_id: string }>(
      "SELECT subject_id FROM audit_events WHERE workspace_id = $1 AND action = 'terminal_stop.unmarked_event'",
      [workspaceId()],
    );
    expect(rows.map(row => row.subject_id)).toEqual([consumedEventId]);
  });
});
