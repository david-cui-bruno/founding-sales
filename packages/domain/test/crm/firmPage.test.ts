import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import type { SessionQueryable } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext, type WorkspaceScope } from '../../db/workspaceScope.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, stageIdByKey, type SeededCrm } from '../db/support/crmFixtures.ts';
import { readFirmPage } from '../../crm/firmPage.ts';

/**
 * The Firm page read (specification 7.2, 7.3, 8.1, 15, Appendix F).
 *
 * The page is where the read matrix is most tempting to get wrong, because a page
 * is a layout and a layout wants every section to exist. Two of its sections —
 * the stage history and the holds — carry things Appendix F row 1 does not cover:
 * a Lost event carries the reason somebody typed, and a hold carries what a
 * colleague's firm is blocked from and why.
 *
 * So the response is a discriminated union, and a colleague's page has no
 * `stageHistory` key at all. An empty array would have said "there is nothing here"
 * rather than "this is not yours to see", and a client cannot tell those apart.
 */
describe('the Firm page read', () => {
  let database: TestDatabase;
  let session: SessionQueryable;
  let seeded: TwoWorkspaces;
  let crm: SeededCrm;

  let assignee: WorkspaceScope;
  let stranger: WorkspaceScope;
  let admin: WorkspaceScope;
  let betaAdmin: WorkspaceScope;

  const context = (scope: WorkspaceScope): RepositoryContext => repositoryContext(scope, session);

  beforeAll(async () => {
    database = await createTestDatabase();
    session = database.session;
    seeded = await seedTwoWorkspaces(session);
    crm = await seedCrm(session, seeded);

    const user = await session.query<{ id: string }>(
      "INSERT INTO users (google_sub, email, display_name) VALUES ('sub-page-stranger', 'stranger@example.test', 'Stranger') RETURNING id",
    );
    const strangerUserId = user.rows[0]?.id ?? '';
    await session.query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'salesperson')",
      [seeded.alpha.workspaceId, strangerUserId],
    );

    // A Lost change with its required reason (8.1), and a hold on the firm (15).
    const lost = await stageIdByKey(session, seeded.alpha.workspaceId, 'lost');
    const contacting = await stageIdByKey(session, seeded.alpha.workspaceId, 'contacting');
    await session.query(
      `INSERT INTO opportunity_stage_events (workspace_id, opportunity_id, firm_id, from_stage_id, to_stage_id,
                                             actor_kind, actor_user_id, reason, occurred_at)
       VALUES ($1, $2, $3, $4, $5, 'user', $6, 'Budget moved to next year', TIMESTAMPTZ '2026-09-03 12:00:00+00')`,
      [
        seeded.alpha.workspaceId,
        crm.alpha.opportunityId,
        crm.alpha.firmId,
        contacting,
        lost,
        seeded.alpha.salesperson.userId,
      ],
    );
    await session.query(
      `INSERT INTO active_holds (workspace_id, scope_kind, scope_key, reason_code, blocked_action_kinds,
                                 source_event_kind, recovery_action, started_at)
       VALUES ($1, 'firm', $2, 'reassignment', ARRAY['email_send','call_task']::text[], 'test',
               'resume_after_review', TIMESTAMPTZ '2026-09-04 12:00:00+00')`,
      [seeded.alpha.workspaceId, crm.alpha.firmId],
    );

    assignee = workspaceScope(seeded.alpha.workspaceId, {
      kind: 'user',
      userId: seeded.alpha.salesperson.userId,
      role: 'salesperson',
    });
    stranger = workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: strangerUserId, role: 'salesperson' });
    admin = workspaceScope(seeded.alpha.workspaceId, {
      kind: 'user',
      userId: seeded.alpha.admin.userId,
      role: 'admin',
    });
    betaAdmin = workspaceScope(seeded.beta.workspaceId, {
      kind: 'user',
      userId: seeded.beta.admin.userId,
      role: 'admin',
    });
  });

  afterAll(async () => {
    await database.drop();
  });

  it('gives the assignee the opportunity, the stage history and the holds', async () => {
    const page = await readFirmPage(context(assignee), { firmId: crm.alpha.firmId });
    expect(page.ok).toBe(true);
    if (!page.ok || page.value.visibility !== 'assigned_or_admin') {
      expect.fail('the assignee should see the detail page');
      return;
    }
    expect(page.value.opportunity?.id).toBe(crm.alpha.opportunityId);
    expect(page.value.opportunity?.controlMode).toBe('automated');

    // Append-only and in order: the seeded opening, then the Lost change.
    expect(page.value.stageHistory.map(event => event.toStageKey)).toEqual(['new', 'lost']);
    expect(page.value.stageHistory[1]?.fromStageKey).toBe('contacting');
    expect(page.value.stageHistory[1]?.reason).toBe('Budget moved to next year');
    expect(page.value.stageHistory[0]?.reason).toBeNull();

    expect(page.value.holds).toHaveLength(1);
    expect(page.value.holds[0]?.reasonCode).toBe('reassignment');
    expect(page.value.holds[0]?.blockedActionKinds).toEqual(['email_send', 'call_task']);
    expect(page.value.holds[0]?.recoveryAction).toBe('resume_after_review');
  });

  it('gives a colleague the narrow read and no history keys at all', async () => {
    const page = await readFirmPage(context(stranger), { firmId: crm.alpha.firmId });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.visibility).toBe('any_active_member');
    expect(page.value).not.toHaveProperty('stageHistory');
    expect(page.value).not.toHaveProperty('holds');
    expect(page.value).not.toHaveProperty('opportunity');
    // The Lost reason a salesperson typed is a note, and a note is not row 1's.
    expect(JSON.stringify(page.value)).not.toContain('Budget moved to next year');
  });

  it('gives an admin the detail page and writes the access audit event once', async () => {
    const before = await auditCount();
    const page = await readFirmPage(context(admin), { firmId: crm.alpha.firmId });
    expect(page.ok && page.value.visibility).toBe('assigned_or_admin');
    expect(await auditCount()).toBe(before + 1);
  });

  it('refuses a firm in the workspace next door as unknown', async () => {
    const page = await readFirmPage(context(betaAdmin), { firmId: crm.alpha.firmId });
    expect(page.ok).toBe(false);
    if (!page.ok) expect(page.reason).toBe('firm_unknown');
  });

  it('shows a firm with no opportunity as a page with none, not as a failure', async () => {
    const created = await session.query<{ id: string }>(
      "INSERT INTO firms (workspace_id, name, assigned_user_id) VALUES ($1, 'Quiet Test Co', $2) RETURNING id",
      [seeded.alpha.workspaceId, seeded.alpha.salesperson.userId],
    );
    const page = await readFirmPage(context(assignee), { firmId: created.rows[0]?.id ?? '' });
    expect(page.ok).toBe(true);
    if (!page.ok || page.value.visibility !== 'assigned_or_admin') return;
    expect(page.value.opportunity).toBeNull();
    expect(page.value.stageHistory).toEqual([]);
    expect(page.value.holds).toEqual([]);
  });

  async function auditCount(): Promise<number> {
    const { rows } = await session.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM audit_events WHERE workspace_id = $1 AND action = 'read.firm_detail'",
      [seeded.alpha.workspaceId],
    );
    return Number(rows[0]?.count ?? '0');
  }
});
