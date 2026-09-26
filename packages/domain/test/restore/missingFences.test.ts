import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeStepExecution } from '../../db/testing/stepExecutions.ts';
import {
  recordedSentMessageId,
  recordedSentThreadId,
  type GmailFixtureMessage,
  type RecordedGmailClient,
} from '../../mail/gmailClientFake.ts';
import {
  SENT_FOLDER_PRE_DISPATCH_PROVENANCE,
  SENT_TOMBSTONE_PROVENANCE,
  SENT_TOMBSTONE_RULE_VERSION,
  insertSentTombstone,
  prepareOutboundMessage,
  readFence,
  readFenceEvents,
  readOutboundOutcome,
} from '../../outbound/fence.ts';
import { dispatchOutboundMessage, type OutboundSendDeps } from '../../outbound/send.ts';
import { scanSentFolder } from '../../outbound/sentFolder.ts';
import { deterministicMessageId, fssFenceIdOfSentMessage } from '../../outbound/types.ts';
import {
  RESTORE_SENT_SCAN_SKEW_SECONDS,
  recoverSentFolderMessage,
  type SentMessageRecovery,
} from '../../restore/index.ts';
import { allowAllEligibility } from '../../sequences/eligibility.ts';
import { dispatchPreparedStep, runDueStepExecution } from '../../sequences/executions.ts';
import type { SendHandoff } from '../../sequences/sendHandoff.ts';
import {
  CLOSED_INSTANT,
  OPEN_INSTANT,
  SENDING_DOMAIN,
  createOutboundWorld,
  type OutboundWorld,
} from '../outbound/support/outboundWorld.ts';

/**
 * The missing fences after a point-in-time restore, against a real PostgreSQL (lane g73).
 *
 * A point-in-time restore loses the fence of every send made after the restore point and
 * keeps the message, which lives in Gmail. The step the send belonged to is back to
 * pending in the restored copy, and the sender's dedupe key — one fence per step
 * execution — is exactly what was lost. These scenarios build that state directly: a
 * pending step with no fence, and a Sent folder holding its message under FSS's
 * deterministic Message-ID. Then they run the scan (`scanSentFolder`, the Gmail half) and
 * the recovery (`recoverSentFolderMessage`, the database half) as `mailbox reconcile-sent` does, and the
 * sequence engine as the worker does.
 *
 * ## The vacuous-pass traps, named
 *
 *   * "No second send" could be the send path refusing for some reason of its own. So the
 *     engine scenario has a control: the same step, the same world, no tombstone, and the
 *     recorded Gmail client records one send. The tombstone is what makes it zero.
 *   * "Idempotent" could be a second pass that found nothing to scan. So the second pass
 *     is asserted to see the same message and answer `present`, and the row counts are
 *     compared, not the report.
 *   * "Non-FSS mail is ignored" could be a scan that ignored everything. So the listing
 *     count is asserted beside the empty result, and one of the ignored messages has the
 *     `fss.<uuid>` shape at another domain — the marker check has to read the domain.
 *   * "The window" could be a listing that returned everything. So four messages sit on
 *     either side of both bounds, one millisecond apart.
 */
