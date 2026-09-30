import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { dispatchOutboundMessage, type SendReport } from '../../outbound/send.ts';
import { withTransaction } from '../../db/queryable.ts';
import { makeStepExecution } from '../../db/testing/stepExecutions.ts';
import { lockSendGateForStopFact } from '../../policy/sendGate.ts';
import { enrollContact } from '../../sequences/enrollments.ts';
import { bindFollowUpPermission, grantFollowUpPermission } from '../../sequences/followUpPermissions.ts';
import { OPEN_INSTANT, createOutboundWorld, type OutboundWorld } from './support/outboundWorld.ts';
import {
  openExtraSession,
  prepareFor,
  seedFirm,
  settle,
  waitUntilBlocked,
  type ExtraSession,
} from './support/dispatchFixtures.ts';

/**
 * A permission buys one thing, and the dispatch is where it is spent
 * (P0-3 of the GPT-6 reviews of PR 332).
 *
 * The first round implemented both halves — the claim consumes a one-message scope, and
 * the enrollment bind is conditional on the permission being unbound — and the second
 * round was right that nothing would have failed if either stopped working. These are
 * those two regressions, at the level the rule bites: a real claim for the first, the
 * real enrollment command for the second.
 */

let world: OutboundWorld;
/** A second backend, to hold a row while a claim waits on it (P0-4). */
let barrier: ExtraSession;
/** A third backend, for the command that waits on the barrier. */
let second: ExtraSession;

beforeAll(async () => {
  world = await createOutboundWorld();
  barrier = await openExtraSession(world);
  second = await openExtraSession(world);
}, 180_000);

afterAll(async () => {
  await barrier?.close();
  await second?.close();
  await world?.stop();
});

afterEach(async () => {
  await barrier?.session.query('ROLLBACK');
  await second?.session.query('ROLLBACK');
});

const workspaceId = (): string => world.alpha.workspace.workspaceId;
const context = () => world.systemContext(workspaceId());
const salesperson = (): RepositoryContext =>
  repositoryContext(
    workspaceScope(workspaceId(), {
      kind: 'user',
      userId: world.alpha.workspace.salesperson.userId,
      role: 'salesperson',
    }),
    world.database.session,
  );

async function dispatch(fenceId: string): Promise<{ readonly report: SendReport; readonly sends: number }> {
  const gmail = world.clientWith(world.alpha, {});
  const report = await dispatchOutboundMessage(context(), world.sendDeps(world.alpha, { gmail }), {
    outboundMessageId: fenceId,
  });
  return { report, sends: gmail.sends.length };
}

