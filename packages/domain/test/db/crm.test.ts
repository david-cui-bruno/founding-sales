import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/index.ts';
import type { SessionQueryable } from '../../db/queryable.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from './support/fixtures.ts';
import { seedCrm, stageIdByKey, type SeededCrm } from './support/crmFixtures.ts';

/**
 * The CRM schema's promises, as things a real PostgreSQL refuses.
 *
 * Specification 7.2, 7.3 and 8.1 make four claims that this file turns into refused
 * inserts rather than prose: one open opportunity per firm, one active primary contact
 * per firm, the semantic composite keys `(workspace_id, contact_id, firm_id)` and
 * `(workspace_id, opportunity_id, firm_id)` that stop a child row mixing firms, and
 * the default pipeline every workspace starts with.
 *
 * Appendix G 8's two-workspace fixture is extended to CRM rows here: the same firm
 * name, contact, email address and phone number exist in both workspaces and nothing
 * crosses.
 */
describe('CRM schema', () => {
  let database: TestDatabase;
  let session: SessionQueryable;
  let seeded: TwoWorkspaces;
  let crm: SeededCrm;

  beforeAll(async () => {
    database = await createTestDatabase();
    session = database.session;
    seeded = await seedTwoWorkspaces(session);
    crm = await seedCrm(session, seeded);
  });

  afterAll(async () => {
    await database.drop();
  });

  const inTransaction = async (work: () => Promise<unknown>): Promise<unknown> => {
    await session.query('BEGIN');
    try {
      return await work();
    } finally {
      await session.query('ROLLBACK');
    }
  };

  // ------------------------------------------------------------------ pipeline
  it('seeds the seven default stages in order, with Won and Lost terminal', async () => {
    const { rows } = await session.query<{
      key: string;
      position: number;
      terminal_kind: string | null;
      retired: boolean;
    }>('SELECT key, position, terminal_kind, retired FROM pipeline_stages WHERE workspace_id = $1 ORDER BY position', [
      seeded.alpha.workspaceId,
    ]);
    expect(rows.map(row => row.key)).toEqual([
      'new',
      'contacting',
      'engaged',
      'qualified',
      'proposal',
      'won',
      'lost',
    ]);
    expect(rows.map(row => row.terminal_kind)).toEqual([null, null, null, null, null, 'won', 'lost']);
    expect(rows.every(row => !row.retired)).toBe(true);
  });

  it('gives a workspace created after the migration the same seven stages', async () => {
    const created = await session.query<{ id: string }>(
      "INSERT INTO workspaces (slug, display_name) VALUES ('gamma', 'Gamma') RETURNING id",
    );
    const { rows } = await session.query<{ count: string }>(
      'SELECT count(*) AS count FROM pipeline_stages WHERE workspace_id = $1',
      [created.rows[0]?.id],
    );
    expect(Number(rows[0]?.count)).toBe(7);
  });

  // ------------------------------------------------- one open opportunity per firm
  it('refuses a second open opportunity for the same firm', async () => {
    const stageId = await stageIdByKey(session, seeded.alpha.workspaceId, 'new');
    await expect(
      inTransaction(
        async () =>
          await session.query(
            `INSERT INTO opportunities (workspace_id, firm_id, stage_id, control_mode_changed_at)
             VALUES ($1, $2, $3, now())`,
            [seeded.alpha.workspaceId, crm.alpha.firmId, stageId],
          ),
      ),
    ).rejects.toMatchObject({ constraint: 'opportunities_one_open_per_firm' });
  });

  it('accepts a second opportunity once the first is closed', async () => {
    const won = await stageIdByKey(session, seeded.alpha.workspaceId, 'won');
    const newStage = await stageIdByKey(session, seeded.alpha.workspaceId, 'new');
    await session.query('BEGIN');
    try {
      await session.query(
        `UPDATE opportunities SET status = 'won', stage_id = $3, closed_at = now()
          WHERE workspace_id = $1 AND id = $2`,
        [seeded.alpha.workspaceId, crm.alpha.opportunityId, won],
      );
      const second = await session.query<{ id: string }>(
        `INSERT INTO opportunities (workspace_id, firm_id, stage_id, control_mode_changed_at, reopened_from_opportunity_id)
         VALUES ($1, $2, $3, now(), $4) RETURNING id`,
        [seeded.alpha.workspaceId, crm.alpha.firmId, newStage, crm.alpha.opportunityId],
      );
      expect(second.rows[0]?.id).toBeDefined();
    } finally {
      await session.query('ROLLBACK');
    }
  });

  it('refuses a lost opportunity with no reason', async () => {
    const lost = await stageIdByKey(session, seeded.alpha.workspaceId, 'lost');
    await expect(
      inTransaction(
        async () =>
          await session.query(
            `UPDATE opportunities SET status = 'lost', stage_id = $3, closed_at = now(), close_reason = NULL
              WHERE workspace_id = $1 AND id = $2`,
            [seeded.alpha.workspaceId, crm.alpha.opportunityId, lost],
          ),
      ),
    ).rejects.toMatchObject({ constraint: 'opportunities_lost_needs_reason' });
  });

  // ------------------------------------------------ one active primary per firm
  it('refuses a second active primary contact at the same firm', async () => {
    await expect(
      inTransaction(
        async () =>
          await session.query(
            `INSERT INTO contacts (workspace_id, firm_id, full_name, is_primary)
             VALUES ($1, $2, 'Second Primary', true)`,
            [seeded.alpha.workspaceId, crm.alpha.firmId],
          ),
      ),
    ).rejects.toMatchObject({ constraint: 'contacts_one_active_primary' });
  });

  it('accepts a second primary once the first is inactive, because primary is permitted and not required', async () => {
    await session.query('BEGIN');
    try {
      await session.query(
        "UPDATE contacts SET status = 'inactive' WHERE workspace_id = $1 AND id = $2",
        [seeded.alpha.workspaceId, crm.alpha.contactId],
      );
      const second = await session.query<{ id: string }>(
        `INSERT INTO contacts (workspace_id, firm_id, full_name, is_primary)
         VALUES ($1, $2, 'Second Primary', true) RETURNING id`,
        [seeded.alpha.workspaceId, crm.alpha.firmId],
      );
      expect(second.rows[0]?.id).toBeDefined();
    } finally {
      await session.query('ROLLBACK');
    }
  });

  // ------------------------------------------------------- semantic composite keys
  it('refuses a phone route whose contact belongs to another firm', async () => {
    const otherFirm = await session.query<{ id: string }>(
      "INSERT INTO firms (workspace_id, name) VALUES ($1, 'Other Test Firm') RETURNING id",
      [seeded.alpha.workspaceId],
    );
    await expect(
      inTransaction(
        async () =>
          await session.query(
            `INSERT INTO phone_routes (workspace_id, firm_id, contact_id, e164, source, retrieved_at)
             VALUES ($1, $2, $3, '+14015550144', 'salesperson', now())`,
            [seeded.alpha.workspaceId, otherFirm.rows[0]?.id, crm.alpha.contactId],
          ),
      ),
    ).rejects.toMatchObject({ constraint: 'phone_routes_contact_fkey' });
  });

  it('refuses a stage event whose opportunity belongs to another firm', async () => {
    const otherFirm = await session.query<{ id: string }>(
      "INSERT INTO firms (workspace_id, name) VALUES ($1, 'Third Test Firm') RETURNING id",
      [seeded.alpha.workspaceId],
    );
    const stageId = await stageIdByKey(session, seeded.alpha.workspaceId, 'new');
    await expect(
      inTransaction(
        async () =>
          await session.query(
            `INSERT INTO opportunity_stage_events (workspace_id, opportunity_id, firm_id, to_stage_id, actor_kind)
             VALUES ($1, $2, $3, $4, 'system')`,
            [seeded.alpha.workspaceId, crm.alpha.opportunityId, otherFirm.rows[0]?.id, stageId],
          ),
      ),
    ).rejects.toMatchObject({ constraint: 'opportunity_stage_events_opportunity_fkey' });
  });

  it('refuses a contact whose firm is in the other workspace', async () => {
    await expect(
      inTransaction(
        async () =>
          await session.query(
            `INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, 'Crossed')`,
            [seeded.alpha.workspaceId, crm.beta.firmId],
          ),
      ),
    ).rejects.toMatchObject({ constraint: 'contacts_firm_fkey' });
  });

  it('refuses a firm assigned to a member of the other workspace', async () => {
    await expect(
      inTransaction(
        async () =>
          await session.query(
            'INSERT INTO firms (workspace_id, name, assigned_user_id) VALUES ($1, $2, $3)',
            [seeded.alpha.workspaceId, 'Borrowed Assignee', seeded.beta.salesperson.userId],
          ),
      ),
    ).rejects.toMatchObject({ constraint: 'firms_assignee_fkey' });
  });

  // --------------------------------------------------------- shared handles stay explicit
  it('keeps a handle shared by two firms as two explicit rows rather than collapsing them', async () => {
    const sibling = await session.query<{ id: string }>(
      "INSERT INTO firms (workspace_id, name) VALUES ($1, 'Sibling Test Firm') RETURNING id",
      [seeded.alpha.workspaceId],
    );
    await session.query(
      `INSERT INTO email_addresses (workspace_id, firm_id, address, source, retrieved_at)
       VALUES ($1, $2, $3, 'research_provider', now())`,
      [seeded.alpha.workspaceId, sibling.rows[0]?.id, crm.collidingEmail],
    );
    const { rows } = await session.query<{ count: string }>(
      'SELECT count(*) AS count FROM email_addresses WHERE workspace_id = $1 AND address = $2',
      [seeded.alpha.workspaceId, crm.collidingEmail],
    );
    expect(Number(rows[0]?.count)).toBe(2);
  });

  it('refuses the same handle twice for the same firm and contact', async () => {
    await expect(
      inTransaction(
        async () =>
          await session.query(
            `INSERT INTO email_addresses (workspace_id, firm_id, contact_id, address, source, retrieved_at)
             VALUES ($1, $2, $3, $4, 'salesperson', now())`,
            [seeded.alpha.workspaceId, crm.alpha.firmId, crm.alpha.contactId, crm.collidingEmail],
          ),
      ),
    ).rejects.toMatchObject({ constraint: 'email_addresses_one_per_association' });
  });

  // ------------------------------------------------------------ two workspaces
  it('keeps the same firm name, contact, address and number apart in two workspaces', async () => {
    const firms = await session.query<{ workspace_id: string; id: string }>(
      'SELECT workspace_id, id FROM firms WHERE name = $1 ORDER BY workspace_id',
      [crm.collidingFirmName],
    );
    expect(firms.rows.length).toBe(2);
    expect(new Set(firms.rows.map(row => row.workspace_id)).size).toBe(2);

    const crossed = await session.query<{ id: string }>(
      'SELECT id FROM firms WHERE workspace_id = $1 AND id = $2',
      [seeded.alpha.workspaceId, crm.beta.firmId],
    );
    expect(crossed.rows).toEqual([]);

    const routes = await session.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM phone_routes WHERE e164 = $1',
      [crm.collidingE164],
    );
    expect(new Set(routes.rows.map(row => row.workspace_id)).size).toBe(2);
  });

  // -------------------------------------------------------------- append-only
  it('refuses UPDATE and DELETE of stage events, merge events and CRM domain events as app_runtime', async () => {
    const runtime = await database.appRuntimeSession();
    for (const table of ['opportunity_stage_events', 'record_merge_events', 'crm_domain_events']) {
      await expect(runtime.query(`UPDATE ${table} SET workspace_id = workspace_id`)).rejects.toMatchObject({
        code: '42501',
      });
      await expect(runtime.query(`DELETE FROM ${table}`)).rejects.toMatchObject({ code: '42501' });
    }
  });
});
