import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeStepExecution } from '@fss/domain/db/testing/stepExecutions.ts';
import { type GmailClient } from '@fss/domain/mail/gmailClient.ts';
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
import { mailboxReconcileSentCommand, type AdminInvocation } from '../src/tools/fss/admin.ts';
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
 * ## The vacuous-pass traps, named
 *
 *   * "It refuses on unresolved items" could be a command that refuses everything. So the
 *     clean case is beside it: one lost send, tombstoned, exit ok.
 *   * "It is read-only" could be a wrapper nobody calls. So the wrapper is asserted to
 *     forward every read to the client it wraps and to reject every write, by name.
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

  function invocation(gmail: GmailClient, since: string, mailboxId: string = world.alpha.mailboxId): AdminInvocation {
    const sync = world.syncDeps(world.alpha);
    return {
      session: world.database.session,
      config: readToolConfig({ DATABASE_URL: unusedDatabaseUrl }),
      environment: {},
      options: { '--since': since, '--mailbox': mailboxId },
      switches: new Set(),
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
      value: { mailboxes_scanned: 1, missing_fences_tombstoned: 1, missing_fences_unattached: 0, mailboxes_unscanned: 0, unresolved: [] },
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
    const gmail = world.clientWith(world.alpha, { sentMessages: [sentMessage({ header: fssHeader(), to: shared, at })] });

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
    expect(JSON.stringify(outcome.report)).not.toContain(SENDING_DOMAIN);
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
    expect(outcome.report?.['unresolved']).toEqual([
      { kind: 'sent_folder_unscanned', workspaceId: workspaceId(), mailboxId: world.alpha.mailboxId, outcome: 'grant_revoked' },
    ]);
  });

  it('refuses a mailbox it does not have rather than reporting nothing to do', async () => {
    const gmail = world.clientWith(world.alpha, {});
    expect(await mailboxReconcileSentCommand(invocation(gmail, '2026-09-24T00:00:00Z', randomUUID()))).toMatchObject({
      ok: false,
      reason: 'mailbox_unknown',
    });
    expect(await mailboxReconcileSentCommand(invocation(gmail, 'yesterday'))).toMatchObject({
      ok: false,
      reason: 'since_invalid',
    });
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
