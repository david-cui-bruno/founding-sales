import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeStepExecution } from '@fss/domain/db/testing/stepExecutions.ts';
import type { GmailClient } from '@fss/domain/mail/gmailClient.ts';
import {
  recordedSentMessageId,
  recordedSentThreadId,
  type GmailFixtureMessage,
} from '@fss/domain/mail/gmailClientFake.ts';
import { readOutboundOutcome } from '@fss/domain/outbound/fence.ts';
import { deterministicMessageId } from '@fss/domain/outbound/types.ts';
import {
  OPEN_INSTANT,
  SENDING_DOMAIN,
  createOutboundWorld,
  type OutboundWorld,
} from '../../../packages/domain/test/outbound/support/outboundWorld.ts';
import { todayReplyPromoter } from '../src/handlers/mail.ts';
import {
  UNATTACHED_SEND_HOLD_SOURCE,
  holdsReleaseRestoreCommand,
  inDoubtFenceIds,
  mailboxListCommand,
  mailboxReconcileSentCommand,
  parseInventory,
  type AdminInvocation,
} from '../src/tools/fss/admin.ts';
import { readToolConfig } from '../src/tools/fss/config.ts';
import { GmailCallRefused, readOnlyGmail } from '../src/tools/fss/readOnlyGmail.ts';

/**
 * `fss admin mailbox reconcile-sent`, the Sent-folder step of the restore runbook
 * (`docs/greenfield/runbooks/restore.md`; lane W3-S8), against a real PostgreSQL and the
 * recorded Gmail client.
 *
 * The domain half (`recoverSentFolderMessage`) is tested case by case in
 * `packages/domain/test/restore/missingFences.test.ts`. This file is the command: that a
 * lost send is put back, that it refuses to finish — with the report printed — while a send
 * is unattached or a Sent folder was not read to the end, and that the Gmail client it acts
 * through cannot write to a mailbox whatever the deployment built.
 *
 * The mailboxes are the operator's `--inventory`, never only the copy's: the lane W3-S8
 * review found that "every connected mailbox in the restored copy" misses a mailbox
 * connected after the restore point, and that a run which read nothing exited 0.
 *
 * ## The vacuous-pass traps, named
 *
 *   * "It refuses on unresolved items" could be a command that refuses everything. So the
 *     clean case is beside it: one lost send, tombstoned, exit ok.
 *   * "It is read-only" could be a wrapper nobody calls. So the wrapper is asserted to
 *     forward every read to the client it wraps and to reject every write, by name.
 *   * "It pages through the in-doubt fences" could be a page larger than the fixture. So
 *     the page is one fence and the fixture three.
 */

const unusedDatabaseUrl = 'postgresql://fss@localhost:5432/unused';

