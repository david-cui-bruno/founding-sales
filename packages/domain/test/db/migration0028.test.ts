import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { readAppliedSchemaVersion } from '../../db/migrationRunner.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from './support/fixtures.ts';

/**
 * Migration 0028 on a database at schema 27 that holds what production could hold
 * (slice W, acceptance 4).
 *
 * The old seven-stage pipeline with an admin's own stage added after Lost, and open
 * opportunities in every stage the remap moves (`contacting`, `engaged`, `proposal`),
 * one it leaves (`qualified`), and two closed ones (Won and Lost). Two of the open ones
 * were last moved by a person, which is what the pin backfill reads.
 */
describe('migration 0028 on a database at schema 27', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  const opportunities: Record<string, string> = {};
  const updatedBefore: Record<string, string> = {};
  let researchReservationId = '';

  const workspaceId = (): string => seeded.alpha.workspaceId;

  async function id(sql: string, values: readonly unknown[]): Promise<string> {
    const { rows } = await database.session.query<{ id: string }>(sql, values);
    const value = rows[0]?.id;
    if (value === undefined) throw new Error(`no row: ${sql.slice(0, 60)}`);
    return value;
  }

  async function stageId(key: string): Promise<string> {
    return await id('SELECT id FROM pipeline_stages WHERE workspace_id = $1 AND key = $2', [workspaceId(), key]);
  }

  async function firm(name: string): Promise<string> {
    return await id('INSERT INTO firms (workspace_id, name) VALUES ($1, $2) RETURNING id', [workspaceId(), name]);
  }

  /** An opportunity opened in `new`, then moved to `key` by `mover`, in schema 27's columns. */
  async function opportunityIn(label: string, key: string, mover: 'user' | 'system' | null, closed?: 'won' | 'lost'): Promise<void> {
    const firmId = await firm(`Firm ${label}`);
    const newId = await stageId('new');
    const opportunityId = await id(
      `INSERT INTO opportunities (workspace_id, firm_id, stage_id, control_mode_changed_at, opened_at, created_at, updated_at)
       VALUES ($1, $2, $3, TIMESTAMPTZ '2026-09-01 00:00:00+00', TIMESTAMPTZ '2026-09-01 00:00:00+00',
               TIMESTAMPTZ '2026-09-01 00:00:00+00', TIMESTAMPTZ '2026-09-01 00:00:00+00') RETURNING id`,
      [workspaceId(), firmId, newId],
    );
    await database.session.query(
      `INSERT INTO opportunity_stage_events (workspace_id, opportunity_id, firm_id, to_stage_id, actor_kind, actor_user_id, occurred_at)
       VALUES ($1, $2, $3, $4, 'user', $5, TIMESTAMPTZ '2026-09-01 00:00:00+00')`,
      [workspaceId(), opportunityId, firmId, newId, seeded.alpha.salesperson.userId],
    );
    if (mover !== null && key !== 'new') {
      const target = await stageId(key);
      await database.session.query(
        `INSERT INTO opportunity_stage_events
           (workspace_id, opportunity_id, firm_id, from_stage_id, to_stage_id, actor_kind, actor_user_id, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, TIMESTAMPTZ '2026-09-10 00:00:00+00')`,
        [workspaceId(), opportunityId, firmId, newId, target, mover, mover === 'user' ? seeded.alpha.salesperson.userId : null],
      );
      await database.session.query(
        `UPDATE opportunities SET stage_id = $3, status = COALESCE($4, status),
                closed_at = CASE WHEN $4::text IS NULL THEN NULL ELSE TIMESTAMPTZ '2026-09-10 00:00:00+00' END,
                close_reason = CASE WHEN $4::text = 'lost' THEN 'not a fit' ELSE NULL END,
                updated_at = TIMESTAMPTZ '2026-09-10 00:00:00+00'
          WHERE workspace_id = $1 AND id = $2`,
        [workspaceId(), opportunityId, target, closed ?? null],
      );
    }
    opportunities[label] = opportunityId;
    const { rows } = await database.session.query<{ updated_at: Date }>(
      'SELECT updated_at FROM opportunities WHERE id = $1',
      [opportunityId],
    );
    updatedBefore[label] = rows[0]?.updated_at.toISOString() ?? '';
  }

  interface OpportunityState {
    readonly key: string;
    readonly status: string;
    readonly updated_at: Date;
  }

  async function stateOf(label: string): Promise<OpportunityState> {
    const { rows } = await database.session.query<OpportunityState>(
      `SELECT s.key, o.status, o.updated_at FROM opportunities o
         JOIN pipeline_stages s ON s.workspace_id = o.workspace_id AND s.id = o.stage_id
        WHERE o.id = $1`,
      [opportunities[label]],
    );
    const row = rows[0];
    if (row === undefined) throw new Error(`no opportunity ${label}`);
    return row;
  }

  beforeAll(async () => {
    database = await createTestDatabase({ throughVersion: 27 });
    expect(await readAppliedSchemaVersion(database.session)).toBe(27);
    seeded = await seedTwoWorkspaces(database.session);

    // An admin's own stage, added after the old seven.
    await database.session.query(
      `INSERT INTO pipeline_stages (workspace_id, key, display_name, position) VALUES ($1, 'pilot', 'Pilot', 8)`,
      [workspaceId()],
    );

    await opportunityIn('contacting_by_person', 'contacting', 'user');
    await opportunityIn('engaged_by_system', 'engaged', 'system');
    await opportunityIn('proposal_by_system', 'proposal', 'system');
    await opportunityIn('qualified_by_person', 'qualified', 'user');
    await opportunityIn('new_untouched', 'new', null);
    await opportunityIn('won', 'won', 'user', 'won');
    await opportunityIn('lost', 'lost', 'user', 'lost');

    // A research reservation as schema 27 writes one: the priced shape the new CHECK
    // requires of an LLM subject, and nothing telephony.
    researchReservationId = await id(
      `INSERT INTO provider_reservations
         (workspace_id, provider_key, subject_kind, subject_id, attempt, business_date, business_time_zone,
          cents, model_name, max_input_tokens, max_output_tokens)
       VALUES ($1, 'anthropic', 'research_run', gen_random_uuid(), 1, '2026-09-29', 'America/New_York',
               3, 'claude-haiku-4-5', 1000, 600) RETURNING id`,
      [workspaceId()],
    );

    const { applyMigrations } = await import('../../db/migrationRunner.ts');
    await applyMigrations(database.session, { throughVersion: 28 });
  });

  afterAll(async () => {
    await database.drop();
  });

  it('is at schema 28', async () => {
    expect(await readAppliedSchemaVersion(database.session)).toBe(28);
  });

  it('relabels, adds and retires stages, renumbering contiguously with the terminal stages last', async () => {
    const { rows } = await database.session.query<{
      key: string;
      display_name: string;
      position: number;
      retired: boolean;
      terminal_kind: string | null;
    }>(
      'SELECT key, display_name, position, retired, terminal_kind FROM pipeline_stages WHERE workspace_id = $1 ORDER BY position',
      [workspaceId()],
    );
    expect(rows.map(row => [row.key, row.display_name, row.position, row.retired])).toEqual([
      ['new', 'Interested', 1, false],
      ['demo_booked', 'Demo booked', 2, false],
      ['qualified', 'Decision pending', 3, false],
      ['onboarding', 'Onboarding', 4, false],
      ['pilot', 'Pilot', 5, false],
      ['contacting', 'Contacting', 6, true],
      ['engaged', 'Engaged', 7, true],
      ['proposal', 'Proposal', 8, true],
      ['won', 'Live', 9, false],
      ['lost', 'Lost', 10, false],
    ]);
  });

  it('moves open contacting and engaged to new, proposal to qualified, and leaves the rest', async () => {
    expect((await stateOf('contacting_by_person')).key).toBe('new');
    expect((await stateOf('engaged_by_system')).key).toBe('new');
    expect((await stateOf('proposal_by_system')).key).toBe('qualified');
    expect((await stateOf('qualified_by_person')).key).toBe('qualified');
    expect((await stateOf('new_untouched')).key).toBe('new');
  });

  it('never touches a closed opportunity', async () => {
    const won = await stateOf('won');
    const lost = await stateOf('lost');
    expect([won.key, won.status, won.updated_at.toISOString()]).toEqual(['won', 'won', updatedBefore['won']]);
    expect([lost.key, lost.status, lost.updated_at.toISOString()]).toEqual(['lost', 'lost', updatedBefore['lost']]);
    expect((await stateOf('qualified_by_person')).updated_at.toISOString()).toBe(updatedBefore['qualified_by_person']);
  });

  it('records one system stage event per move, in order after the history it extends', async () => {
    const { rows } = await database.session.query<{
      opportunity_id: string;
      from_key: string;
      to_key: string;
      actor_kind: string;
      actor_user_id: string | null;
      occurred_at: Date;
    }>(
      `SELECT e.opportunity_id, f.key AS from_key, t.key AS to_key, e.actor_kind, e.actor_user_id, e.occurred_at
         FROM opportunity_stage_events e
         JOIN pipeline_stages f ON f.workspace_id = e.workspace_id AND f.id = e.from_stage_id
         JOIN pipeline_stages t ON t.workspace_id = e.workspace_id AND t.id = e.to_stage_id
        WHERE e.workspace_id = $1 AND e.reason = 'stage_remap_20260930'
        ORDER BY f.key`,
      [workspaceId()],
    );
    expect(rows.map(row => [row.opportunity_id, row.from_key, row.to_key, row.actor_kind, row.actor_user_id])).toEqual([
      [opportunities['contacting_by_person'], 'contacting', 'new', 'system', null],
      [opportunities['engaged_by_system'], 'engaged', 'new', 'system', null],
      [opportunities['proposal_by_system'], 'proposal', 'qualified', 'system', null],
    ]);
    for (const row of rows) expect(row.occurred_at.toISOString()).toBe('2026-09-30 00:00:00.000Z'.replace(' ', 'T'));
  });

  it('pins the open opportunities a person last moved, at the stage the remap left them in', async () => {
    const { rows } = await database.session.query<{ opportunity_id: string; key: string; pinned_by_user_id: string }>(
      `SELECT p.opportunity_id, s.key, p.pinned_by_user_id FROM opportunity_stage_pins p
         JOIN pipeline_stages s ON s.workspace_id = p.workspace_id AND s.id = p.stage_id
        WHERE p.workspace_id = $1 ORDER BY s.key`,
      [workspaceId()],
    );
    expect(rows).toEqual([
      { opportunity_id: opportunities['contacting_by_person'], key: 'new', pinned_by_user_id: seeded.alpha.salesperson.userId },
      { opportunity_id: opportunities['qualified_by_person'], key: 'qualified', pinned_by_user_id: seeded.alpha.salesperson.userId },
    ]);
  });

  it('keeps the research reservation, and requires the telephony shape of a call subject', async () => {
    const { rows } = await database.session.query<{ model_name: string; priced_unit: string | null }>(
      'SELECT model_name, priced_unit FROM provider_reservations WHERE id = $1',
      [researchReservationId],
    );
    expect(rows).toEqual([{ model_name: 'claude-haiku-4-5', priced_unit: null }]);
    await expect(
      database.session.query(
        `INSERT INTO provider_reservations
           (workspace_id, provider_key, subject_kind, subject_id, attempt, business_date, business_time_zone, cents)
         VALUES ($1, 'twilio.voice', 'call_session', gen_random_uuid(), 1, '2026-09-30', 'America/New_York', 42)`,
        [workspaceId()],
      ),
    ).rejects.toMatchObject({ constraint: 'provider_reservations_priced_shape' });
  });

  it('seeds a workspace created after it with the new set only', async () => {
    const created = await id("INSERT INTO workspaces (slug, display_name) VALUES ('after-0028', 'After') RETURNING id", []);
    const { rows } = await database.session.query<{ key: string }>(
      'SELECT key FROM pipeline_stages WHERE workspace_id = $1 ORDER BY position',
      [created],
    );
    expect(rows.map(row => row.key)).toEqual(['new', 'demo_booked', 'qualified', 'onboarding', 'won', 'lost']);
  });

  it('seeds the four stage rules', async () => {
    const { rows } = await database.session.query<{ evidence_kind: string; action: string; target_stage_key: string }>(
      'SELECT evidence_kind, action, target_stage_key FROM stage_rules ORDER BY evidence_kind',
    );
    expect(rows).toEqual([
      { evidence_kind: 'call.interested', action: 'open_if_none', target_stage_key: 'new' },
      { evidence_kind: 'customer.live', action: 'advance', target_stage_key: 'won' },
      { evidence_kind: 'meeting.booked', action: 'advance', target_stage_key: 'demo_booked' },
      { evidence_kind: 'subscription.accepted', action: 'advance', target_stage_key: 'onboarding' },
    ]);
  });

  it('gives the runtime SELECT and INSERT on mail_message_duplicates, and nothing that rewrites it', async () => {
    const { rows } = await database.session.query<{ privilege: string; granted: boolean }>(
      `SELECT p AS privilege, has_table_privilege('app_runtime', 'mail_message_duplicates', p) AS granted
         FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS p`,
    );
    expect(Object.fromEntries(rows.map(row => [row.privilege, row.granted]))).toEqual({
      SELECT: true,
      INSERT: true,
      UPDATE: false,
      DELETE: false,
    });
  });
});