/** The permission behind one fence's enrollment. */
async function permissionOfFence(fenceId: string): Promise<{ readonly id: string; readonly enrollmentId: string; readonly contactId: string }> {
  const { rows } = await world.database.session.query<{ id: string; enrollment_id: string; contact_id: string }>(
    `SELECT p.id, n.id AS enrollment_id, n.contact_id
       FROM outbound_messages m
       JOIN step_executions e ON e.workspace_id = m.workspace_id AND e.id = m.step_execution_id
       JOIN sequence_enrollments n ON n.workspace_id = e.workspace_id AND n.id = e.enrollment_id
       JOIN follow_up_permissions p ON p.workspace_id = n.workspace_id AND p.id = n.permission_id
      WHERE m.workspace_id = $1 AND m.id = $2`,
    [workspaceId(), fenceId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('the fence has no permitted enrollment');
  return { id: row.id, enrollmentId: row.enrollment_id, contactId: row.contact_id };
}

/**
 * Turn one permission into a `contextual_reply` on real inbound evidence: the message,
 * the match a person selected, and the confirmation they made.
 */
async function becomeContextualReply(permissionId: string, firmId: string, contactId: string): Promise<void> {
  const session = world.database.session;
  const { rows: message } = await session.query<{ id: string }>(
    `INSERT INTO mail_messages
       (workspace_id, mailbox_id, provider_message_id, provider_thread_id, direction,
        internal_date, header_from, matched)
     VALUES ($1, $2, $3, $3, 'incoming', now(), 'prospect@example.test', true)
     RETURNING id`,
    [workspaceId(), world.alpha.mailboxId, `spend-${permissionId}`],
  );
  const messageId = message[0]?.id ?? '';
  const { rows: opportunity } = await session.query<{ id: string }>(
    'SELECT id FROM opportunities WHERE workspace_id = $1 AND firm_id = $2 LIMIT 1',
    [workspaceId(), firmId],
  );
  await session.query(
    `INSERT INTO mail_message_matches
       (workspace_id, mail_message_id, firm_id, opportunity_id, contact_id, match_rule,
        selected, resolved_at, resolved_by_user_id)
     VALUES ($1, $2, $3, $4, $5, 'participant', true, now(), $6)`,
    [workspaceId(), messageId, firmId, opportunity[0]?.id ?? '', contactId, world.alpha.workspace.salesperson.userId],
  );
  await session.query(
    `INSERT INTO mail_reply_confirmations
       (workspace_id, mail_message_id, firm_id, opportunity_id, disposition, suggested_disposition,
        suggested_by, corrected, confirmed_by_user_id, consequences)
     VALUES ($1, $2, $3, $4, 'interested', 'interested', 'deterministic', false, $5, $6::text[])`,
    [
      workspaceId(),
      messageId,
      firmId,
      opportunity[0]?.id ?? '',
      world.alpha.workspace.salesperson.userId,
      ['opportunity_manual'],
    ],
  );
  const updated = await session.query(
    `UPDATE follow_up_permissions
        SET kind = 'request', scope = 'contextual_reply', call_log_id = NULL,
            mail_message_id = $3, sequence_version_id = NULL, template_version_id = NULL,
            max_steps = 1
      WHERE workspace_id = $1 AND id = $2`,
    [workspaceId(), permissionId, messageId],
  );
  expect(updated.rowCount).toBe(1);
}

describe('a contextual reply is one reply, and the claim spends it', () => {
  it('sends once and then refuses the second fence of the same permission', async () => {
    const firm = await seedFirm(world, world.alpha, 'reply-spend');
    const firstFence = await prepareFor(world, world.alpha, firm);
    const permission = await permissionOfFence(firstFence);
    await becomeContextualReply(permission.id, firm.firmId, permission.contactId);

    const first = await dispatch(firstFence);
    expect(first.report.outcome, JSON.stringify(first.report)).toBe('sent');
    expect(first.sends).toBe(1);
    const { rows: spent } = await world.database.session.query<{ consumed_at: Date | null }>(
      'SELECT consumed_at FROM follow_up_permissions WHERE workspace_id = $1 AND id = $2',
      [workspaceId(), permission.id],
    );
    expect(spent[0]?.consumed_at).not.toBeNull();

    // What a reusable permission looks like from the send path: the same person, a second
    // run on the same permission after the first finished. The bind refuses this shape at
    // the command (the case below), so it is written by hand here — the permission is
    // re-pointed at the new run exactly as a broken bind would leave it, which means the
    // only thing that can still refuse this send is the consumption the first claim
    // recorded.
    await world.database.session.query(
      `UPDATE sequence_enrollments
          SET state = 'completed', ended_at = now(), end_reason = 'sequence_complete', updated_at = now()
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceId(), permission.enrollmentId],
    );
    const { rows: again } = await world.database.session.query<{ id: string }>(
      `INSERT INTO sequence_enrollments
         (workspace_id, sequence_version_id, opportunity_id, firm_id, contact_id, assigned_user_id,
          started_at, firm_time_zone, holiday_calendar_version, origin_kind, permission_id)
       SELECT workspace_id, sequence_version_id, opportunity_id, firm_id, contact_id, assigned_user_id,
              now(), firm_time_zone, holiday_calendar_version, 'follow_up', permission_id
         FROM sequence_enrollments WHERE workspace_id = $1 AND id = $2
       RETURNING id`,
      [workspaceId(), permission.enrollmentId],
    );
    await world.database.session.query(
      'UPDATE follow_up_permissions SET enrollment_id = $3 WHERE workspace_id = $1 AND id = $2',
      [workspaceId(), permission.id, again[0]?.id ?? ''],
    );
    const { rows: execution } = await world.database.session.query<{ id: string }>(
      `INSERT INTO step_executions
         (workspace_id, enrollment_id, step_id, firm_id, contact_id, channel, ordinal,
          due_at, not_before, original_due_at, source_zone, rule_version)
       SELECT workspace_id, $3, step_id, firm_id, contact_id, channel, ordinal,
              now() - interval '1 hour', now() - interval '1 hour', now() - interval '1 hour',
              source_zone, rule_version
         FROM step_executions
        WHERE workspace_id = $1 AND id = (SELECT step_execution_id FROM outbound_messages
                                           WHERE workspace_id = $1 AND id = $2)
       RETURNING id`,
      [workspaceId(), firstFence, again[0]?.id ?? ''],
    );
    const secondFence = await prepareFor(world, world.alpha, firm, { stepExecutionId: execution[0]?.id ?? '' });
    const { report, sends } = await dispatch(secondFence);
    expect(report.outcome, JSON.stringify(report)).toBe('held');
    expect(`${report.refusal ?? ''}:${report.detail ?? ''}`).toContain('follow_up_scope_exhausted');
    expect(sends).toBe(0);
  });
});

describe('an agreed sequence buys one run', () => {
  it('refuses a second enrollment on a permission that is already bound', async () => {
    const firm = await seedFirm(world, world.alpha, 'bind-once');
    const fenceId = await prepareFor(world, world.alpha, firm);
    const permission = await permissionOfFence(fenceId);

    // Another person at the same firm, which a follow-up permission is allowed to reach —
    // so the only thing that can refuse this is the permission already having bought a
    // run (`follow_up_permissions_one_enrollment`, and the conditional bind).
    const { rows: contacts } = await world.database.session.query<{ id: string }>(
      "INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, 'Second Person') RETURNING id",
      [workspaceId(), firm.firmId],
    );
    const { rows: version } = await world.database.session.query<{ sequence_version_id: string }>(
      'SELECT sequence_version_id FROM sequence_enrollments WHERE workspace_id = $1 AND id = $2',
      [workspaceId(), permission.enrollmentId],
    );
    await world.database.session.query(
      `UPDATE firms SET time_zone = 'America/New_York', time_zone_confidence = 'high',
              time_zone_source = 'postal', time_zone_rule_version = 'firm-zone.1'
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceId(), firm.firmId],
    );

    const refused = await enrollContact(salesperson(), {
      sequenceVersionId: version[0]?.sequence_version_id ?? '',
      originKind: 'follow_up',
      permissionId: permission.id,
      opportunityId: firm.opportunityId,
      firmId: firm.firmId,
      contactId: contacts[0]?.id ?? '',
    });
    // The verification refuses first — the permission names the run it bought, and this
    // is not that run — and the conditional bind is the second lock on the same door.
    expect(refused).toEqual({ ok: false, reason: 'follow_up_not_permitted' });
    expect(await bindFollowUpPermission(salesperson(), permission.id, permission.enrollmentId)).toBe(false);

    // And nothing was left behind: the second person has no enrollment at all.
    const { rows: after } = await world.database.session.query<{ count: string }>(
      'SELECT count(*) AS count FROM sequence_enrollments WHERE workspace_id = $1 AND contact_id = $2',
      [workspaceId(), contacts[0]?.id ?? ''],
    );
    expect(after[0]?.count).toBe('0');
  });
});

describe('a permission that expires while the claim waits', () => {
  it('stops an agreed_sequence send at the commit, not one line before it', async () => {
    // P0-4 of the second review. The scopes that spend nothing used to commit on the
    // expiry the gate sampled before the token refresh. Here the permission is alive when
    // the gate samples and dead by the time the claim can commit, because the claim spends
    // that time waiting for the firm row — which is the shape a slow provider call or a
    // busy worker produces in production.
    const firm = await seedFirm(world, world.alpha, 'expiring-claim');
    const fenceId = await prepareFor(world, world.alpha, firm);
    const permission = await permissionOfFence(fenceId);
    const { rows: scope } = await world.database.session.query<{ scope: string }>(
      'SELECT scope FROM follow_up_permissions WHERE workspace_id = $1 AND id = $2',
      [workspaceId(), permission.id],
    );
    expect(scope[0]?.scope).toBe('agreed_sequence');
    await world.database.session.query(
      `UPDATE follow_up_permissions SET expires_at = clock_timestamp() + interval '2 seconds'
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceId(), permission.id],
    );

    await barrier.session.query('BEGIN');
    await barrier.session.query('SELECT id FROM outbound_messages WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [
      workspaceId(),
      fenceId,
    ]);
    const gmail = world.clientWith(world.alpha, {});
    // The clock the gate and the eligibility recheck read is the fixture's open instant,
    // which is before this permission's expiry — so every read in this dispatch says the
    // permission is live, and the only thing that can refuse it is the database's own
    // clock at the moment of committing.
    const sampled = new Date(OPEN_INSTANT);
    const claim = dispatchOutboundMessage(
      context(),
      world.sendDeps(world.alpha, { gmail, now: () => sampled }),
      { outboundMessageId: fenceId },
    );
    // The claim is inside its transaction, under the send gate, waiting for the fence row
    // — so the expiry passes while it waits.
    await waitUntilBlocked(barrier.session, await backendOfClaim());
    await settle(2_500);
    await barrier.session.query('COMMIT');

    const report = await claim;
    // `not_ready` rather than `held`: the claim aborted, which rolls the transaction back
    // and takes the day's reservation with it. The fence stays `prepared` and is decided
    // again later, which is what a permission that expired mid-claim should leave behind.
    expect(report.outcome, JSON.stringify(report)).toBe('not_ready');
    expect(`${report.refusal ?? ''}:${report.detail ?? ''}`).toContain('follow_up_expired');
    expect(gmail.sends).toHaveLength(0);
  });
});

describe('a consuming scope that expires between the gate and the spend', () => {
  it('aborts the claim on a zero-row consume, and calls Gmail not at all', async () => {
    // P2-1's proof, third round. The code rolls back when the conditional consume affects
    // no row, and the tests that stood for it never reached that line: the second attempt
    // was refused earlier, by the eligibility source reading `consumed_at`. Here the
    // permission is unspent and live at every read — the recheck runs on the fixture's
    // pinned clock — and dead by the database's own clock at the moment of the UPDATE.
    const firm = await seedFirm(world, world.alpha, 'expiring-consume');
    const fenceId = await prepareFor(world, world.alpha, firm);
    const permission = await permissionOfFence(fenceId);
    await becomeContextualReply(permission.id, firm.firmId, permission.contactId);
    await world.database.session.query(
      `UPDATE follow_up_permissions SET expires_at = clock_timestamp() + interval '2 seconds'
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceId(), permission.id],
    );

    await barrier.session.query('BEGIN');
    await barrier.session.query('SELECT id FROM outbound_messages WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [
      workspaceId(),
      fenceId,
    ]);
    const gmail = world.clientWith(world.alpha, {});
    const sampled = new Date(OPEN_INSTANT);
    const claim = dispatchOutboundMessage(
      context(),
      world.sendDeps(world.alpha, { gmail, now: () => sampled }),
      { outboundMessageId: fenceId },
    );
    await waitUntilBlocked(barrier.session, await backendOfClaim());
    await settle(2_500);
    await barrier.session.query('COMMIT');

    const report = await claim;
    expect(report.outcome, JSON.stringify(report)).toBe('not_ready');
    expect(`${report.refusal ?? ''}:${report.detail ?? ''}`).toContain('follow_up_scope_exhausted');
    expect(gmail.sends).toHaveLength(0);
    // Nothing was spent, and the fence is still there to be decided again.
    const { rows } = await world.database.session.query<{ consumed_at: Date | null; state: string }>(
      `SELECT p.consumed_at, m.state
         FROM follow_up_permissions p, outbound_messages m
        WHERE p.workspace_id = $1 AND p.id = $2 AND m.workspace_id = $1 AND m.id = $3`,
      [workspaceId(), permission.id, fenceId],
    );
    expect(rows[0]?.consumed_at).toBeNull();
    expect(rows[0]?.state).toBe('prepared');
  });
});

