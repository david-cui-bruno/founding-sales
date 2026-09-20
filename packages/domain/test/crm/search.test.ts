import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/index.ts';
import type { SessionQueryable } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext, type WorkspaceScope } from '../../db/workspaceScope.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, stageIdByKey, type SeededCrm } from '../db/support/crmFixtures.ts';
import { searchFirms } from '../../crm/search.ts';

/**
 * CRM search (specification 7.2, Appendix F, Appendix G 8).
 *
 * Two things are being proved, and only one of them is about finding records.
 *
 * **Nothing crosses a workspace.** The fixture puts the same firm name, the same
 * email address and the same phone number in both workspaces, which is exactly the
 * shape Appendix G 8 asks for. A search in alpha that returned beta's row would be
 * the most boring possible tenancy breach and the easiest one to write by accident,
 * because a search query is the one place a developer reaches for `ILIKE` and
 * forgets the scope.
 *
 * **Search does not become an oracle for what Appendix F redacts.** A salesperson
 * may see a colleague's firm at identity visibility only. If searching a colleague's
 * prospect's private email address returned that firm, the salesperson would have
 * learned the address is at that firm — the exact fact the read matrix withholds. So
 * the fields a term is matched against are the caller's visibility class, not a
 * filter applied to the results afterwards.
 */
