import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/index.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { classifierFacts, enrollmentFacts, sendingFacts } from '../../dashboard/index.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { seedMail, type SeededMail } from '../db/support/mailFixtures.ts';
import { seedOutbound, type SeededOutbound } from '../db/support/outboundFixtures.ts';

/**
 * The last two declared-unavailable dashboard figures, wired to G8's and G7b's
 * tables, and the `bySequence` breakdown that needed both lanes to be real.
 *
 * The same two questions as the sending source: are the figures right, and does a
 * salesperson's copy stay inside the read matrix? The frame is the shared
 * two-workspace fixture, with a second salesperson who owns neither the firm nor the
 * mailbox and must therefore see nothing.
 */

/**
 * A window wholly in the past, on purpose.
 *
 * The shared outbound fixture creates two enrollments at `now()`, so a window that
 * reached the present would make every count depend on the day the suite runs. The
 * seeded rows below are all in the first fortnight of September; the fixture's are
 * not, which is exactly the separation the window is for.
 */
const WINDOW = { from: '2026-09-01T00:00:00.000Z', to: '2026-09-15T00:00:00.000Z' };
const WORKSPACE = { onlyAssignedTo: null };

/**
 * Live enrollments created by `seedOutbound`, which 0012's foreign keys made it
 * seed. They have no end and no executions, so they land in `active` and nowhere
 * else — and `active` is a fact about now, which no window can exclude.
 */
const FIXTURE_ACTIVE = 2;