/** The backend the world's own session is using, which is the one the claim runs on. */
async function backendOfClaim(): Promise<number> {
  const { rows } = await world.database.session.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  return Number(rows[0]?.pid ?? 0);
}

describe('an expired permission cannot supersede legacy history', () => {
  it('is refused when the expiry passes while the command waits for the send gate', async () => {
    // The second review of PR 332. `enrollContact` waits for the gate and for the firm's
    // row, and then checked the expiry against `now()` — the instant its transaction
    // began, before either wait. A permission that died during the wait still looked live,
    // and a live `cold_legacy` enrollment was stopped on the strength of it. That stop is
    // terminal, so the cost of getting it wrong is history a person cannot get back.
    const firm = await seedFirm(world, world.alpha, 'expiring-enrolment');
    const legacyExecution = await makeStepExecution(world.database.session, {
      workspaceId: workspaceId(),
      firmId: firm.firmId,
      opportunityId: firm.opportunityId,
      userId: world.alpha.workspace.salesperson.userId,
      templateVersionId: world.alpha.templateVersionId,
      originKind: 'cold_legacy',
    });
    const { rows: legacy } = await world.database.session.query<{ id: string; contact_id: string; sequence_version_id: string }>(
      `SELECT n.id, n.contact_id, n.sequence_version_id
         FROM step_executions e
         JOIN sequence_enrollments n ON n.workspace_id = e.workspace_id AND n.id = e.enrollment_id
        WHERE e.workspace_id = $1 AND e.id = $2`,
      [workspaceId(), legacyExecution],
    );
    const legacyId = legacy[0]?.id ?? '';
    const contactId = legacy[0]?.contact_id ?? '';

    // The later request: a real call that agreed to the same published version.
    const { rows: log } = await world.database.session.query<{ id: string }>(
      `INSERT INTO call_logs
         (workspace_id, firm_id, contact_id, opportunity_id, outcome, step_effect, occurred_at,
          actor_user_id, agreed_follow_up, agreed_sequence_version_id)
       VALUES ($1, $2, $3, $4, 'interested', 'none', now() - interval '1 second', $5,
               'agreed_sequence', $6)
       RETURNING id`,
      [
        workspaceId(),
        firm.firmId,
        contactId,
        firm.opportunityId,
        world.alpha.workspace.salesperson.userId,
        legacy[0]?.sequence_version_id ?? '',
      ],
    );
    const caller = repositoryContext(
      workspaceScope(workspaceId(), {
        kind: 'user',
        userId: world.alpha.workspace.salesperson.userId,
        role: 'salesperson',
      }),
      world.database.session,
    );
    const granted = await grantFollowUpPermission(caller, {
      firmId: firm.firmId,
      contactId,
      callLogId: log[0]?.id ?? '',
      grantedByUserId: world.alpha.workspace.salesperson.userId,
    });
    if (!granted.ok) throw new Error(`the permission fixture was refused: ${granted.reason}`);
    await world.database.session.query(
      `UPDATE follow_up_permissions SET expires_at = clock_timestamp() + interval '2 seconds'
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceId(), granted.value.id],
    );
    await world.database.session.query(
      `UPDATE firms SET time_zone = 'America/New_York', time_zone_confidence = 'high',
              time_zone_source = 'postal', time_zone_rule_version = 'firm-zone.1'
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceId(), firm.firmId],
    );

    // The gate, held by somebody else: the command's transaction begins, waits here, and
    // the permission dies while it waits.
    await barrier.session.query('BEGIN');
    await lockSendGateForStopFact(barrier.context(workspaceId()));
    const enrolling = withTransaction(second.session as Parameters<typeof withTransaction>[0], async () =>
      await enrollContact(
        repositoryContext(
          workspaceScope(workspaceId(), {
            kind: 'user',
            userId: world.alpha.workspace.salesperson.userId,
            role: 'salesperson',
          }),
          second.session,
        ),
        {
          sequenceVersionId: legacy[0]?.sequence_version_id ?? '',
          originKind: 'follow_up',
          permissionId: granted.value.id,
          opportunityId: firm.opportunityId,
          firmId: firm.firmId,
          contactId,
        },
      ),
    );
    await waitUntilBlocked(world.database.session, second.pid);
    await settle(2_500);
    await barrier.session.query('COMMIT');

    expect(await enrolling).toEqual({ ok: false, reason: 'follow_up_not_permitted' });
    // And the legacy row is exactly where it was.
    const { rows: after } = await world.database.session.query<{ state: string; ended_at: Date | null }>(
      'SELECT state, ended_at FROM sequence_enrollments WHERE workspace_id = $1 AND id = $2',
      [workspaceId(), legacyId],
    );
    expect(after[0]?.state).toBe('active');
    expect(after[0]?.ended_at).toBeNull();
  });
});