describe('CRM search', () => {
  let database: TestDatabase;
  let session: SessionQueryable;
  let seeded: TwoWorkspaces;
  let crm: SeededCrm;

  let assignee: WorkspaceScope;
  let stranger: WorkspaceScope;
  let admin: WorkspaceScope;
  let betaAssignee: WorkspaceScope;
  let strangerUserId: string;
  /** A second firm in alpha, assigned to the stranger, with its own private route. */
  let othersFirmId: string;

  const context = (scope: WorkspaceScope): RepositoryContext => repositoryContext(scope, session);

  beforeAll(async () => {
    database = await createTestDatabase();
    session = database.session;
    seeded = await seedTwoWorkspaces(session);
    crm = await seedCrm(session, seeded);

    const user = await session.query<{ id: string }>(
      "INSERT INTO users (google_sub, email, display_name) VALUES ('sub-search-stranger', 'stranger@example.test', 'Stranger') RETURNING id",
    );
    strangerUserId = user.rows[0]?.id ?? '';
    await session.query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'salesperson')",
      [seeded.alpha.workspaceId, strangerUserId],
    );

    const other = await session.query<{ id: string }>(
      `INSERT INTO firms (workspace_id, name, assigned_user_id, website, address_line, locality, region_code, postal_code)
       VALUES ($1, 'Larkspur Test Foundry', $2, 'https://larkspur.example.test',
               '14 Sample Way', 'Pawtucket', 'RI', '02860')
       RETURNING id`,
      [seeded.alpha.workspaceId, strangerUserId],
    );
    othersFirmId = other.rows[0]?.id ?? '';
    const otherContact = await session.query<{ id: string }>(
      `INSERT INTO contacts (workspace_id, firm_id, full_name, title)
       VALUES ($1, $2, 'Robin Placeholder', 'Buyer') RETURNING id`,
      [seeded.alpha.workspaceId, othersFirmId],
    );
    await session.query(
      `INSERT INTO email_addresses (workspace_id, firm_id, contact_id, address, source, retrieved_at)
       VALUES ($1, $2, $3, 'robin.placeholder@larkspur.example.test', 'import', TIMESTAMPTZ '2026-09-02 12:00:00+00')`,
      [seeded.alpha.workspaceId, othersFirmId, otherContact.rows[0]?.id ?? ''],
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
    betaAssignee = workspaceScope(seeded.beta.workspaceId, {
      kind: 'user',
      userId: seeded.beta.salesperson.userId,
      role: 'salesperson',
    });
  });

  afterAll(async () => {
    await database.drop();
  });

  // ------------------------------------------------------- Appendix G 8: tenancy
  it('finds the firm in the caller’s workspace and never the identical one next door', async () => {
    const inAlpha = await searchFirms(context(assignee), { term: crm.collidingFirmName });
    expect(inAlpha.ok).toBe(true);
    if (!inAlpha.ok) return;
    expect(inAlpha.value.hits.map(hit => hit.firm.id)).toEqual([crm.alpha.firmId]);

    const inBeta = await searchFirms(context(betaAssignee), { term: crm.collidingFirmName });
    expect(inBeta.ok).toBe(true);
    if (!inBeta.ok) return;
    expect(inBeta.value.hits.map(hit => hit.firm.id)).toEqual([crm.beta.firmId]);
  });

  it('never crosses a workspace on a colliding email address or phone number', async () => {
    for (const term of [crm.collidingEmail, crm.collidingE164]) {
      const found = await searchFirms(context(assignee), { term });
      expect(found.ok, term).toBe(true);
      if (!found.ok) continue;
      expect(found.value.hits.map(hit => hit.firm.id), term).toEqual([crm.alpha.firmId]);
    }
  });

  // ------------------------------------------------- Appendix F: the read matrix
  it('matches a colleague’s firm on its identity fields and returns the narrow DTO', async () => {
    const found = await searchFirms(context(stranger), { term: crm.collidingFirmName });
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    const hit = found.value.hits[0];
    expect(hit?.firm.id).toBe(crm.alpha.firmId);
    expect(hit?.visibility).toBe('any_active_member');
    expect(hit?.matchedOn).toEqual(['name']);
    // The narrow DTO has no field an address, a contact or a route could occupy.
    expect(hit?.firm).not.toHaveProperty('contacts');
    expect(hit?.firm).not.toHaveProperty('addressLine');
  });

  it('does not let a salesperson find a colleague’s firm by a route or a contact', async () => {
    for (const term of [crm.collidingEmail, crm.collidingE164, 'Dana Example']) {
      const found = await searchFirms(context(stranger), { term });
      expect(found.ok, term).toBe(true);
      if (!found.ok) continue;
      expect(found.value.hits.map(hit => hit.firm.id), term).toEqual([]);
    }
  });

  it('lets the assignee and an admin match on the fields the matrix gives them', async () => {
    for (const scope of [assignee, admin]) {
      const byEmail = await searchFirms(context(scope), { term: crm.collidingEmail });
      expect(byEmail.ok).toBe(true);
      if (!byEmail.ok) continue;
      expect(byEmail.value.hits.map(hit => hit.firm.id)).toEqual([crm.alpha.firmId]);
      expect(byEmail.value.hits[0]?.matchedOn).toContain('email');
    }

    // The admin reaches every firm's private fields; the assignee reaches only theirs.
    const adminOnOther = await searchFirms(context(admin), { term: 'robin.placeholder@larkspur.example.test' });
    expect(adminOnOther.ok).toBe(true);
    if (adminOnOther.ok) expect(adminOnOther.value.hits.map(hit => hit.firm.id)).toEqual([othersFirmId]);

    const assigneeOnOther = await searchFirms(context(assignee), { term: 'robin.placeholder@larkspur.example.test' });
    expect(assigneeOnOther.ok).toBe(true);
    if (assigneeOnOther.ok) expect(assigneeOnOther.value.hits).toEqual([]);
  });

  it('matches a partial term inside a name, a domain and a number', async () => {
    const byPartOfName = await searchFirms(context(assignee), { term: 'orthwind' });
    expect(byPartOfName.ok && byPartOfName.value.hits.map(hit => hit.firm.id)).toEqual([crm.alpha.firmId]);

    const byDomain = await searchFirms(context(assignee), { term: 'northwind.example.test' });
    expect(byDomain.ok && byDomain.value.hits.map(hit => hit.firm.id)).toEqual([crm.alpha.firmId]);
    expect(byDomain.ok && byDomain.value.hits[0]?.matchedOn).toContain('domain');

    const byPartOfNumber = await searchFirms(context(assignee), { term: '5550187' });
    expect(byPartOfNumber.ok && byPartOfNumber.value.hits.map(hit => hit.firm.id)).toEqual([crm.alpha.firmId]);
  });

  it('treats a term with SQL metacharacters as text, not as a pattern', async () => {
    for (const term of ['%', '_', "' OR 1=1 --", '\\']) {
      const found = await searchFirms(context(admin), { term });
      expect(found.ok, term).toBe(true);
      if (!found.ok) continue;
      expect(found.value.hits, term).toEqual([]);
    }
  });

  // ------------------------------------------------------------------- filters
  it('filters by owner, including the firms nobody owns', async () => {
    const unowned = await session.query<{ id: string }>(
      "INSERT INTO firms (workspace_id, name) VALUES ($1, 'Unassigned Test Works') RETURNING id",
      [seeded.alpha.workspaceId],
    );
    const unownedId = unowned.rows[0]?.id ?? '';

    const mine = await searchFirms(context(admin), { filters: { owner: { userId: seeded.alpha.salesperson.userId } } });
    expect(mine.ok && mine.value.hits.map(hit => hit.firm.id)).toEqual([crm.alpha.firmId]);

    const nobodys = await searchFirms(context(admin), { filters: { owner: { unassigned: true } } });
    expect(nobodys.ok && nobodys.value.hits.map(hit => hit.firm.id)).toEqual([unownedId]);
  });

  it('filters by pipeline stage', async () => {
    const atNew = await searchFirms(context(admin), { filters: { stageKey: 'new' } });
    expect(atNew.ok && atNew.value.hits.map(hit => hit.firm.id)).toEqual([crm.alpha.firmId]);

    const wonStage = await stageIdByKey(session, seeded.alpha.workspaceId, 'won');
    await session.query('UPDATE opportunities SET stage_id = $3 WHERE workspace_id = $1 AND id = $2', [
      seeded.alpha.workspaceId,
      crm.alpha.opportunityId,
      wonStage,
    ]);
    const stillAtNew = await searchFirms(context(admin), { filters: { stageKey: 'new' } });
    expect(stillAtNew.ok && stillAtNew.value.hits).toEqual([]);
    const atWon = await searchFirms(context(admin), { filters: { stageKey: 'won' } });
    expect(atWon.ok && atWon.value.hits.map(hit => hit.firm.id)).toEqual([crm.alpha.firmId]);

    const firstStage = await stageIdByKey(session, seeded.alpha.workspaceId, 'new');
    await session.query('UPDATE opportunities SET stage_id = $3 WHERE workspace_id = $1 AND id = $2', [
      seeded.alpha.workspaceId,
      crm.alpha.opportunityId,
      firstStage,
    ]);
  });

  it('refuses a stage key the workspace does not have, rather than answering nothing', async () => {
    const found = await searchFirms(context(admin), { filters: { stageKey: 'not-a-stage' } });
    expect(found.ok).toBe(false);
    if (!found.ok) expect(found.reason).toBe('stage_unknown');
  });

  it('filters by hold reason', async () => {
    await session.query(
      `INSERT INTO active_holds (workspace_id, scope_kind, scope_key, reason_code, blocked_action_kinds, source_event_kind)
       VALUES ($1, 'firm', $2, 'reassignment', ARRAY['email_send']::text[], 'test')`,
      [seeded.alpha.workspaceId, crm.alpha.firmId],
    );
    const held = await searchFirms(context(admin), { filters: { holdReasonCode: 'reassignment' } });
    expect(held.ok && held.value.hits.map(hit => hit.firm.id)).toEqual([crm.alpha.firmId]);

    const otherReason = await searchFirms(context(admin), { filters: { holdReasonCode: 'scoped_pause' } });
    expect(otherReason.ok && otherReason.value.hits).toEqual([]);

    await session.query("UPDATE active_holds SET released_at = now() WHERE workspace_id = $1", [
      seeded.alpha.workspaceId,
    ]);
    const released = await searchFirms(context(admin), { filters: { holdReasonCode: 'reassignment' } });
    expect(released.ok && released.value.hits).toEqual([]);
  });

  it('filters by route eligibility', async () => {
    const usable = await searchFirms(context(admin), { filters: { routeEligibility: 'usable' } });
    expect(usable.ok && usable.value.hits.map(hit => hit.firm.id)).toEqual([crm.alpha.firmId]);

    const candidates = await searchFirms(context(admin), { filters: { routeEligibility: 'candidate' } });
    expect(candidates.ok && candidates.value.hits.map(hit => hit.firm.id)).toEqual([othersFirmId]);
  });

  it('filters by activity date, reporting the instant it used', async () => {
    const all = await searchFirms(context(admin), {});
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    const active = all.value.hits.find(hit => hit.firm.id === crm.alpha.firmId);
    expect(active?.lastActivityAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);

    const since = await searchFirms(context(admin), { filters: { activeSince: new Date('2100-01-01T00:00:00Z') } });
    expect(since.ok && since.value.hits).toEqual([]);

    const until = await searchFirms(context(admin), { filters: { activeUntil: new Date('2000-01-01T00:00:00Z') } });
    expect(until.ok && until.value.hits).toEqual([]);
  });

  it('answers the sequence-status filter from the enrollment table (7.2)', async () => {
    // A live enrollment, written directly: this test is about the filter, and the
    // enrollment command has its own tests in `test/sequences`.
    const sequenceId = await session.query<{ id: string }>(
      "INSERT INTO sequences (workspace_id, name, created_by_user_id) VALUES ($1, 'Outreach', $2) RETURNING id",
      [seeded.alpha.workspaceId, seeded.alpha.admin.userId],
    );
    const versionId = await session.query<{ id: string }>(
      'INSERT INTO sequence_versions (workspace_id, sequence_id, version) VALUES ($1, $2, 1) RETURNING id',
      [seeded.alpha.workspaceId, sequenceId.rows[0]?.id],
    );
    const enrollment = await session.query<{ id: string }>(
      `INSERT INTO sequence_enrollments
         (workspace_id, sequence_version_id, opportunity_id, firm_id, contact_id, assigned_user_id,
          firm_time_zone, holiday_calendar_version)
       VALUES ($1, $2, $3, $4, $5, $6, 'America/New_York', 'none.1') RETURNING id`,
      [
        seeded.alpha.workspaceId,
        versionId.rows[0]?.id,
        crm.alpha.opportunityId,
        crm.alpha.firmId,
        crm.alpha.contactId,
        seeded.alpha.salesperson.userId,
      ],
    );

    const active = await searchFirms(context(admin), { filters: { sequenceStatus: 'active' } });
    expect(active.ok && active.value.hits.map(hit => hit.firm.id)).toEqual([crm.alpha.firmId]);

    const none = await searchFirms(context(admin), { filters: { sequenceStatus: 'none' } });
    expect(none.ok && none.value.hits.map(hit => hit.firm.id)).not.toContain(crm.alpha.firmId);
    expect(none.ok && none.value.hits.length).toBeGreaterThan(0);

    // Stopped is the absence of a live enrollment plus the presence of a stopped one.
    await session.query(
      `UPDATE sequence_enrollments
          SET state = 'stopped', ended_at = now(), end_reason = 'admin_stop'
        WHERE workspace_id = $1 AND id = $2`,
      [seeded.alpha.workspaceId, enrollment.rows[0]?.id],
    );
    const stopped = await searchFirms(context(admin), { filters: { sequenceStatus: 'stopped' } });
    expect(stopped.ok && stopped.value.hits.map(hit => hit.firm.id)).toEqual([crm.alpha.firmId]);
    const stillActive = await searchFirms(context(admin), { filters: { sequenceStatus: 'active' } });
    expect(stillActive.ok && stillActive.value.hits).toEqual([]);

    await session.query('DELETE FROM sequence_enrollments WHERE workspace_id = $1', [
      seeded.alpha.workspaceId,
    ]);
  });

  it('bounds the answer and says when it was truncated', async () => {
    const limited = await searchFirms(context(admin), { limit: 1 });
    expect(limited.ok && limited.value.hits.length).toBe(1);
    expect(limited.ok && limited.value.truncated).toBe(true);

    const everything = await searchFirms(context(admin), { limit: 500 });
    expect(everything.ok && everything.value.truncated).toBe(false);
  });

  it('refuses a limit that is not a positive whole number', async () => {
    for (const limit of [0, -1, 1.5, 1_000_000]) {
      const found = await searchFirms(context(admin), { limit });
      expect(found.ok, String(limit)).toBe(false);
      if (!found.ok) expect(found.reason).toBe('invalid_input');
    }
  });

  it('leaves a merged firm out of the results', async () => {
    const merged = await session.query<{ id: string }>(
      `INSERT INTO firms (workspace_id, name, status, merged_into_firm_id)
       VALUES ($1, 'Northwind Test Holdings (old)', 'merged', $2) RETURNING id`,
      [seeded.alpha.workspaceId, crm.alpha.firmId],
    );
    const found = await searchFirms(context(admin), { term: 'Northwind Test Holdings (old)' });
    expect(found.ok && found.value.hits).toEqual([]);
    await session.query('DELETE FROM firms WHERE workspace_id = $1 AND id = $2', [
      seeded.alpha.workspaceId,
      merged.rows[0]?.id ?? '',
    ]);
  });
});
