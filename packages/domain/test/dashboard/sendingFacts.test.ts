import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { liveDashboardSources } from '../../dashboard/sendingSource.ts';
import { type SendingFacts } from '../../dashboard/sources.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { seedMail, type SeededMail } from '../db/support/mailFixtures.ts';
import { seedOutbound, type SeededOutbound } from '../db/support/outboundFixtures.ts';

/**
 * 13.4's sending figures, read from G7-2's tables (migration 0010): the two counts the
 * Mac shows, `sent` and `held` (wave 2, S6 cut the rest).
 *
 * Until G7-2 landed, `DashboardSources.sending` answered `{ available: false }` on
 * purpose — "nothing can tell you how many were skipped" is a different sentence to
 * show an operator than "none were skipped". The tables exist now, so the seam is
 * wired, and the two questions this file asks are the ones the seam was built for:
 * are the figures right, and does a salesperson's copy of them stay inside the read
 * matrix?
 *
 * The frame is the shared two-workspace fixture: alpha's salesperson owns the firm
 * *and* the mailbox, alpha's admin sees the workspace, a second salesperson owns
 * neither, and beta has identical rows that must never be counted.
 */

const WINDOW = { from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' };
const SOURCES = liveDashboardSources();

describe("the dashboard's sending figures", () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  let crm: SeededCrm;
  let mail: SeededMail;
  let outbound: SeededOutbound;
  let assignee: RepositoryContext;
  let colleague: RepositoryContext;
  let admin: RepositoryContext;
  let betaAdmin: RepositoryContext;

  const facts = async (context: RepositoryContext): Promise<SendingFacts> => {
    const actor = context.scope.actor;
    const answer = await SOURCES.sending(context, WINDOW, {
      onlyAssignedTo: actor.kind === 'user' && actor.role !== 'admin' ? actor.userId : null,
    });
    if (answer.available !== true) throw new Error(`expected facts, got ${JSON.stringify(answer)}`);
    return answer;
  };

  beforeAll(async () => {
    database = await createTestDatabase();
    seeded = await seedTwoWorkspaces(database.session);
    crm = await seedCrm(database.session, seeded);
    mail = await seedMail(database.session, seeded, crm);
    outbound = await seedOutbound(database.session, seeded, crm, mail);

    const other = await database.session.query<{ id: string }>(
      'INSERT INTO users (google_sub, email, display_name) VALUES ($1, $2, $3) RETURNING id',
      [`sub-${randomUUID()}`, 'second.sender@example.test', 'Second Salesperson'],
    );
    const otherUserId = other.rows[0]?.id ?? '';
    await database.session.query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role, status) VALUES ($1, $2, 'salesperson', 'active')",
      [seeded.alpha.workspaceId, otherUserId],
    );

    // A held fence and two that ended `unknown_terminal`, one of which an admin
    // resolved as skipped: only the held one counts beside the sent one.
    await insertFence(database, seeded.alpha.workspaceId, mail.alpha.mailboxId, crm.alpha, outbound, {
      state: 'held',
      suffix: 'held',
    });
    await insertFence(database, seeded.alpha.workspaceId, mail.alpha.mailboxId, crm.alpha, outbound, {
      state: 'unknown_terminal',
      suffix: 'unknown',
    });
    await insertFence(database, seeded.alpha.workspaceId, mail.alpha.mailboxId, crm.alpha, outbound, {
      state: 'unknown_terminal',
      suffix: 'skipped',
      resolution: 'skipped',
      resolverUserId: seeded.alpha.admin.userId,
    });

    assignee = contextFor(database, seeded.alpha.workspaceId, seeded.alpha.salesperson.userId, 'salesperson');
    colleague = contextFor(database, seeded.alpha.workspaceId, otherUserId, 'salesperson');
    admin = contextFor(database, seeded.alpha.workspaceId, seeded.alpha.admin.userId, 'admin');
    betaAdmin = contextFor(database, seeded.beta.workspaceId, seeded.beta.admin.userId, 'admin');
  }, 120_000);

  afterAll(async () => {
    await database.drop();
  });

  it('counts sent and held from the fence, for the workspace, and nothing else', async () => {
    expect(await facts(admin)).toEqual({ available: true, sent: 1, held: 1 });
  });

  it("gives a salesperson their own firms' sends", async () => {
    expect(await facts(assignee)).toEqual({ available: true, sent: 1, held: 1 });
  });

  it("shows a colleague nothing of another salesperson's sending", async () => {
    expect(await facts(colleague)).toEqual({ available: true, sent: 0, held: 0 });
  });

  it("counts none of the other workspace's identical rows", async () => {
    expect(await facts(betaAdmin)).toEqual({ available: true, sent: 1, held: 0 });
  });

  it('counts nothing outside the window', async () => {
    const answer = await SOURCES.sending(
      admin,
      { from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' },
      { onlyAssignedTo: null },
    );
    expect(answer).toEqual({ available: true, sent: 0, held: 0 });
  });
});