describe('fss admin mailbox reconcile-sent', () => {
  let world: OutboundWorld;

  beforeAll(async () => {
    world = await createOutboundWorld();
  });

  afterAll(async () => {
    await world.stop();
  });

  const workspaceId = (): string => world.alpha.workspace.workspaceId;
  const context = () => world.systemContext(workspaceId());
  const fssHeader = (): string => deterministicMessageId(randomUUID(), SENDING_DOMAIN);

  function sentMessage(input: { readonly header: string; readonly to: string; readonly at: string }): GmailFixtureMessage {
    return {
      id: recordedSentMessageId(input.header),
      threadId: recordedSentThreadId(input.header),
      internalDateEpochMilliseconds: Date.parse(input.at),
      labelIds: ['SENT'],
      headers: { 'Message-ID': input.header, To: input.to, Subject: 'A short note about your properties' },
      historyId: '1000',
    };
  }

  /** A live enrollment on the alpha firm whose pending email step has no fence, for `address`. */
  async function pendingStep(address: string): Promise<{ readonly stepExecutionId: string }> {
    const session = world.database.session;
    const stepExecutionId = await makeStepExecution(session, {
      workspaceId: workspaceId(),
      firmId: world.crm.alpha.firmId,
      opportunityId: world.crm.alpha.opportunityId,
      userId: world.alpha.workspace.salesperson.userId,
      templateVersionId: world.alpha.templateVersionId,
      zone: 'Etc/UTC',
    });
    const { rows } = await session.query<{ contact_id: string }>(
      `UPDATE step_executions SET due_at = $3::timestamptz, not_before = $3::timestamptz, original_due_at = $3::timestamptz
        WHERE workspace_id = $1 AND id = $2
        RETURNING contact_id`,
      [workspaceId(), stepExecutionId, OPEN_INSTANT],
    );
    await session.query(
      `INSERT INTO email_addresses (workspace_id, firm_id, contact_id, address, source, retrieved_at,
                                    association_confidence, technical_validation, eligibility, eligibility_policy_version)
       VALUES ($1, $2, $3, $4, 'research_provider', TIMESTAMPTZ '2026-09-01 12:00:00+00',
               0.900, 'passed', 'usable', 'route-policy.1')`,
      [workspaceId(), world.crm.alpha.firmId, rows[0]?.contact_id ?? '', address],
    );
    return { stepExecutionId };
  }

  /** Both fixture mailboxes: the inventory an operator would take from the old instance. */
  const everyAddress = (): string => [world.alpha.address, world.beta.address].join(',');

  function invocation(
    gmail: GmailClient,
    since: string,
    inventory: string = everyAddress(),
    switches: readonly string[] = [],
  ): AdminInvocation {
    const sync = world.syncDeps(world.alpha);
    return {
      session: world.database.session,
      config: readToolConfig({ DATABASE_URL: unusedDatabaseUrl }),
      environment: {},
      options: { '--since': since, '--inventory': inventory },
      switches: new Set(switches),
      mail: {
        gmail,
        oauth: sync.oauth,
        cipher: world.cipher,
        journal: { append: async () => await Promise.resolve() },
        replyPromoter: todayReplyPromoter(),
        pushTopicName: 'projects/example/topics/push',
      },
    };
  }

  const tenMinutesBefore = (at: string): string => new Date(Date.parse(at) - 600_000).toISOString();

  it('puts a lost send back as a tombstone, finishes, and finds it present the second time', async () => {
    const at = '2026-09-24T16:00:00.000Z';
    const address = 'lost.send@northwind.example.test';
    const { stepExecutionId } = await pendingStep(address);
    const gmail = world.clientWith(world.alpha, { sentMessages: [sentMessage({ header: fssHeader(), to: address, at })] });

    const first = await mailboxReconcileSentCommand(invocation(gmail, tenMinutesBefore(at)));
    expect(first).toMatchObject({
      ok: true,
      value: { mailboxes_scanned: 2, missing_fences_tombstoned: 1, missing_fences_unattached: 0, mailboxes_unscanned: 0, unresolved: [] },
    });
    expect(await readOutboundOutcome(context(), stepExecutionId)).toMatchObject({ state: 'sent' });

    const second = await mailboxReconcileSentCommand(invocation(gmail, tenMinutesBefore(at)));
    expect(second).toMatchObject({ ok: true, value: { missing_fences_tombstoned: 0, sent_folder_present: 1 } });
  });

  it('refuses to finish while a send cannot be tied to one step, and prints which', async () => {
    const at = '2026-09-24T17:00:00.000Z';
    const shared = 'shared.desk@northwind.example.test';
    await pendingStep(shared);
    await pendingStep(shared);
    const header = fssHeader();
    const gmail = world.clientWith(world.alpha, { sentMessages: [sentMessage({ header, to: shared, at })] });

    const outcome = await mailboxReconcileSentCommand(invocation(gmail, tenMinutesBefore(at)));
    expect(outcome).toMatchObject({ ok: false, reason: 'reconcile_unresolved' });
    if (outcome.ok) return;
    expect(outcome.report?.['unresolved']).toEqual([
      expect.objectContaining({
        kind: 'unattached_sent_message',
        outcome: 'unattached',
        reason: 'several_live_enrollments',
        mailboxId: world.alpha.mailboxId,
        sentAt: at,
      }),
    ]);
    // The Message-ID stays a hash in the report, as it does in every line.
    expect(JSON.stringify(outcome.report)).not.toContain(header.slice(1, -1));
  });

  it('refuses to finish while a Sent folder was not read to the end', async () => {
    const at = '2026-09-24T18:00:00.000Z';
    const gmail = world.clientWith(world.alpha, {
      grantRevoked: true,
      sentMessages: [sentMessage({ header: fssHeader(), to: 'unread@northwind.example.test', at })],
    });
    const outcome = await mailboxReconcileSentCommand(invocation(gmail, tenMinutesBefore(at)));
    expect(outcome).toMatchObject({ ok: false, reason: 'reconcile_unresolved' });
    if (outcome.ok) return;
    expect(outcome.report?.['unresolved']).toEqual(
      expect.arrayContaining([
        { kind: 'sent_folder_unscanned', workspaceId: workspaceId(), mailboxId: world.alpha.mailboxId, outcome: 'grant_revoked' },
      ]),
    );
  });

  it('refuses a folder in which a listed message vanished before its metadata was read', async () => {
    const at = '2026-09-24T19:00:00.000Z';
    const address = 'vanishing.read@northwind.example.test';
    const { stepExecutionId } = await pendingStep(address);
    const kept = sentMessage({ header: fssHeader(), to: address, at });
    const gone = sentMessage({ header: fssHeader(), to: 'deleted.since@northwind.example.test', at });
    const recorded = world.clientWith(world.alpha, { sentMessages: [kept, gone] });
    // Gmail listed it, then deleted it: the metadata read answers nothing.
    const gmail: GmailClient = {
      ...recorded,
      getMetadata: async (access, id, headers) => (id === gone.id ? null : await recorded.getMetadata(access, id, headers)),
    };

    const outcome = await mailboxReconcileSentCommand(invocation(gmail, tenMinutesBefore(at)));
    expect(outcome).toMatchObject({ ok: false, reason: 'reconcile_unresolved' });
    if (outcome.ok) return;
    expect(outcome.report?.['unresolved']).toEqual(
      expect.arrayContaining([
        { kind: 'sent_folder_unscanned', workspaceId: workspaceId(), mailboxId: world.alpha.mailboxId, outcome: 'message_vanished', vanished: 1 },
      ]),
    );
    // What was read is still settled: the send that did not vanish is tombstoned.
    expect(await readOutboundOutcome(context(), stepExecutionId)).toMatchObject({ state: 'sent' });
  });

  it('refuses an inventory address the copy has no mailbox for, and a connected mailbox the inventory left out', async () => {
    const gmail = world.clientWith(world.alpha, {});
    const since = '2026-09-24T00:00:00Z';
    const outcome = await mailboxReconcileSentCommand(invocation(gmail, since, `${world.alpha.address},connected.later@example.test`));
    expect(outcome).toMatchObject({ ok: false, reason: 'reconcile_unresolved' });
    if (outcome.ok) return;
    expect(outcome.report?.['unresolved']).toEqual(
      expect.arrayContaining([
        { kind: 'mailbox_not_in_copy', address: 'connected.later@example.test' },
        { kind: 'mailbox_not_in_inventory', workspaceId: world.beta.workspace.workspaceId, mailboxId: world.beta.mailboxId },
      ]),
    );
    // The mailbox the inventory left out is still read, so nothing it sent is missed.
    expect(outcome.report?.['mailboxes_scanned']).toBe(2);
  });

  it('refuses a run that read no mailbox at all, rather than reporting nothing to do', async () => {
    const session = world.database.session;
    await session.query(`UPDATE mailboxes SET status = 'disconnected', disconnected_at = now() WHERE id = ANY($1::uuid[])`, [
      [world.alpha.mailboxId, world.beta.mailboxId],
    ]);
    try {
      const gmail = world.clientWith(world.alpha, {});
      const outcome = await mailboxReconcileSentCommand(invocation(gmail, '2026-09-24T00:00:00Z', 'connected.later@example.test'));
      expect(outcome).toMatchObject({ ok: false, reason: 'reconcile_no_coverage' });
      if (outcome.ok) return;
      expect(outcome.report).toMatchObject({ mailboxes_scanned: 0, unresolved: [{ kind: 'mailbox_not_in_copy', address: 'connected.later@example.test' }] });
    } finally {
      await session.query(`UPDATE mailboxes SET status = 'connected', disconnected_at = NULL WHERE id = ANY($1::uuid[])`, [
        [world.alpha.mailboxId, world.beta.mailboxId],
      ]);
    }
  });

  it('refuses an inventory that is empty, repeated or not addresses, and an instant that is not one', async () => {
    const gmail = world.clientWith(world.alpha, {});
    for (const inventory of ['', ' , ', `${world.alpha.address},${world.alpha.address.toUpperCase()}`, 'not-an-address']) {
      expect(await mailboxReconcileSentCommand(invocation(gmail, '2026-09-24T00:00:00Z', inventory)), inventory).toMatchObject({
        ok: false,
        reason: 'inventory_invalid',
      });
    }
    expect(parseInventory(' B@Example.Test ,a@example.test ')).toEqual(['b@example.test', 'a@example.test']);
    expect(await mailboxReconcileSentCommand(invocation(gmail, 'yesterday'))).toMatchObject({
      ok: false,
      reason: 'since_invalid',
    });
  });

  it('lists every mailbox with its address and status, read-only, for the inventory', async () => {
    const listed = await mailboxListCommand(invocation(world.clientWith(world.alpha, {}), '2026-09-24T00:00:00Z'));
    expect(listed).toMatchObject({ ok: true });
    if (!listed.ok) return;
    expect(listed.value['mailboxes']).toEqual(
      expect.arrayContaining([
        { workspaceId: workspaceId(), mailboxId: world.alpha.mailboxId, address: world.alpha.address, status: 'connected' },
        { workspaceId: world.beta.workspace.workspaceId, mailboxId: world.beta.mailboxId, address: world.beta.address, status: 'connected' },
      ]),
    );
  });

  it('with --hold-unattached, holds the firm an unattached send could belong to, once, and finishes', async () => {
    const at = '2026-09-24T20:00:00.000Z';
    const shared = 'second.shared.desk@northwind.example.test';
    await pendingStep(shared);
    await pendingStep(shared);
    const gmail = world.clientWith(world.alpha, { sentMessages: [sentMessage({ header: fssHeader(), to: shared, at })] });

    const first = await mailboxReconcileSentCommand(invocation(gmail, tenMinutesBefore(at), everyAddress(), ['--hold-unattached']));
    expect(first).toMatchObject({ ok: true, value: { missing_fences_unattached: 1, unresolved: [] } });
    if (!first.ok) return;
    const held = first.value['unattached_held'] as readonly { readonly holdIds: readonly string[] }[];
    expect(held).toHaveLength(1);
    const holdIds = held[0]?.holdIds ?? [];
    expect(holdIds).toHaveLength(1);
    const { rows } = await world.database.session.query<{ reason_code: string; scope_kind: string; scope_key: string; source_event_kind: string }>(
      `SELECT reason_code, scope_kind, scope_key, source_event_kind FROM active_holds WHERE workspace_id = $1 AND id = $2 AND released_at IS NULL`,
      [workspaceId(), holdIds[0]],
    );
    expect(rows).toEqual([
      { reason_code: 'restore_in_progress', scope_kind: 'firm', scope_key: world.crm.alpha.firmId, source_event_kind: UNATTACHED_SEND_HOLD_SOURCE },
    ]);

    const second = await mailboxReconcileSentCommand(invocation(gmail, tenMinutesBefore(at), everyAddress(), ['--hold-unattached']));
    expect(second.ok && (second.value['unattached_held'] as readonly { readonly holdIds: readonly string[] }[])[0]?.holdIds).toEqual(holdIds);
    await world.clearHolds(workspaceId());
  });

  it('reads every in-doubt fence a page at a time, never capped', async () => {
    const session = world.database.session;
    const prepared: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const id = await world.prepare(world.alpha);
      await session.query(
        `UPDATE outbound_messages SET state = 'dispatching', attempt_token = gen_random_uuid(), dispatch_started_at = now()
          WHERE workspace_id = $1 AND id = $2`,
        [workspaceId(), id],
      );
      prepared.push(id);
    }
    const input = { workspaceId: workspaceId(), mailboxId: world.alpha.mailboxId, since: '2026-01-01T00:00:00Z' };
    const everyOne = await inDoubtFenceIds(session, input);
    const pagedByOne = await inDoubtFenceIds(session, input, 1);
    expect(pagedByOne).toEqual(everyOne);
    expect(pagedByOne).toEqual(expect.arrayContaining(prepared));
    expect([...pagedByOne].sort()).toEqual(pagedByOne);
  });
});

