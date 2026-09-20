import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/index.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { liveDashboardSources, type SendingFacts } from '../../dashboard/index.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { seedMail, type SeededMail } from '../db/support/mailFixtures.ts';
import { seedOutbound, type SeededOutbound } from '../db/support/outboundFixtures.ts';

/**
 * 13.4's sending figures, read from G7-2's tables (migration 0010).
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

/** The fixture's sent fence: 2026-09-02 13:00:02Z, `America/New_York` — Wednesday, 09. */
const SENT_WEEKDAY = '3';
const SENT_HOUR = '09';

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

    // A reply on the sent fence's thread, and the disposition a person would confirm.
    const reply = await database.session.query<{ id: string }>(
      `INSERT INTO mail_messages (workspace_id, mailbox_id, provider_message_id, provider_thread_id,
                                  direction, internal_date, header_from, matched)
       VALUES ($1, $2, $3, $4, 'incoming', TIMESTAMPTZ '2026-09-03 15:00:00+00', $5, true)
       RETURNING id`,
      [
        seeded.alpha.workspaceId,
        mail.alpha.mailboxId,
        `reply-${randomUUID().replaceAll('-', '')}`,
        `${outbound.collidingProviderMessageId}-thread`,
        'prospect.alpha@example.test',
      ],
    );
    await database.session.query(
      `INSERT INTO mail_message_classifications (workspace_id, mail_message_id, layer, class,
                                                 suggested_disposition, requires_confirmation, rules_version)
       VALUES ($1, $2, 'deterministic', 'human', 'interested', true, 'reply-rules.1')`,
      [seeded.alpha.workspaceId, reply.rows[0]?.id ?? ''],
    );

    // A held fence and two that ended `unknown_terminal`, one of which an admin
    // resolved as skipped, so the four counts 13.4 names are all non-zero.
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

    // A send day that closed unhealthy, with provider errors on it.
    await database.session.query(
      `UPDATE mailbox_send_days SET provider_errors = 2, healthy = false,
              closed_at = TIMESTAMPTZ '2026-09-02 23:00:00+00'
        WHERE workspace_id = $1 AND mailbox_id = $2`,
      [seeded.alpha.workspaceId, mail.alpha.mailboxId],
    );

    assignee = contextFor(database, seeded.alpha.workspaceId, seeded.alpha.salesperson.userId, 'salesperson');
    colleague = contextFor(database, seeded.alpha.workspaceId, otherUserId, 'salesperson');
    admin = contextFor(database, seeded.alpha.workspaceId, seeded.alpha.admin.userId, 'admin');
    betaAdmin = contextFor(database, seeded.beta.workspaceId, seeded.beta.admin.userId, 'admin');
  }, 120_000);

  afterAll(async () => {
    await database.drop();
  });

  it('counts sent, held, unknown and skipped from the fence, for the workspace', async () => {
    expect(await facts(admin)).toMatchObject({
      available: true,
      sent: 1,
      held: 1,
      unknown: 1,
      skipped: 1,
      resolvedDelivered: 0,
    });
  });

  it('sums provider deferrals and unhealthy send days from the ramp tables', async () => {
    const theAdmins = await facts(admin);
    expect(theAdmins.providerDeferrals).toBe(2);
    expect(theAdmins.reputationWarnings).toBe(1);
  });

  it('breaks sends down by template version, weekday and local send hour in the firm zone', async () => {
    const theAdmins = await facts(admin);
    expect(theAdmins.byTemplateVersion).toEqual([
      { key: outbound.alpha.templateVersionId, sent: 1, replies: 1, positiveReplies: 1 },
    ]);
    expect(theAdmins.byWeekday).toEqual([{ key: SENT_WEEKDAY, sent: 1, replies: 1, positiveReplies: 1 }]);
    expect(theAdmins.byLocalSendHour).toEqual([{ key: SENT_HOUR, sent: 1, replies: 1, positiveReplies: 1 }]);
  });

  it('says which breakdowns no table can answer rather than showing them empty', async () => {
    const theAdmins = await facts(admin);
    // `bySequence` is real since G8 landed: this fixture's fence is a draft send
    // with no enrollment, and `none` is the honest key for one.
    expect(theAdmins.bySequence).toEqual([{ key: 'none', sent: 1, replies: 1, positiveReplies: 1 }]);
    // `bySegment` is the one that stayed unavailable, and now provably: migrations
    // 0001 to 0013 define no segment anywhere, so there is nobody to own it.
    expect(theAdmins.bySegment).toMatchObject({ available: false, owner: 'unassigned' });
  });

  it('shows an admin the domain posture and every ramp', async () => {
    const theAdmins = await facts(admin);
    expect(theAdmins.posture.domain).toEqual({
      domain: outbound.collidingDomain,
      authenticationPasses: true,
      automatedSendingEnabled: true,
      personalGmailGuardPer24h: 4000,
    });
    expect(theAdmins.posture.ramps).toEqual([
      {
        mailboxId: mail.alpha.mailboxId,
        healthySendingDays: 3,
        effectiveCap: 5,
        adminDailyCap: null,
        raisedDailyCap: null,
        lastHealthFailure: null,
      },
    ]);
  });

  it("gives a salesperson their own firms' sends and their own mailbox's ramp, and no domain posture", async () => {
    const theirs = await facts(assignee);
    expect(theirs).toMatchObject({ sent: 1, held: 1, unknown: 1, skipped: 1 });
    expect(theirs.posture.domain).toBeNull();
    expect(theirs.posture.ramps).toHaveLength(1);
    expect(theirs.posture.ramps[0]?.mailboxId).toBe(mail.alpha.mailboxId);
  });

  it("shows a colleague nothing of another salesperson's sending", async () => {
    const theirs = await facts(colleague);
    expect(theirs).toMatchObject({
      sent: 0,
      held: 0,
      unknown: 0,
      skipped: 0,
      providerDeferrals: 0,
      reputationWarnings: 0,
    });
    expect(theirs.byTemplateVersion).toEqual([]);
    expect(theirs.posture.ramps).toEqual([]);
  });

  it("counts none of the other workspace's identical rows", async () => {
    const theirs = await facts(betaAdmin);
    expect(theirs).toMatchObject({ sent: 1, held: 0, unknown: 0, skipped: 0 });
    // Beta's mailbox never replied, so its one send has no reply on it — which is
    // the assertion that alpha's reply was not counted across the boundary.
    expect(theirs.byTemplateVersion).toEqual([
      { key: outbound.beta.templateVersionId, sent: 1, replies: 0, positiveReplies: 0 },
    ]);
  });

  it('counts nothing outside the window', async () => {
    const answer = await SOURCES.sending(
      admin,
      { from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' },
      { onlyAssignedTo: null },
    );
    expect(answer).toMatchObject({ available: true, sent: 0, held: 0, unknown: 0, skipped: 0 });
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
  'Hello.\n\nSigned off\n1 Example Way\nReply "stop" and I will not email you again.';

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