describe('a permission that dies between the verification and the bind', () => {
  it('takes the whole enrolment with it, supersession included', async () => {
    // The third review of PR 332. The post-gate clock closed the window *before* the
    // verification; this is the window after it. The bind is the last statement of the
    // command, and until now it asked only whether the permission was unbound — so a
    // permission that expired while the enrollment and its first execution were being
    // written still committed a terminal stop of a live `cold_legacy` row.
    //
    // The gap is made real rather than hoped for: a trigger that sleeps on the enrollment
    // insert puts a second and a half between the verification's clock and the bind's.
    const firm = await seedFirm(world, world.alpha, 'expiring-bind');
    const legacyExecution = await makeStepExecution(world.database.session, {
      workspaceId: workspaceId(),
      firmId: firm.firmId,
      opportunityId: firm.opportunityId,
      userId: world.alpha.workspace.salesperson.userId,
      templateVersionId: world.alpha.templateVersionId,
      originKind: 'cold_legacy',
    });
    const { rows: legacy } = await world.database.session.query<{ id: string; contact_id: string; sequence_version_id: string }>(
      `SELECT n.id, n.contact_id, n.sequence_version_id
         FROM step_executions e
         JOIN sequence_enrollments n ON n.workspace_id = e.workspace_id AND n.id = e.enrollment_id
        WHERE e.workspace_id = $1 AND e.id = $2`,
      [workspaceId(), legacyExecution],
    );
    const legacyId = legacy[0]?.id ?? '';
    const contactId = legacy[0]?.contact_id ?? '';
    const { rows: log } = await world.database.session.query<{ id: string }>(
      `INSERT INTO call_logs
         (workspace_id, firm_id, contact_id, opportunity_id, outcome, step_effect, occurred_at,
          actor_user_id, agreed_follow_up, agreed_sequence_version_id)
       VALUES ($1, $2, $3, $4, 'interested', 'none', now() - interval '1 second', $5,
               'agreed_sequence', $6)
       RETURNING id`,
      [
        workspaceId(),
        firm.firmId,
        contactId,
        firm.opportunityId,
        world.alpha.workspace.salesperson.userId,
        legacy[0]?.sequence_version_id ?? '',
      ],
    );
    const caller = repositoryContext(
      workspaceScope(workspaceId(), {
        kind: 'user',
        userId: world.alpha.workspace.salesperson.userId,
        role: 'salesperson',
      }),
      world.database.session,
    );
    const granted = await grantFollowUpPermission(caller, {
      firmId: firm.firmId,
      contactId,
      callLogId: log[0]?.id ?? '',
      grantedByUserId: world.alpha.workspace.salesperson.userId,
    });
    if (!granted.ok) throw new Error(`the permission fixture was refused: ${granted.reason}`);
    await world.database.session.query(
      `UPDATE firms SET time_zone = 'America/New_York', time_zone_confidence = 'high',
              time_zone_source = 'postal', time_zone_rule_version = 'firm-zone.1'
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceId(), firm.firmId],
    );
    // Alive when the command verifies it, dead by the time the insert finishes.
    await world.database.session.query(
      `UPDATE follow_up_permissions SET expires_at = clock_timestamp() + interval '700 milliseconds'
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceId(), granted.value.id],
    );
    await world.database.session.query(`
      CREATE OR REPLACE FUNCTION fss_test_slow_enrolment() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(1.5); RETURN NEW; END; $$;
    `);
    await world.database.session.query(
      `CREATE TRIGGER fss_test_slow_enrolment BEFORE INSERT ON sequence_enrollments
         FOR EACH ROW EXECUTE FUNCTION fss_test_slow_enrolment()`,
    );

    try {
      await expect(
        withTransaction(second.session as Parameters<typeof withTransaction>[0], async () =>
          await enrollContact(
            repositoryContext(
              workspaceScope(workspaceId(), {
                kind: 'user',
                userId: world.alpha.workspace.salesperson.userId,
                role: 'salesperson',
              }),
              second.session,
            ),
            {
              sequenceVersionId: legacy[0]?.sequence_version_id ?? '',
              originKind: 'follow_up',
              permissionId: granted.value.id,
              opportunityId: firm.opportunityId,
              firmId: firm.firmId,
              contactId,
            },
          ),
        ),
      ).rejects.toThrow();
    } finally {
      await world.database.session.query('DROP TRIGGER fss_test_slow_enrolment ON sequence_enrollments');
      await world.database.session.query('DROP FUNCTION fss_test_slow_enrolment()');
    }

    // The legacy row is untouched, and no new enrolment exists.
    const { rows: after } = await world.database.session.query<{ id: string; state: string; ended_at: Date | null }>(
      'SELECT id, state, ended_at FROM sequence_enrollments WHERE workspace_id = $1 AND firm_id = $2',
      [workspaceId(), firm.firmId],
    );
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(legacyId);
    expect(after[0]?.state).toBe('active');
    expect(after[0]?.ended_at).toBeNull();
  });
});