describe('fss admin holds release-restore', () => {
  let world: OutboundWorld;

  beforeAll(async () => {
    world = await createOutboundWorld();
  });

  afterAll(async () => {
    await world.stop();
  });

  const invoke = (options: Record<string, string>): AdminInvocation => ({
    session: world.database.session,
    config: readToolConfig({ DATABASE_URL: unusedDatabaseUrl }),
    environment: {},
    options,
    switches: new Set(),
  });

  async function openRestoreHold(): Promise<string> {
    const { rows } = await world.database.session.query<{ id: string }>(
      `INSERT INTO active_holds (workspace_id, scope_kind, reason_code, blocked_action_kinds, source_event_kind, source_event_id)
       VALUES ($1, 'workspace', 'restore_in_progress', ARRAY['email_send', 'dial_authorization']::text[], 'restore.generation_mismatch', 'fixture')
       RETURNING id`,
      [world.alpha.workspace.workspaceId],
    );
    return rows[0]?.id ?? '';
  }

  it('refuses without an active admin of the hold’s workspace, or without a note, and releases nothing', async () => {
    const hold = await openRestoreHold();
    const note = 'left from the g56 generation check; nothing restored since';
    expect(await holdsReleaseRestoreCommand(invoke({ '--admin-user': 'someone', '--note': note }))).toMatchObject({ ok: false, reason: 'admin_invalid' });
    expect(
      await holdsReleaseRestoreCommand(invoke({ '--admin-user': world.alpha.workspace.admin.userId, '--note': '  ' })),
    ).toMatchObject({ ok: false, reason: 'note_invalid' });
    expect(
      await holdsReleaseRestoreCommand(invoke({ '--admin-user': world.alpha.workspace.salesperson.userId, '--note': note })),
    ).toMatchObject({ ok: false, reason: 'not_admin' });
    expect(
      await holdsReleaseRestoreCommand(invoke({ '--admin-user': world.beta.workspace.admin.userId, '--note': note })),
    ).toMatchObject({ ok: false, reason: 'not_admin' });
    expect(
      await holdsReleaseRestoreCommand(invoke({ '--admin-user': world.alpha.workspace.admin.userId, '--note': note, '--hold': randomUUID() })),
    ).toMatchObject({ ok: false, reason: 'hold_unknown' });
    const { rows } = await world.database.session.query<{ released_at: Date | null }>(
      'SELECT released_at FROM active_holds WHERE workspace_id = $1 AND id = $2',
      [world.alpha.workspace.workspaceId, hold],
    );
    expect(rows[0]?.released_at).toBeNull();
  });

  it('releases the restore holds as the admin named, with an audit row each, and no hold of another reason', async () => {
    await world.clearHolds(world.alpha.workspace.workspaceId);
    const hold = await openRestoreHold();
    const other = await world.database.session.query<{ id: string }>(
      `INSERT INTO active_holds (workspace_id, scope_kind, reason_code, blocked_action_kinds, source_event_kind)
       VALUES ($1, 'workspace', 'long_hold_review', ARRAY['email_send']::text[], 'fixture') RETURNING id`,
      [world.alpha.workspace.workspaceId],
    );
    const admin = world.alpha.workspace.admin.userId;
    const note = 'checked: opened by the generation check before W3-S8, nothing restored';
    const outcome = await holdsReleaseRestoreCommand(invoke({ '--admin-user': admin, '--note': note }));
    expect(outcome).toMatchObject({ ok: true, value: { released: 1, holds: [expect.objectContaining({ holdId: hold })], otherHoldsStillOpen: 1 } });

    const audit = await world.database.session.query<{ actor_kind: string; actor_user_id: string; action: string; subject_id: string; detail: { note: string } }>(
      `SELECT actor_kind, actor_user_id, action, subject_id, detail FROM audit_events WHERE workspace_id = $1 AND action = 'hold.restore_released'`,
      [world.alpha.workspace.workspaceId],
    );
    expect(audit.rows).toEqual([
      expect.objectContaining({ actor_kind: 'admin', actor_user_id: admin, action: 'hold.restore_released', subject_id: hold, detail: expect.objectContaining({ note }) }),
    ]);
    const still = await world.database.session.query<{ released_at: Date | null }>(
      'SELECT released_at FROM active_holds WHERE workspace_id = $1 AND id = $2',
      [world.alpha.workspace.workspaceId, other.rows[0]?.id],
    );
    expect(still.rows[0]?.released_at).toBeNull();

    // Twice is once: nothing is left to release, and nothing is audited again.
    expect(await holdsReleaseRestoreCommand(invoke({ '--admin-user': admin, '--note': note }))).toMatchObject({ ok: true, value: { released: 0 } });
  });
});