describe('sends whose fence a point-in-time restore lost (lane g73)', () => {
  let world: OutboundWorld;

  beforeAll(async () => {
    world = await createOutboundWorld();
  });

  afterAll(async () => {
    await world.stop();
  });

  const workspaceId = (): string => world.alpha.workspace.workspaceId;
  const context = () => world.systemContext(workspaceId());
  const mailbox = () => ({ id: world.alpha.mailboxId, ownerUserId: world.alpha.workspace.salesperson.userId });
  const scanDeps = (gmail: RecordedGmailClient) => ({
    gmail,
    oauth: world.syncDeps(world.alpha).oauth,
    cipher: world.cipher,
  });

  /** The Message-ID FSS writes for a fence in the alpha mailbox, whose domain is example.test. */
  const fssHeader = (fenceId: string = randomUUID()): string => deterministicMessageId(fenceId, SENDING_DOMAIN);

  /** A message in the Sent folder, as a listing and a metadata read return it. */
  function sentMessage(input: { readonly header: string; readonly to: string; readonly at: string; readonly subject?: string }): GmailFixtureMessage {
    return {
      id: recordedSentMessageId(input.header),
      threadId: recordedSentThreadId(input.header),
      internalDateEpochMilliseconds: Date.parse(input.at),
      labelIds: ['SENT'],
      headers: {
        'Message-ID': input.header,
        To: input.to,
        Subject: input.subject ?? 'A short note about your properties',
      },
      historyId: '1000',
    };
  }

  const clientWithSent = (sentMessages: readonly GmailFixtureMessage[]): RecordedGmailClient =>
    world.clientWith(world.alpha, { sentMessages });

  /**
   * A live enrollment on the alpha firm whose one pending email step is due at
   * `OPEN_INSTANT`, for a fresh contact with a usable route at `address`.
   */
  async function pendingStep(address: string): Promise<{ readonly stepExecutionId: string; readonly enrollmentId: string; readonly contactId: string }> {
    const session = world.database.session;
    const stepExecutionId = await makeStepExecution(session, {
      workspaceId: workspaceId(),
      firmId: world.crm.alpha.firmId,
      opportunityId: world.crm.alpha.opportunityId,
      userId: world.alpha.workspace.salesperson.userId,
      templateVersionId: world.alpha.templateVersionId,
      zone: 'Etc/UTC',
    });
    const { rows } = await session.query<{ contact_id: string; enrollment_id: string }>(
      `UPDATE step_executions SET due_at = $3::timestamptz, not_before = $3::timestamptz, original_due_at = $3::timestamptz
        WHERE workspace_id = $1 AND id = $2
        RETURNING contact_id, enrollment_id`,
      [workspaceId(), stepExecutionId, OPEN_INSTANT],
    );
    const contactId = rows[0]?.contact_id ?? '';
    await session.query(
      `INSERT INTO email_addresses (workspace_id, firm_id, contact_id, address, source, retrieved_at,
                                    association_confidence, technical_validation, eligibility, eligibility_policy_version)
       VALUES ($1, $2, $3, $4, 'research_provider', TIMESTAMPTZ '2026-09-01 12:00:00+00',
               0.900, 'passed', 'usable', 'route-policy.1')`,
      [workspaceId(), world.crm.alpha.firmId, contactId, address],
    );
    return { stepExecutionId, enrollmentId: rows[0]?.enrollment_id ?? '', contactId };
  }

  /** Step 3's Sent-folder half, over one client, as the tool runs it. */
  async function pass(
    gmail: RecordedGmailClient,
    window: { readonly since: string; readonly until: string },
  ): Promise<{ readonly scan: Awaited<ReturnType<typeof scanSentFolder>>; readonly recoveries: readonly SentMessageRecovery[] }> {
    const scan = await scanSentFolder(context(), scanDeps(gmail), { mailboxId: world.alpha.mailboxId, ...window });
    const recoveries: SentMessageRecovery[] = [];
    for (const message of scan.messages) {
      recoveries.push(await recoverSentFolderMessage(context(), { mailbox: mailbox(), message, actor: 'test-restore' }));
    }
    return { scan, recoveries };
  }

  const count = async (sql: string, values: readonly unknown[]): Promise<number> => {
    const { rows } = await world.database.session.query<{ count: string }>(sql, values);
    return Number(rows[0]?.count ?? '0');
  };

  const around = (at: string) => ({
    since: new Date(Date.parse(at) - RESTORE_SENT_SCAN_SKEW_SECONDS * 1000).toISOString(),
    until: new Date(Date.parse(at) + 60_000).toISOString(),
  });

  it('reads the marker whole: fss.<uuid> at the sending mailbox’s own domain, and nothing else', () => {
    const fenceId = randomUUID();
    expect(fssFenceIdOfSentMessage(`<fss.${fenceId}@example.test>`, 'sales.alpha@example.test')).toBe(fenceId);
    expect(fssFenceIdOfSentMessage(` <fss.${fenceId}@EXAMPLE.test> `, 'sales.alpha@example.test')).toBe(fenceId);
    // The shape at another domain is not FSS's send from this mailbox.
    expect(fssFenceIdOfSentMessage(`<fss.${fenceId}@elsewhere.example.test>`, 'sales.alpha@example.test')).toBeNull();
    // Gmail's own ids, and near misses.
    expect(fssFenceIdOfSentMessage('<CAFb3x9k2@mail.gmail.com>', 'sales.alpha@example.test')).toBeNull();
    expect(fssFenceIdOfSentMessage(`<fss.not-a-fence@example.test>`, 'sales.alpha@example.test')).toBeNull();
    expect(fssFenceIdOfSentMessage(`<fss.${'-'.repeat(36)}@example.test>`, 'sales.alpha@example.test')).toBeNull();
    expect(fssFenceIdOfSentMessage(`fss.${fenceId}@example.test`, 'sales.alpha@example.test')).toBeNull();
  });

  it('tombstones a send whose fence the restore lost, on the step it was the send of, exactly once', async () => {
    const recipient = 'lost.once@northwind.example.test';
    const step = await pendingStep(recipient);
    const lostFence = randomUUID();
    const header = fssHeader(lostFence);
    const at = '2026-09-24T14:05:06.789Z';
    const gmail = clientWithSent([sentMessage({ header, to: `Pat Example <${recipient}>`, at, subject: 'Hello from Callie' })]);

    const first = await pass(gmail, around(at));
    expect(first.scan.outcome).toBe('scanned');
    expect(first.recoveries).toEqual([
      {
        outcome: 'tombstoned',
        outboundMessageId: lostFence,
        stepExecutionId: step.stepExecutionId,
        enrollmentId: step.enrollmentId,
        stepCompleted: true,
      },
    ]);

    // The row: the lost fence's own id and Message-ID, sent at Gmail's instant, on the
    // step, with Gmail's ids — so the mail pipeline recognises it and a reply finds it.
    const fence = await readFence(context(), lostFence);
    expect(fence).toMatchObject({
      state: 'sent',
      originKind: 'step_execution',
      stepExecutionId: step.stepExecutionId,
      enrollmentId: step.enrollmentId,
      contactId: step.contactId,
      mailboxId: world.alpha.mailboxId,
      recipientAddress: recipient,
      providerMessageIdHeader: header,
      providerMessageId: recordedSentMessageId(header),
      providerThreadId: recordedSentThreadId(header),
      sentAt: at,
      dispatchStartedAt: at,
      subject: 'Hello from Callie',
    });
    expect(fence?.recipientRouteId).not.toBeNull();
    const placement = await world.database.session.query<{ placement_rule_version: string }>(
      'SELECT placement_rule_version FROM outbound_messages WHERE workspace_id = $1 AND id = $2',
      [workspaceId(), lostFence],
    );
    expect(placement.rows[0]?.placement_rule_version).toBe(SENT_TOMBSTONE_RULE_VERSION);
    const events = await world.database.session.query<{ from_state: string | null; to_state: string; detail: Record<string, unknown> }>(
      'SELECT from_state, to_state, detail FROM outbound_message_events WHERE workspace_id = $1 AND outbound_message_id = $2',
      [workspaceId(), lostFence],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({ from_state: null, to_state: 'sent' });
    expect(events.rows[0]?.detail['reconciled_from']).toBe(SENT_TOMBSTONE_PROVENANCE);

    // The step is completed from the original send, as the engine would on seeing it sent.
    const execution = await world.database.session.query<{ state: string; completed_at: Date; result: string }>(
      'SELECT state, completed_at, result FROM step_executions WHERE workspace_id = $1 AND id = $2',
      [workspaceId(), step.stepExecutionId],
    );
    expect(execution.rows[0]?.state).toBe('completed');
    expect(execution.rows[0]?.result).toBe('sent');
    expect(execution.rows[0]?.completed_at.toISOString()).toBe(at);

    // Idempotent: the second pass sees the same message and finds its tombstone.
    const fences = await count('SELECT count(*)::text AS count FROM outbound_messages WHERE workspace_id = $1', [workspaceId()]);
    const second = await pass(gmail, around(at));
    expect(second.scan.messages).toHaveLength(1);
    expect(second.recoveries).toEqual([{ outcome: 'present', outboundMessageId: lostFence, state: 'sent' }]);
    expect(await count('SELECT count(*)::text AS count FROM outbound_messages WHERE workspace_id = $1', [workspaceId()])).toBe(fences);
    expect(
      await count('SELECT count(*)::text AS count FROM outbound_message_events WHERE workspace_id = $1 AND outbound_message_id = $2', [
        workspaceId(),
        lostFence,
      ]),
    ).toBe(1);
  });

  it('leaves a fence the restored copy still has exactly as it was', async () => {
    const fenceId = await world.prepare(world.alpha);
    const sent = await dispatchOutboundMessage(context(), world.sendDeps(world.alpha), { outboundMessageId: fenceId });
    expect(sent.outcome).toBe('sent');
    const before = await readFence(context(), fenceId);
    const eventsBefore = await readFenceEvents(context(), fenceId);
    // The Sent folder the dispatch delivered into.
    const delivered = world.alpha.gmail.sentMessages.filter(
      message => message.headers['Message-ID'] === before?.providerMessageIdHeader,
    );
    expect(delivered).toHaveLength(1);

    const { recoveries } = await pass(clientWithSent(delivered), {
      since: new Date(Date.now() - 60_000).toISOString(),
      until: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(recoveries).toEqual([{ outcome: 'present', outboundMessageId: fenceId, state: 'sent' }]);
    expect(await readFence(context(), fenceId)).toEqual(before);
    expect(await readFenceEvents(context(), fenceId)).toEqual(eventsBefore);
  });

  it('ignores Sent mail that is not FSS’s, even to a prospect with a pending step', async () => {
    const recipient = 'not.ours@northwind.example.test';
    const step = await pendingStep(recipient);
    const at = '2026-09-24T15:00:00.000Z';
    const gmail = clientWithSent([
      sentMessage({ header: '<CAFb3x9k2Lq7@mail.gmail.com>', to: recipient, at }),
      sentMessage({ header: `<fss.${randomUUID()}@elsewhere.example.test>`, to: recipient, at }),
    ]);
    const { scan, recoveries } = await pass(gmail, around(at));
    expect(scan.outcome).toBe('scanned');
    expect(scan.listed).toBe(2);
    expect(scan.messages).toEqual([]);
    expect(recoveries).toEqual([]);
    expect(await readOutboundOutcome(context(), step.stepExecutionId)).toMatchObject({ state: 'absent' });
    const execution = await world.database.session.query<{ state: string }>(
      'SELECT state FROM step_executions WHERE workspace_id = $1 AND id = $2',
      [workspaceId(), step.stepExecutionId],
    );
    expect(execution.rows[0]?.state).toBe('pending');
  });

  it('reads the window to the millisecond: from the restore point minus the skew, to now', async () => {
    const since = '2026-09-24T16:00:00.000Z';
    const until = '2026-09-24T16:30:00.000Z';
    const at = (offset: number, base: string): string => new Date(Date.parse(base) + offset).toISOString();
    const early = fssHeader();
    const first = fssHeader();
    const last = fssHeader();
    const late = fssHeader();
    const gmail = clientWithSent([
      sentMessage({ header: early, to: 'window.early@northwind.example.test', at: at(-1, since) }),
      sentMessage({ header: first, to: 'window.first@northwind.example.test', at: since }),
      sentMessage({ header: last, to: 'window.last@northwind.example.test', at: until }),
      sentMessage({ header: late, to: 'window.late@northwind.example.test', at: at(1, until) }),
    ]);
    const { scan, recoveries } = await pass(gmail, { since, until });
    expect(scan.messages.map(message => message.rfcMessageId)).toEqual([first, last]);
    // Neither recipient is anybody's live enrollment: nothing restored could send to them.
    expect(recoveries).toEqual([
      { outcome: 'unmatched', reason: 'no_live_enrollment' },
      { outcome: 'unmatched', reason: 'no_live_enrollment' },
    ]);
    expect(RESTORE_SENT_SCAN_SKEW_SECONDS).toBe(600);
  });

  it('records a prepared fence the Sent folder proves already left as sent, and the sender does not send it again', async () => {
    const fenceId = await world.prepare(world.alpha);
    const prepared = await readFence(context(), fenceId);
    expect(prepared?.state).toBe('prepared');
    const at = '2026-09-24T17:00:00.000Z';
    const gmail = clientWithSent([
      sentMessage({ header: prepared?.providerMessageIdHeader ?? '', to: world.alpha.recipientAddress, at }),
    ]);
    const { recoveries } = await pass(gmail, around(at));
    expect(recoveries).toEqual([
      {
        outcome: 'pre_dispatch_marked_sent',
        outboundMessageId: fenceId,
        stepExecutionId: prepared?.stepExecutionId ?? null,
        stepCompleted: true,
      },
    ]);
    const fence = await readFence(context(), fenceId);
    expect(fence).toMatchObject({ state: 'sent', sentAt: at, dispatchStartedAt: at });
    const events = await world.database.session.query<{ to_state: string; detail: Record<string, unknown> }>(
      'SELECT to_state, detail FROM outbound_message_events WHERE workspace_id = $1 AND outbound_message_id = $2 ORDER BY sequence_number',
      [workspaceId(), fenceId],
    );
    expect(events.rows.map(row => row.to_state)).toEqual(['prepared', 'dispatching', 'sent']);
    expect(events.rows[2]?.detail['reconciled_from']).toBe(SENT_FOLDER_PRE_DISPATCH_PROVENANCE);

    const sender = clientWithSent([]);
    const again = await dispatchOutboundMessage(context(), world.sendDeps(world.alpha, { gmail: sender }), {
      outboundMessageId: fenceId,
    });
    expect(again.outcome).toBe('already_terminal');
    expect(sender.sends).toHaveLength(0);
  });

  it('records a held fence the Sent folder proves already left as sent, and releases the hold it opened', async () => {
    await world.clearHolds(workspaceId());
    const fenceId = await world.prepare(world.alpha);
    // Held the way a real one is: the dispatch path, before the window opens.
    const held = await dispatchOutboundMessage(context(), world.sendDeps(world.alpha, { now: () => new Date(CLOSED_INSTANT) }), {
      outboundMessageId: fenceId,
    });
    expect(held.outcome).toBe('held');
    const openHolds = 'SELECT count(*)::text AS count FROM active_holds WHERE workspace_id = $1 AND source_event_id = $2 AND released_at IS NULL';
    expect(await count(openHolds, [workspaceId(), fenceId])).toBe(1);

    const fence = await readFence(context(), fenceId);
    const at = '2026-09-24T17:30:00.000Z';
    const gmail = clientWithSent([sentMessage({ header: fence?.providerMessageIdHeader ?? '', to: world.alpha.recipientAddress, at })]);
    const { recoveries } = await pass(gmail, around(at));
    expect(recoveries[0]).toMatchObject({ outcome: 'pre_dispatch_marked_sent', outboundMessageId: fenceId });
    expect(await readFence(context(), fenceId)).toMatchObject({ state: 'sent', sentAt: at, heldReason: null });
    const events = await readFenceEvents(context(), fenceId);
    expect(events.map(event => event.toState)).toEqual(['prepared', 'held', 'prepared', 'dispatching', 'sent']);
    expect(await count(openHolds, [workspaceId(), fenceId])).toBe(0);
  });

  it('reports a send nothing restored could repeat, and refuses to guess where two live steps could', async () => {
    const at = '2026-09-24T18:00:00.000Z';
    // Two contacts share an address, each with a live enrollment: either could be the one.
    const shared = 'shared.inbox@northwind.example.test';
    const one = await pendingStep(shared);
    const two = await pendingStep(shared);
    // An enrollment whose pending step already has a fence: a second lost send of it has
    // no step left to be.
    const fenced = 'already.fenced@northwind.example.test';
    const busy = await pendingStep(fenced);
    const prepared = await prepareOutboundMessage(context(), {
      stepExecutionId: busy.stepExecutionId,
      enrollmentId: busy.enrollmentId,
      firmId: world.crm.alpha.firmId,
      contactId: busy.contactId,
      opportunityId: world.crm.alpha.opportunityId,
      ownerUserId: world.alpha.workspace.salesperson.userId,
      templateVersionId: world.alpha.templateVersionId,
      templateContentHash: world.alpha.templateContentHash,
      toAddress: fenced,
      subject: 'A short note about your properties',
      body: 'Hello.\n\nI work with property managers nearby.\n\nSigned off\nReply "stop" and I will not email you again.',
      sendAt: OPEN_INSTANT,
      sourceZone: 'UTC',
      businessDate: '2026-09-23',
    });
    expect(prepared.ok).toBe(true);

    const gmail = clientWithSent([
      sentMessage({ header: fssHeader(), to: 'nobody.enrolled@northwind.example.test', at }),
      sentMessage({ header: fssHeader(), to: shared, at: new Date(Date.parse(at) + 1000).toISOString() }),
      sentMessage({ header: fssHeader(), to: fenced, at: new Date(Date.parse(at) + 2000).toISOString() }),
      sentMessage({ header: fssHeader(), to: 'two@northwind.example.test, three@northwind.example.test', at: new Date(Date.parse(at) + 3000).toISOString() }),
    ]);
    const { recoveries } = await pass(gmail, around(at));
    expect(recoveries).toEqual([
      { outcome: 'unmatched', reason: 'no_live_enrollment' },
      { outcome: 'unattached', reason: 'several_live_enrollments', firmIds: [world.crm.alpha.firmId] },
      { outcome: 'unattached', reason: 'open_step_has_fence', firmIds: [world.crm.alpha.firmId] },
      { outcome: 'unattached', reason: 'recipient_unreadable', firmIds: [] },
    ]);
    for (const step of [one, two]) {
      expect(await readOutboundOutcome(context(), step.stepExecutionId)).toMatchObject({ state: 'absent' });
    }
  });

  it('tombstones two lost sends of one enrollment on its two steps, oldest first', async () => {
    const session = world.database.session;
    const salesperson = world.alpha.workspace.salesperson.userId;
    const recipient = 'two.steps@northwind.example.test';
    // A published two-email sequence, a contact with a route, and an enrollment whose
    // first step is pending: the restored copy's state after losing both sends.
    const sequence = await session.query<{ id: string }>(
      "INSERT INTO sequences (workspace_id, name, created_by_user_id) VALUES ($1, 'Two lost steps', $2) RETURNING id",
      [workspaceId(), salesperson],
    );
    const version = await session.query<{ id: string }>(
      'INSERT INTO sequence_versions (workspace_id, sequence_id, version) VALUES ($1, $2, 1) RETURNING id',
      [workspaceId(), sequence.rows[0]?.id],
    );
    const versionId = version.rows[0]?.id ?? '';
    const stepIds: string[] = [];
    for (const [ordinal, hours] of [
      [1, 0],
      [2, 48],
    ] as const) {
      const step = await session.query<{ id: string }>(
        `INSERT INTO sequence_steps (workspace_id, sequence_version_id, ordinal, channel, delay_unit, delay_amount, template_version_id)
         VALUES ($1, $2, $3, 'email', 'elapsed', $4, $5) RETURNING id`,
        [workspaceId(), versionId, ordinal, hours, world.alpha.templateVersionId],
      );
      stepIds.push(step.rows[0]?.id ?? '');
    }
    await session.query(
      "UPDATE sequence_versions SET state = 'published', published_at = now(), published_by_user_id = $3 WHERE workspace_id = $1 AND id = $2",
      [workspaceId(), versionId, salesperson],
    );
    const contact = await session.query<{ id: string }>(
      "INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, 'Two Steps Example') RETURNING id",
      [workspaceId(), world.crm.alpha.firmId],
    );
    const contactId = contact.rows[0]?.id ?? '';
    await session.query(
      `INSERT INTO email_addresses (workspace_id, firm_id, contact_id, address, source, retrieved_at,
                                    association_confidence, technical_validation, eligibility, eligibility_policy_version)
       VALUES ($1, $2, $3, $4, 'research_provider', TIMESTAMPTZ '2026-09-01 12:00:00+00', 0.900, 'passed', 'usable', 'route-policy.1')`,
      [workspaceId(), world.crm.alpha.firmId, contactId, recipient],
    );
    const enrollment = await session.query<{ id: string }>(
      `INSERT INTO sequence_enrollments (workspace_id, sequence_version_id, opportunity_id, firm_id, contact_id,
                                         assigned_user_id, firm_time_zone, holiday_calendar_version, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'Etc/UTC', 'none.1', $7::timestamptz) RETURNING id`,
      [workspaceId(), versionId, world.crm.alpha.opportunityId, world.crm.alpha.firmId, contactId, salesperson, OPEN_INSTANT],
    );
    const enrollmentId = enrollment.rows[0]?.id ?? '';
    await session.query(
      `INSERT INTO step_executions (workspace_id, enrollment_id, step_id, firm_id, contact_id, channel, ordinal,
                                    due_at, not_before, original_due_at, source_zone, rule_version)
       VALUES ($1, $2, $3, $4, $5, 'email', 1, $6::timestamptz, $6::timestamptz, $6::timestamptz, 'Etc/UTC', 'elapsed.1')`,
      [workspaceId(), enrollmentId, stepIds[0], world.crm.alpha.firmId, contactId, OPEN_INSTANT],
    );

    const firstSend = fssHeader();
    const secondSend = fssHeader();
    const at = '2026-09-25T09:00:00.000Z';
    // Listed newest first on purpose: the scan orders them by Gmail's instant.
    const gmail = clientWithSent([
      sentMessage({ header: secondSend, to: recipient, at: '2026-09-25T09:05:00.000Z' }),
      sentMessage({ header: firstSend, to: recipient, at }),
    ]);
    const { recoveries } = await pass(gmail, { since: around(at).since, until: '2026-09-25T09:10:00.000Z' });
    expect(recoveries.map(recovery => recovery.outcome)).toEqual(['tombstoned', 'tombstoned']);
    const fences = await session.query<{ ordinal: number; header: string; state: string }>(
      `SELECT e.ordinal, o.provider_message_id_header AS header, e.state
         FROM outbound_messages o JOIN step_executions e ON e.workspace_id = o.workspace_id AND e.id = o.step_execution_id
        WHERE o.workspace_id = $1 AND o.enrollment_id = $2 ORDER BY e.ordinal`,
      [workspaceId(), enrollmentId],
    );
    expect(fences.rows).toEqual([
      { ordinal: 1, header: firstSend, state: 'completed' },
      { ordinal: 2, header: secondSend, state: 'completed' },
    ]);
  });

  it('reports a Sent folder it could not read as unscanned, never as empty', async () => {
    const gmail = world.clientWith(world.alpha, {
      grantRevoked: true,
      sentMessages: [sentMessage({ header: fssHeader(), to: 'unread@northwind.example.test', at: '2026-09-24T19:00:00.000Z' })],
    });
    const { scan } = await pass(gmail, around('2026-09-24T19:00:00.000Z'));
    expect(scan).toEqual({ outcome: 'grant_revoked', listed: 0, messages: [] });
  });

  describe('the sequence engine and a tombstoned step', () => {
    /** G8's send handoff over G7-2's fence, as `apps/worker` composes it. */
    function fenceHandoff(deps: OutboundSendDeps): SendHandoff {
      return {
        prepare: async (handoffContext, request) => {
          const prepared = await prepareOutboundMessage(handoffContext, request);
          return prepared.ok
            ? { ok: true, outboundMessageId: prepared.value.outboundMessageId, created: prepared.value.created }
            : { ok: false, reason: 'scoped_pause' };
        },
        dispatch: async (handoffContext, input) => {
          const report = await dispatchOutboundMessage(handoffContext, deps, { outboundMessageId: input.outboundMessageId });
          return report.refusal === undefined ? { ok: true } : { ok: false, reason: 'scoped_pause' };
        },
        readOutcome: async (handoffContext, stepExecutionId) => {
          const outcome = await readOutboundOutcome(handoffContext, stepExecutionId);
          return { state: outcome.state, dispatchedAt: outcome.dispatchedAt, heldReason: outcome.heldReason };
        },
      };
    }

    /** Run one due step the way `sequence.action` does: decide and prepare, then dispatch. */
    async function runStep(stepExecutionId: string, gmail: RecordedGmailClient): Promise<string> {
      const handoff = fenceHandoff(world.sendDeps(world.alpha, { gmail }));
      const ran = await runDueStepExecution(context(), {
        stepExecutionId,
        now: OPEN_INSTANT,
        eligibility: allowAllEligibility(),
        sendHandoff: handoff,
      });
      if (ran.kind !== 'handed_to_send') return ran.kind;
      const dispatched = await dispatchPreparedStep(context(), {
        stepExecutionId,
        outboundMessageId: ran.outboundMessageId,
        sendHandoff: handoff,
        now: OPEN_INSTANT,
      });
      return dispatched.kind;
    }

    it('sends a due step when it has no fence — the control', async () => {
      await world.clearHolds(workspaceId());
      const step = await pendingStep('engine.control@northwind.example.test');
      const gmail = clientWithSent([]);
      expect(await runStep(step.stepExecutionId, gmail)).toBe('sent');
      expect(gmail.sends).toHaveLength(1);
    });

    it('does not send a due step whose fence is a tombstone, and completes it from the original send', async () => {
      await world.clearHolds(workspaceId());
      const recipient = 'engine.tombstoned@northwind.example.test';
      const step = await pendingStep(recipient);
      const lostFence = randomUUID();
      const header = fssHeader(lostFence);
      const sentAt = '2026-09-23T08:30:00.000Z';
      // The tombstone alone, without the recovery's completion: the dedupe key the
      // sender uses has to see it by itself.
      const tombstone = await insertSentTombstone(context(), {
        fenceId: lostFence,
        mailboxId: world.alpha.mailboxId,
        enrollmentId: step.enrollmentId,
        stepExecutionId: step.stepExecutionId,
        firmId: world.crm.alpha.firmId,
        contactId: step.contactId,
        opportunityId: world.crm.alpha.opportunityId,
        recipientAddress: recipient,
        recipientRouteId: null,
        recipientRouteVersion: null,
        subject: 'A short note about your properties',
        rfcMessageId: header,
        providerMessageId: recordedSentMessageId(header),
        providerThreadId: recordedSentThreadId(header),
        sentAt,
        businessDate: '2026-09-23',
        actor: 'test-restore',
      });
      expect(tombstone.ok).toBe(true);

      const gmail = clientWithSent([]);
      // Lane g82: the engine reads an existing fence before it renders anything, so a
      // `sent` tombstone completes the step at once rather than after a dispatch that
      // finds it terminal. Nothing is sent either way.
      expect(await runStep(step.stepExecutionId, gmail)).toBe('completed');
      expect(gmail.sends).toHaveLength(0);
      expect(
        await count('SELECT count(*)::text AS count FROM outbound_messages WHERE workspace_id = $1 AND step_execution_id = $2', [
          workspaceId(),
          step.stepExecutionId,
        ]),
      ).toBe(1);
      const execution = await world.database.session.query<{ state: string; completed_at: Date }>(
        'SELECT state, completed_at FROM step_executions WHERE workspace_id = $1 AND id = $2',
        [workspaceId(), step.stepExecutionId],
      );
      expect(execution.rows[0]?.state).toBe('completed');
      expect(execution.rows[0]?.completed_at.toISOString()).toBe(sentAt);
      // And a direct dispatch of the tombstone is refused as terminal, however it is reached.
      const direct = await dispatchOutboundMessage(context(), world.sendDeps(world.alpha, { gmail }), {
        outboundMessageId: lostFence,
      });
      expect(direct.outcome).toBe('already_terminal');
      expect(gmail.sends).toHaveLength(0);
    });
  });
});