function contextFor(
  database: TestDatabase,
  workspaceId: string,
  userId: string,
  role: 'admin' | 'salesperson',
): RepositoryContext {
  return repositoryContext(workspaceScope(workspaceId, { kind: 'user', userId, role }), database.session);
}

const FIXTURE_BODY =
  'Hello.\n\nSigned off\nReply "stop" and I will not email you again.';

async function insertFence(
  database: TestDatabase,
  workspaceId: string,
  mailboxId: string,
  firm: { readonly firmId: string; readonly contactId: string; readonly opportunityId: string },
  outbound: SeededOutbound,
  input: {
    readonly state: 'held' | 'unknown_terminal';
    readonly suffix: string;
    readonly resolution?: 'delivered' | 'skipped';
    readonly resolverUserId?: string;
  },
): Promise<void> {
  // Inserted in their end states rather than walked there: the transition trigger is
  // `BEFORE UPDATE`, and what this file is testing is the reading, not the machine.
  const dispatched = input.state === 'unknown_terminal';
  await database.session.query(
    `INSERT INTO outbound_messages (workspace_id, mailbox_id, origin_kind, draft_id, firm_id, contact_id,
                                    opportunity_id, recipient_address, subject, body, rendered_hash,
                                    provider_message_id_header, send_at, source_zone,
                                    placement_rule_version, business_date, state,
                                    attempt_token, dispatch_started_at,
                                    held_at, held_reason, unknown_terminal_at,
                                    admin_resolution, admin_resolved_at, admin_resolved_by_user_id)
     VALUES ($1, $2, 'draft', gen_random_uuid(), $3, $4, $5, $6,
             'A short note about your properties', $7, $8, $9,
             TIMESTAMPTZ '2026-09-02 13:00:00+00', 'America/New_York', 'email-window.1',
             DATE '2026-09-02', $10,
             CASE WHEN $11::boolean THEN gen_random_uuid() END,
             CASE WHEN $11::boolean THEN TIMESTAMPTZ '2026-09-02 13:00:01+00' END,
             CASE WHEN $10 = 'held' THEN TIMESTAMPTZ '2026-09-02 13:00:03+00' END,
             CASE WHEN $10 = 'held' THEN 'daily_cap_reached' END,
             CASE WHEN $10 = 'unknown_terminal' THEN TIMESTAMPTZ '2026-09-02 14:00:00+00' END,
             $12,
             CASE WHEN $12::text IS NULL THEN NULL ELSE TIMESTAMPTZ '2026-09-03 09:00:00+00' END,
             $13)`,
    [
      workspaceId,
      mailboxId,
      firm.firmId,
      firm.contactId,
      firm.opportunityId,
      `prospect.${input.suffix}@example.test`,
      FIXTURE_BODY,
      'c'.repeat(64),
      `<fss.${input.suffix}.${workspaceId}@${outbound.collidingDomain}>`,
      input.state,
      dispatched,
      input.resolution ?? null,
      input.resolverUserId ?? null,
    ],
  );
}