describe("the dashboard's enrollment and classifier figures", () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  let crm: SeededCrm;
  let mail: SeededMail;
  let outbound: SeededOutbound;
  let admin: RepositoryContext;
  let assignee: RepositoryContext;
  let colleague: RepositoryContext;
  let betaAdmin: RepositoryContext;
  let sequenceId: string;
  let otherUserId: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    seeded = await seedTwoWorkspaces(database.session);
    crm = await seedCrm(database.session, seeded);
    mail = await seedMail(database.session, seeded, crm);
    outbound = await seedOutbound(database.session, seeded, crm, mail);

    const other = await database.session.query<{ id: string }>(
      'INSERT INTO users (google_sub, email, display_name) VALUES ($1, $2, $3) RETURNING id',
      [`sub-${randomUUID()}`, 'third.salesperson@example.test', 'Third Salesperson'],
    );
    otherUserId = other.rows[0]?.id ?? '';
    await database.session.query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role, status) VALUES ($1, $2, 'salesperson', 'active')",
      [seeded.alpha.workspaceId, otherUserId],
    );

    sequenceId = await seedSequenceWorld(
      database,
      seeded.alpha,
      crm.alpha,
      mail.alpha,
      outbound.alpha.templateVersionId,
    );
    // Beta gets an enrollment too, with the same shape, so every count below is also
    // an assertion that the workspace boundary holds.
    await seedSequenceWorld(
      database,
      seeded.beta,
      crm.beta,
      mail.beta,
      outbound.beta.templateVersionId,
    );

    admin = contextFor(database, seeded.alpha.workspaceId, seeded.alpha.admin.userId, 'admin');
    assignee = contextFor(
      database,
      seeded.alpha.workspaceId,
      seeded.alpha.salesperson.userId,
      'salesperson',
    );
    colleague = contextFor(database, seeded.alpha.workspaceId, otherUserId, 'salesperson');
    betaAdmin = contextFor(database, seeded.beta.workspaceId, seeded.beta.admin.userId, 'admin');
  }, 120_000);

  afterAll(async () => {
    await database.drop();
  });

  // ------------------------------------------------------------- enrollments

  it('separates what happened in the window from what is true now', async () => {
    const facts = await enrollmentFacts(admin, WINDOW, WORKSPACE);
    // Two enrollments: one still running, one that ended inside the window.
    expect(facts.started).toBe(2);
    expect(facts.active).toBe(FIXTURE_ACTIVE + 1);
    expect(facts.reviewRequired).toBe(0);
    expect(facts.ended).toEqual([{ key: 'human_reply', count: 1 }]);
    // A state, not an event: held *now*, whatever the window says.
    expect(facts.heldSteps).toEqual([{ key: 'daily_cap', count: 1 }]);
    expect(facts.stepsCompleted).toEqual([{ key: 'email', count: 1 }]);
  });

  it('counts a LinkedIn handoff and what the person recorded afterwards', async () => {
    const facts = await enrollmentFacts(admin, WINDOW, WORKSPACE);
    expect(facts.linkedinHandoffs).toBe(1);
    expect(facts.linkedinRecordedReplies).toBe(1);
    expect(facts.linkedinNoEngagement).toBe(0);
  });

  it("shows a colleague none of another salesperson's enrollments", async () => {
    const theirs = await enrollmentFacts(colleague, WINDOW, { onlyAssignedTo: otherUserId });
    expect(theirs).toMatchObject({ started: 0, active: 0, linkedinHandoffs: 0 });
    expect(theirs.heldSteps).toEqual([]);
    // The assignee sees their own, which is what makes the line above an assertion
    // about visibility rather than about an empty database.
    const mine = await enrollmentFacts(assignee, WINDOW, {
      onlyAssignedTo: seeded.alpha.salesperson.userId,
    });
    expect(mine.started).toBe(2);
  });

  it("counts none of the other workspace's identical enrollments", async () => {
    const theirs = await enrollmentFacts(betaAdmin, WINDOW, WORKSPACE);
    expect(theirs.started).toBe(2);
    expect(theirs.linkedinRecordedReplies).toBe(1);
    expect(theirs.active).toBe(FIXTURE_ACTIVE + 1);
  });

  // -------------------------------------------------------------- classifier

  it('reports what the calls actually recorded, and no money', async () => {
    const facts = await classifierFacts(admin, WINDOW, WORKSPACE);
    expect(facts.callsAttempted).toBe(2);
    expect(facts.callsSent).toBe(1);
    expect(facts.inputTokens).toBe(900);
    expect(facts.cachedInputTokens).toBe(100);
    expect(facts.outputTokens).toBe(40);
    expect(facts.totalLatencyMs).toBe(1200);
    expect(facts.byOutcome).toEqual([
      { key: 'accepted', count: 1 },
      { key: 'not_applicable', count: 1 },
    ]);
    expect(facts.promptVersions).toEqual(['reply.1']);
    // There is no price anywhere in the schema, so there is no field for one.
    expect(Object.keys(facts).some(key => key.toLowerCase().includes('cost'))).toBe(false);
    // The configuration is read out, never assumed.
    expect(facts.modelName).toBe('claude-opus-5');
    expect(facts.dailyCallCap).toBe(500);
  });

  it('reports drift as corrections against acceptances, and who suggested', async () => {
    const facts = await classifierFacts(admin, WINDOW, WORKSPACE);
    expect(facts.confirmations).toBe(2);
    expect(facts.corrected).toBe(1);
    expect(facts.accepted).toBe(1);
    expect(facts.correctionRate).toBe(0.5);
    expect(facts.correctedBySuggester).toEqual([{ key: 'model', count: 1 }]);
  });

  it('says nothing rather than zero when nobody confirmed a reply in the window', async () => {
    const facts = await classifierFacts(
      admin,
      { from: '2026-11-01T00:00:00.000Z', to: '2026-12-01T00:00:00.000Z' },
      WORKSPACE,
    );
    expect(facts.confirmations).toBe(0);
    expect(facts.correctionRate).toBeNull();
  });

  it("gives a salesperson their own mailbox's calls and their own firms' confirmations", async () => {
    const theirs = await classifierFacts(assignee, WINDOW, {
      onlyAssignedTo: seeded.alpha.salesperson.userId,
    });
    expect(theirs.callsAttempted).toBe(2);
    expect(theirs.confirmations).toBe(2);

    // The colleague owns no mailbox and no firm, so both halves are empty — and they
    // are two different joins, which is why both are asserted.
    const none = await classifierFacts(colleague, WINDOW, { onlyAssignedTo: otherUserId });
    expect(none.callsAttempted).toBe(0);
    expect(none.confirmations).toBe(0);
    expect(none.correctionRate).toBeNull();
  });

  // ------------------------------------------------------------- bySequence

  it('breaks sends down by sequence now that a fence can be joined to one', async () => {
    const facts = await sendingFacts(admin, WINDOW, WORKSPACE);
    const bySequence = facts.bySequence as readonly { key: string; sent: number }[];
    expect(bySequence.find(entry => entry.key === sequenceId)).toEqual({
      key: sequenceId,
      sent: 1,
      replies: 0,
      positiveReplies: 0,
    });
    // The shared fixture's own sent fence has no enrollment, and `none` is the
    // honest key for it rather than a row quietly dropped from the breakdown.
    expect(bySequence.find(entry => entry.key === 'none')?.sent).toBe(1);
    // And still says so where no table has the answer at all.
    expect(facts.bySegment).toMatchObject({ available: false, owner: 'unassigned' });
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

/**
 * A sequence, a version, two steps, two enrollments and their executions, plus the
 * classifier calls and reply confirmations that go with them.
 *
 * Written here rather than in a shared fixture because it is one lane's reading of
 * two other lanes' tables: a shared fixture would make every other file's counts
 * depend on what this one needed.
 */
async function seedSequenceWorld(
  database: TestDatabase,
  workspace: { readonly workspaceId: string; readonly admin: { readonly userId: string }; readonly salesperson: { readonly userId: string } },
  firm: { readonly firmId: string; readonly contactId: string; readonly opportunityId: string },
  mailbox: { readonly mailboxId: string; readonly messageId: string },
  templateVersionId: string,
): Promise<string> {
  const query = database.session.query.bind(database.session);
  const id = async (sql: string, values: readonly unknown[]): Promise<string> => {
    const { rows } = await query<{ id: string }>(sql, [...values]);
    return rows[0]?.id ?? '';
  };

  const sequenceId = await id(
    'INSERT INTO sequences (workspace_id, name, created_by_user_id) VALUES ($1, $2, $3) RETURNING id',
    [workspace.workspaceId, 'Founding outreach', workspace.admin.userId],
  );
  const versionId = await id(
    'INSERT INTO sequence_versions (workspace_id, sequence_id, version) VALUES ($1, $2, 1) RETURNING id',
    [workspace.workspaceId, sequenceId],
  );
  const emailStepId = await id(
    `INSERT INTO sequence_steps
       (workspace_id, sequence_version_id, ordinal, channel, delay_unit, delay_amount,
        template_version_id)
     VALUES ($1, $2, 1, 'email', 'elapsed', 0, $3) RETURNING id`,
    [workspace.workspaceId, versionId, templateVersionId],
  );
  const linkedinStepId = await id(
    `INSERT INTO sequence_steps
       (workspace_id, sequence_version_id, ordinal, channel, delay_unit, delay_amount,
        linkedin_message)
     VALUES ($1, $2, 2, 'linkedin_task', 'elapsed', 24, 'A short note.') RETURNING id`,
    [workspace.workspaceId, versionId],
  );
  const callStepId = await id(
    `INSERT INTO sequence_steps
       (workspace_id, sequence_version_id, ordinal, channel, delay_unit, delay_amount, on_no_answer)
     VALUES ($1, $2, 3, 'call_task', 'elapsed', 48, 'advance') RETURNING id`,
    [workspace.workspaceId, versionId],
  );

  const enrollment = async (state: string, ended: string | null, reason: string | null): Promise<string> =>
    await id(
      `INSERT INTO sequence_enrollments
         (workspace_id, sequence_version_id, opportunity_id, firm_id, contact_id, assigned_user_id,
          state, started_at, ended_at, end_reason, firm_time_zone, holiday_calendar_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, TIMESTAMPTZ '2026-09-02 12:00:00+00',
               $8::timestamptz, $9, 'America/New_York', 'none.1')
       RETURNING id`,
      [
        workspace.workspaceId,
        versionId,
        firm.opportunityId,
        firm.firmId,
        firm.contactId,
        workspace.salesperson.userId,
        state,
        ended,
        reason,
      ],
    );

  const live = await enrollment('active', null, null);
  const finished = await enrollment('stopped', '2026-09-10T12:00:00.000Z', 'human_reply');

  const execution = async (
    enrollmentId: string,
    stepId: string,
    channel: string,
    state: string,
    extra: {
      readonly holdReasonCode?: string;
      readonly completedAt?: string;
      readonly completionSource?: string;
      readonly result?: string;
    } = {},
  ): Promise<string> =>
    await id(
      `INSERT INTO step_executions
         (workspace_id, enrollment_id, step_id, firm_id, contact_id, channel, ordinal, state,
          due_at, not_before, original_due_at, source_zone, rule_version,
          hold_reason_code, completed_at, completion_source, result)
       VALUES ($1, $2, $3, $4, $5, $6, 1, $7,
               TIMESTAMPTZ '2026-09-03 13:00:00+00', TIMESTAMPTZ '2026-09-03 13:00:00+00',
               TIMESTAMPTZ '2026-09-03 13:00:00+00', 'America/New_York', 'elapsed.1',
               $8, $9::timestamptz, $10, $11)
       RETURNING id`,
      [
        workspace.workspaceId,
        enrollmentId,
        stepId,
        firm.firmId,
        firm.contactId,
        channel,
        state,
        extra.holdReasonCode ?? null,
        extra.completedAt ?? null,
        extra.completionSource ?? null,
        extra.result ?? null,
      ],
    );

  const emailExecutionId = await execution(live, emailStepId, 'email', 'completed', {
    completedAt: '2026-09-03T13:00:05.000Z',
    completionSource: 'send',
    result: 'sent',
  });
  await execution(live, callStepId, 'call_task', 'held', { holdReasonCode: 'daily_cap' });
  const handoff = await execution(finished, linkedinStepId, 'linkedin_task', 'dispatched');

  await query(
    `INSERT INTO enrollment_linkedin_results
       (workspace_id, enrollment_id, firm_id, step_execution_id, result, recorded_by_user_id, recorded_at)
     VALUES ($1, $2, $3, $4, 'replied', $5, TIMESTAMPTZ '2026-09-04 15:00:00+00')`,
    [workspace.workspaceId, finished, firm.firmId, handoff, workspace.salesperson.userId],
  );

  // A sent fence that names this enrollment, so `bySequence` has something to join
  // to. It is inserted rather than retro-fitted onto the shared fixture's fence:
  // 12.5 makes the envelope immutable once dispatch began, and `enrollment_id` is
  // part of the envelope. That trigger is exactly right and the test works with it.
  await query(
    `INSERT INTO outbound_messages
       (workspace_id, mailbox_id, origin_kind, step_execution_id, enrollment_id, firm_id,
        contact_id, opportunity_id, recipient_address, subject, body, template_version_id,
        rendered_hash, provider_message_id_header, send_at, source_zone, placement_rule_version,
        business_date, state, attempt_token, dispatch_started_at, sent_at, provider_message_id,
        provider_thread_id)
     VALUES ($1, $2, 'step_execution', $3, $4, $5, $6, $7, $8,
             'A short note about your properties', $9, $10, repeat('d', 64), $11,
             TIMESTAMPTZ '2026-09-03 13:00:00+00', 'America/New_York', 'email-window.1',
             DATE '2026-09-03', 'sent', gen_random_uuid(),
             TIMESTAMPTZ '2026-09-03 13:00:01+00', TIMESTAMPTZ '2026-09-03 13:00:02+00',
             $12, $13)`,
    [
      workspace.workspaceId,
      mailbox.mailboxId,
      emailExecutionId,
      live,
      firm.firmId,
      firm.contactId,
      firm.opportunityId,
      `prospect.sequenced.${workspace.workspaceId.slice(0, 8)}@example.test`,
      'Hello.\n\nSigned off\nReply "stop" and I will not email you again.',
      templateVersionId,
      `<fss.sequenced.${workspace.workspaceId}@sending.example.test>`,
      `sequenced-${workspace.workspaceId.slice(0, 8)}`,
      `sequenced-${workspace.workspaceId.slice(0, 8)}-thread`,
    ],
  );

  // Two classifier calls: one that reached the provider and one that deliberately
  // did not. Both are rows, which is the point of counting attempts.
  await query(
    `INSERT INTO mail_classification_calls
       (workspace_id, mail_message_id, model_name, prompt_version, effort, request_sent, outcome,
        input_tokens, cached_input_tokens, output_tokens, latency_ms, business_date, called_at)
     VALUES ($1, $2, 'claude-opus-5', 'reply.1', 'low', true, 'accepted',
             900, 100, 40, 1200, DATE '2026-09-03', TIMESTAMPTZ '2026-09-03 15:00:00+00'),
            ($1, $2, 'claude-opus-5', 'reply.1', 'low', false, 'not_applicable',
             0, 0, 0, 0, DATE '2026-09-04', TIMESTAMPTZ '2026-09-04 15:00:00+00')`,
    [workspace.workspaceId, mailbox.messageId],
  );

  // Two confirmations: one where the person agreed with the model and one where they
  // did not. `corrected` is a stored column a CHECK ties to the other two.
  const second = await id(
    `INSERT INTO mail_messages (workspace_id, mailbox_id, provider_message_id, provider_thread_id,
                                direction, internal_date, matched)
     VALUES ($1, $2, $3, $4, 'incoming', TIMESTAMPTZ '2026-09-05 15:00:00+00', true) RETURNING id`,
    [workspace.workspaceId, mailbox.mailboxId, `second-${randomUUID()}`, `thread-${randomUUID()}`],
  );
  await query(
    `INSERT INTO mail_reply_confirmations
       (workspace_id, mail_message_id, firm_id, opportunity_id, disposition, suggested_disposition,
        suggested_by, corrected, confirmed_by_user_id, created_at)
     VALUES ($1, $2, $3, $4, 'interested', 'interested', 'deterministic', false, $6,
             TIMESTAMPTZ '2026-09-06 15:00:00+00'),
            ($1, $5, $3, $4, 'not_interested', 'interested', 'model', true, $6,
             TIMESTAMPTZ '2026-09-07 15:00:00+00')`,
    [
      workspace.workspaceId,
      mailbox.messageId,
      firm.firmId,
      firm.opportunityId,
      second,
      workspace.salesperson.userId,
    ],
  );

  return sequenceId;
}
