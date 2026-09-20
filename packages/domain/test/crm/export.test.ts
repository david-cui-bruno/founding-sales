import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/index.ts';
import type { SessionQueryable } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext, type WorkspaceScope } from '../../db/workspaceScope.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { exportFirms } from '../../crm/exports.ts';

/**
 * CRM export (specification 5.2, 7.2, 14.1, Appendix F).
 *
 * "Authorized exports are typed, redacted, audited DTOs." Three words, three
 * assertions, and the audit one is the reason exports are separate from search: 5.2
 * names exports among the reads that "create access audit events", because an export
 * takes a copy of the data out of the system and the record of who did that is the
 * only thing left afterwards.
 *
 * The redaction is the same one `readFirmForActor` performs and it is by
 * construction: a row for a firm the caller is not assigned is a `FirmIdentityDto`,
 * which has no field a contact, an address or a route could be in. A colleague's
 * firm is not filtered out of the export — it is exported at the width the read
 * matrix gives, which is what makes an export of "every firm" usable and safe at the
 * same time.
 */
describe('CRM export', () => {
  let database: TestDatabase;
  let session: SessionQueryable;
  let seeded: TwoWorkspaces;
  let crm: SeededCrm;

  let assignee: WorkspaceScope;
  let admin: WorkspaceScope;
  let betaAdmin: WorkspaceScope;
  let othersFirmId: string;

  const context = (scope: WorkspaceScope): RepositoryContext => repositoryContext(scope, session);

  beforeAll(async () => {
    database = await createTestDatabase();
    session = database.session;
    seeded = await seedTwoWorkspaces(session);
    crm = await seedCrm(session, seeded);

    const user = await session.query<{ id: string }>(
      "INSERT INTO users (google_sub, email, display_name) VALUES ('sub-export-stranger', 'stranger@example.test', 'Stranger') RETURNING id",
    );
    const strangerUserId = user.rows[0]?.id ?? '';
    await session.query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'salesperson')",
      [seeded.alpha.workspaceId, strangerUserId],
    );
    const other = await session.query<{ id: string }>(
      `INSERT INTO firms (workspace_id, name, assigned_user_id, address_line, locality, region_code, postal_code)
       VALUES ($1, 'Larkspur Test Foundry', $2, '14 Sample Way', 'Pawtucket', 'RI', '02860') RETURNING id`,
      [seeded.alpha.workspaceId, strangerUserId],
    );
    othersFirmId = other.rows[0]?.id ?? '';
    await session.query(
      `INSERT INTO contacts (workspace_id, firm_id, full_name, title) VALUES ($1, $2, 'Robin Placeholder', 'Buyer')`,
      [seeded.alpha.workspaceId, othersFirmId],
    );

    assignee = workspaceScope(seeded.alpha.workspaceId, {
      kind: 'user',
      userId: seeded.alpha.salesperson.userId,
      role: 'salesperson',
    });
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

  it('exports each firm at the width the read matrix gives this caller', async () => {
    const exported = await exportFirms(context(assignee), {});
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;

    const mine = exported.value.rows.find(row => row.firm.id === crm.alpha.firmId);
    expect(mine?.visibility).toBe('assigned_or_admin');
    if (mine?.visibility === 'assigned_or_admin') {
      expect(mine.firm.contacts.map(contact => contact.fullName)).toEqual(['Dana Example']);
      expect(mine.firm.emailRoutes.map(route => route.value)).toEqual([crm.collidingEmail]);
      expect(mine.firm.phoneRoutes.map(route => route.value)).toEqual([crm.collidingE164]);
      expect(mine.firm.addressLine).toBeNull();
    }

    const theirs = exported.value.rows.find(row => row.firm.id === othersFirmId);
    expect(theirs?.visibility).toBe('any_active_member');
    expect(theirs?.firm).not.toHaveProperty('contacts');
    expect(theirs?.firm).not.toHaveProperty('addressLine');
    // The whole payload carries nothing from the colleague's firm but its identity.
    expect(JSON.stringify(exported.value)).not.toContain('Robin Placeholder');
    expect(JSON.stringify(exported.value)).not.toContain('14 Sample Way');
  });

  it('gives an admin every firm in detail, and nothing from the workspace next door', async () => {
    const exported = await exportFirms(context(admin), {});
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.value.rows.every(row => row.visibility === 'assigned_or_admin')).toBe(true);
    expect(exported.value.rows.map(row => row.firm.id).sort()).toEqual([crm.alpha.firmId, othersFirmId].sort());
    expect(JSON.stringify(exported.value)).not.toContain(crm.beta.firmId);

    const next = await exportFirms(context(betaAdmin), {});
    expect(next.ok && next.value.rows.map(row => row.firm.id)).toEqual([crm.beta.firmId]);
  });

  it('writes exactly one audit event per export, naming the count and never the data', async () => {
    const before = await auditCount();
    const exported = await exportFirms(context(admin), { term: 'Northwind' });
    expect(exported.ok).toBe(true);
    expect(await auditCount()).toBe(before + 1);

    const { rows } = await session.query<{ action: string; subject_kind: string; detail: Record<string, unknown> }>(
      `SELECT action, subject_kind, detail FROM audit_events
        WHERE workspace_id = $1 AND action = 'export.firms' ORDER BY occurred_at DESC LIMIT 1`,
      [seeded.alpha.workspaceId],
    );
    const event = rows[0];
    expect(event?.action).toBe('export.firms');
    expect(event?.subject_kind).toBe('workspace');
    expect(event?.detail['rowCount']).toBe(1);
    expect(event?.detail['detailRowCount']).toBe(1);
    // The term may be a prospect's address; the audit records that there was one.
    expect(JSON.stringify(event?.detail)).not.toContain('Northwind');
    expect(event?.detail['termPresent']).toBe(true);
  });

  it('accepts the search filters, so an export is a search a person decided to keep', async () => {
    const filtered = await exportFirms(context(admin), { filters: { stageKey: 'new' } });
    expect(filtered.ok && filtered.value.rows.map(row => row.firm.id)).toEqual([crm.alpha.firmId]);

    const refused = await exportFirms(context(admin), { filters: { stageKey: 'not-a-stage' } });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe('stage_unknown');
  });

  it('writes no audit event for an export it refused', async () => {
    const before = await auditCount();
    await exportFirms(context(admin), { filters: { stageKey: 'not-a-stage' } });
    expect(await auditCount()).toBe(before);
  });

  async function auditCount(): Promise<number> {
    const { rows } = await session.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM audit_events WHERE workspace_id = $1 AND action = 'export.firms'",
      [seeded.alpha.workspaceId],
    );
    return Number(rows[0]?.count ?? '0');
  }
});