describe('the Gmail client the reconciliation acts through', () => {
  const calls: string[] = [];
  const answer = (method: string) => async (): Promise<never> => {
    calls.push(method);
    return await Promise.resolve(method as never);
  };
  const underlying: GmailClient = {
    authorizationUrl: () => {
      calls.push('authorizationUrl');
      return 'https://example.test';
    },
    exchangeAuthorizationCode: answer('exchangeAuthorizationCode'),
    refreshAccessToken: answer('refreshAccessToken'),
    revokeRefreshToken: answer('revokeRefreshToken'),
    getProfile: answer('getProfile'),
    watch: answer('watch'),
    stopWatch: answer('stopWatch'),
    listHistory: answer('listHistory'),
    listMessageIds: answer('listMessageIds'),
    getMetadata: answer('getMetadata'),
    getBody: answer('getBody'),
    sendMessage: answer('sendMessage'),
    searchSentByMessageId: answer('searchSentByMessageId'),
    listSentMessageIds: answer('listSentMessageIds'),
  };

  it('forwards every read to the client it wraps', async () => {
    const client = readOnlyGmail(underlying);
    const access = {} as never;
    const oauth = {} as never;
    expect(await client.refreshAccessToken(oauth, 'token')).toBe('refreshAccessToken');
    expect(await client.getProfile(access)).toBe('getProfile');
    expect(await client.listHistory(access, {} as never)).toBe('listHistory');
    expect(await client.listMessageIds(access, {} as never)).toBe('listMessageIds');
    expect(await client.getMetadata(access, 'id', ['Message-ID'])).toBe('getMetadata');
    expect(await client.searchSentByMessageId(access, '<a@example.test>')).toBe('searchSentByMessageId');
    expect(await client.listSentMessageIds(access, {} as never)).toBe('listSentMessageIds');
  });

  it('rejects every call that could write to a mailbox, or read a body, and never reaches the client', async () => {
    calls.length = 0;
    const client = readOnlyGmail(underlying);
    const access = {} as never;
    const oauth = {} as never;
    expect(() => client.authorizationUrl(oauth, {} as never)).toThrow(GmailCallRefused);
    for (const [name, call] of [
      ['sendMessage', () => client.sendMessage(access, {} as never)],
      ['watch', () => client.watch(access, { topicName: 'projects/example/topics/push' })],
      ['stopWatch', () => client.stopWatch(access)],
      ['revokeRefreshToken', () => client.revokeRefreshToken(oauth, 'token')],
      ['exchangeAuthorizationCode', () => client.exchangeAuthorizationCode(oauth, { code: 'c', codeVerifier: 'v' })],
      ['getBody', () => client.getBody(access, 'id')],
    ] as const) {
      await expect(call(), name).rejects.toMatchObject({ name: 'GmailCallRefused', method: name });
    }
    expect(calls).toEqual([]);
  });
});
