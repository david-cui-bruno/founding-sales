import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { QueryResultRowLike, SessionQueryable } from '@fss/domain/db/queryable.ts';
import { makeStepExecution } from '@fss/domain/db/testing/stepExecutions.ts';
import type { GmailClient } from '@fss/domain/mail/gmailClient.ts';
import {
  recordedSentMessageId,
  recordedSentThreadId,
  type GmailFixtureMessage,
} from '@fss/domain/mail/gmailClientFake.ts';
import { createGmailHttpClient } from '@fss/domain/mail/gmailClientHttp.ts';
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
  RECONCILE_FENCE_PAGE_SIZE,
  UNATTACHED_SEND_HOLD_SOURCE,
  holdsListCommand,
  holdsReleaseRestoreCommand,
  inDoubtFenceIds,
  mailboxListCommand,
  mailboxReconcileSentCommand,
  type AdminInvocation,
  type ElsewhereSession,
  type LaunchIdentity,
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
 * The mailboxes are every one the instance being replaced has, which the command reads
 * itself from `--inventory-host` (`connectElsewhere`), never the copy's alone and never a
 * typed list: the lane W3-S8 reviews found that "every connected mailbox in the restored
 * copy" misses a mailbox connected after the restore point, and that a hand-typed list
 * for a deleted source proves nothing. Here the instance being replaced is the test
 * database itself, seen through a session that can add, rename or drop mailbox rows.
 *
 * ## The vacuous-pass traps, named
 *
 *   * "It refuses on unresolved items" could be a command that refuses everything. So the
 *     clean case is beside it: one lost send, tombstoned, exit ok.
 *   * "It is read-only" could be a wrapper nobody calls. So the wrapper is asserted to
 *     forward every read to the client it wraps and to reject every write, by name.
 *   * "It pages through the in-doubt fences" could be a page larger than the fixture. So
 *     one run pages by one over three fences, and one runs the default page over more
 *     fences than the page holds.
 *   * "It refuses a deleted source" could be a refusal after Gmail was read. So the Gmail
 *     client there records every call, and there are none.
 */

const COPY_HOST = 'fss-prod-pg-r0926.example.test';
const OLD_HOST = 'fss-prod-pg.example.test';
const copyDatabaseUrl = `postgresql://fss@${COPY_HOST}:5432/fss`;
const LAUNCH: LaunchIdentity = {
  launchedBy: 'arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_Admin_0123456789abcdef/david',
  taskArn: 'arn:aws:ecs:us-east-1:123456789012:task/fss-prod/0123456789abcdef0123456789abcdef',
};

interface MailboxRow {
  readonly workspaceId: string;
  readonly id: string;
  readonly ownerUserId: string;
  readonly address: string;
  readonly status: string;
}

/**
 * The test database seen as another instance: its `mailboxes` rows filtered, renamed or
 * added to, and `mailbox.connected` audit rows added, everything else as it is.
 * `everyMailbox` and `auditedConnections` are the only readers of those rows.
 */
function mailboxView(
  real: SessionQueryable,
  change: {
    readonly drop?: readonly string[];
    readonly rename?: Readonly<Record<string, string>>;
    readonly add?: readonly MailboxRow[];
    readonly audited?: readonly { readonly workspaceId: string; readonly mailboxId: string; readonly address: string }[];
    /** Without the real `mailbox.connected` rows (the world's own connections write them). */
    readonly hideAudit?: boolean;
  },
): SessionQueryable {
  return {
    async query<Row extends QueryResultRowLike = QueryResultRowLike>(text: string, values?: readonly unknown[]) {
      const result = await real.query<Row>(text, values);
      if (/FROM audit_events\s+WHERE action = 'mailbox.connected'/u.test(text)) {
        const rows = [
          ...(change.hideAudit === true ? [] : (result.rows as unknown[])),
          ...(change.audited ?? []).map(entry => ({ workspace_id: entry.workspaceId, subject_id: entry.mailboxId, address: entry.address })),
        ];
        return { rows: rows as Row[], rowCount: rows.length };
      }
      if (!/FROM mailboxes WHERE workspace_id = \$1 ORDER BY email_address/u.test(text)) return result;
      const workspaceId = values?.[0];
      const rows = (result.rows as unknown as { id: string; email_address: string }[])
        .filter(row => !(change.drop ?? []).includes(row.id))
        .map(row => ({ ...row, email_address: change.rename?.[row.id] ?? row.email_address }));
      for (const added of change.add ?? []) {
        if (added.workspaceId !== workspaceId) continue;
        rows.push({ id: added.id, owner_user_id: added.ownerUserId, email_address: added.address, status: added.status } as never);
      }
      return { rows: rows as unknown as Row[], rowCount: rows.length };
    },
  };
}

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
  async function pendingStep(address: string): Promise<{ readonly stepExecutionId: string; readonly enrollmentId: string }> {
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
    await session.query(
      `INSERT INTO email_addresses (workspace_id, firm_id, contact_id, address, source, retrieved_at,
                                    association_confidence, technical_validation, eligibility, eligibility_policy_version)
       VALUES ($1, $2, $3, $4, 'research_provider', TIMESTAMPTZ '2026-09-01 12:00:00+00',
               0.900, 'passed', 'usable', 'route-policy.1')`,
      [workspaceId(), world.crm.alpha.firmId, rows[0]?.contact_id ?? '', address],
    );
    return { stepExecutionId, enrollmentId: rows[0]?.enrollment_id ?? '' };
  }

  interface Setup {
    /** `--inventory-host`; the instance being replaced unless a test says otherwise. */
    readonly host?: string;
    /** What `connectElsewhere` reaches: the test database by default, an error for a host that is gone. */
    readonly source?: SessionQueryable | Error | null;
    /** The copy the command runs against: the test database by default. */
    readonly copy?: SessionQueryable;
    readonly switches?: readonly string[];
  }

  /** Every host `connectElsewhere` was asked for, and how many sessions were closed. */
  const reached: string[] = [];
  let closed = 0;

  function invocation(gmail: GmailClient, since: string, setup: Setup = {}): AdminInvocation {
    const sync = world.syncDeps(world.alpha);
    const source = setup.source === undefined ? world.database.session : setup.source;
    return {
      session: setup.copy ?? world.database.session,
      config: readToolConfig({ DATABASE_URL: copyDatabaseUrl }),
      environment: {},
      options: { '--since': since, '--inventory-host': setup.host ?? OLD_HOST },
      switches: new Set(setup.switches ?? []),
      mail: {
        gmail,
        oauth: sync.oauth,
        cipher: world.cipher,
        journal: { append: async () => await Promise.resolve() },
        replyPromoter: todayReplyPromoter(),
        pushTopicName: 'projects/example/topics/push',
      },
      ...(source === null
        ? {}
        : {
            connectElsewhere: async (host: string): Promise<ElsewhereSession> => {
              reached.push(host);
              if (source instanceof Error) throw source;
              return await Promise.resolve({
                session: source,
                close: async () => {
                  closed += 1;
                  return await Promise.resolve();
                },
              });
            },
          }),
    };
  }

  const tenMinutesBefore = (at: string): string => new Date(Date.parse(at) - 600_000).toISOString();

  it('puts a lost send back as a tombstone, finishes, and finds it present the second time', async () => {
    const at = '2026-09-24T16:00:00.000Z';
    const address = 'lost.send@northwind.example.test';
    const { stepExecutionId } = await pendingStep(address);
    const gmail = world.clientWith(world.alpha, { sentMessages: [sentMessage({ header: fssHeader(), to: address, at })] });

    reached.length = 0;
    closed = 0;
    const first = await mailboxReconcileSentCommand(invocation(gmail, tenMinutesBefore(at)));
    expect(first).toMatchObject({
      ok: true,
      value: {
        inventory_host: OLD_HOST,
        inventory: [world.alpha.address, world.beta.address].sort(),
        mailboxes_scanned: 2,
        missing_fences_tombstoned: 1,
        missing_fences_unattached: 0,
        mailboxes_unscanned: 0,
        unresolved: [],
      },
    });
    // The inventory was read from the instance being replaced, and the session closed.
    expect(reached).toEqual([OLD_HOST]);
    expect(closed).toBe(1);
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

  it('refuses a Sent folder whose live listing Gmail answered 200 with something that is not one', async () => {
    // Lane W3-S8 review: the HTTP client read a malformed listing as an empty page, the
    // scan said `scanned`, and the run exited 0 having read nothing. The listing here is
    // the production client's own, over a fetch that answers every page malformed.
    const bodies = ['{"messages": [{"id": "m-1"}', '{"messages": {"id": "m-1"}}', '{"messages": [{"threadId": "t-1"}]}'];
    for (const body of bodies) {
      const live = createGmailHttpClient({
        apiBaseUrl: 'https://gmail.example.test',
        fetch: async () => await Promise.resolve({ status: 200, headers: {}, body }),
      });
      const gmail: GmailClient = { ...world.clientWith(world.alpha, {}), listSentMessageIds: live.listSentMessageIds };
      const outcome = await mailboxReconcileSentCommand(invocation(gmail, '2026-09-24T00:00:00Z'));
      expect(outcome, body).toMatchObject({ ok: false, reason: 'reconcile_unresolved' });
      if (outcome.ok) return;
      expect(outcome.report?.['unresolved'], body).toEqual(
        expect.arrayContaining([
          { kind: 'sent_folder_unscanned', workspaceId: workspaceId(), mailboxId: world.alpha.mailboxId, outcome: 'malformed_response' },
          {
            kind: 'sent_folder_unscanned',
            workspaceId: world.beta.workspace.workspaceId,
            mailboxId: world.beta.mailboxId,
            outcome: 'malformed_response',
          },
        ]),
      );
    }
  });

  it('refuses a mailbox the instance being replaced has and the copy lacks, and one it knows by another address', async () => {
    const gmail = world.clientWith(world.alpha, {});
    // Connected after the restore point: the old instance has it, the copy cannot.
    const later: MailboxRow = {
      workspaceId: workspaceId(),
      id: randomUUID(),
      ownerUserId: world.alpha.workspace.salesperson.userId,
      address: 'connected.later@example.test',
      status: 'connected',
    };
    // Beta renamed since, on an instance whose trail (unlike the world's) never recorded
    // beta's first address: the copy's beta is then in no inventory at all.
    const source = mailboxView(world.database.session, {
      add: [later],
      rename: { [world.beta.mailboxId]: 'renamed.since@example.test' },
      hideAudit: true,
    });
    const outcome = await mailboxReconcileSentCommand(invocation(gmail, '2026-09-24T00:00:00Z', { source }));
    expect(outcome).toMatchObject({ ok: false, reason: 'reconcile_unresolved' });
    if (outcome.ok) return;
    expect(outcome.report?.['unresolved']).toEqual([
      { kind: 'mailbox_not_in_copy', address: 'connected.later@example.test' },
      { kind: 'mailbox_not_in_copy', address: 'renamed.since@example.test' },
      { kind: 'mailbox_not_in_inventory', workspaceId: world.beta.workspace.workspaceId, mailboxId: world.beta.mailboxId },
    ]);
    // The mailbox the inventory named differently is still read, so nothing it sent is missed.
    expect(outcome.report?.['mailboxes_scanned']).toBe(2);
    // With the trail, beta's first address is in the inventory and beta is read under it.
    const trailed = mailboxView(world.database.session, { add: [later], rename: { [world.beta.mailboxId]: 'renamed.since@example.test' } });
    const withTrail = await mailboxReconcileSentCommand(invocation(gmail, '2026-09-24T00:00:00Z', { source: trailed }));
    expect(withTrail.ok ? [] : withTrail.report?.['unresolved']).toEqual([
      { kind: 'mailbox_not_in_copy', address: 'connected.later@example.test' },
      { kind: 'mailbox_not_in_copy', address: 'renamed.since@example.test' },
    ]);
  });

  it('adds every address the old instance’s audit trail says was connected to the inventory', async () => {
    const gmail = world.clientWith(world.alpha, {});
    // Alpha's row says one address; the trail says it was once connected as another.
    const source = mailboxView(world.database.session, {
      audited: [
        { workspaceId: workspaceId(), mailboxId: world.alpha.mailboxId, address: world.alpha.address },
        { workspaceId: workspaceId(), mailboxId: world.alpha.mailboxId, address: 'earlier.account@example.test' },
      ],
    });
    const outcome = await mailboxReconcileSentCommand(invocation(gmail, '2026-09-24T00:00:00Z', { source }));
    expect(outcome).toMatchObject({ ok: false, reason: 'reconcile_unresolved' });
    if (outcome.ok) return;
    expect(outcome.report?.['inventory']).toEqual(['earlier.account@example.test', world.alpha.address, world.beta.address].sort());
    expect(outcome.report?.['unresolved']).toEqual([{ kind: 'mailbox_not_in_copy', address: 'earlier.account@example.test' }]);
  });

  it('refuses a run that read no mailbox at all, rather than reporting nothing to do', async () => {
    const gmail = world.clientWith(world.alpha, {});
    // A copy with no mailbox row at all, against an old instance that has both.
    const copy = mailboxView(world.database.session, { drop: [world.alpha.mailboxId, world.beta.mailboxId] });
    const outcome = await mailboxReconcileSentCommand(invocation(gmail, '2026-09-24T00:00:00Z', { copy }));
    expect(outcome).toMatchObject({ ok: false, reason: 'reconcile_no_coverage' });
    if (outcome.ok) return;
    expect(outcome.report).toMatchObject({
      mailboxes_scanned: 0,
      unresolved: expect.arrayContaining([{ kind: 'mailbox_not_in_copy', address: world.alpha.address }]),
    });
  });

  it('refuses before reading Gmail when the instance being replaced is gone: the deleted-source case', async () => {
    const calls: string[] = [];
    const recorded = world.clientWith(world.alpha, {});
    const gmail = new Proxy(recorded, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function'
          ? (...args: unknown[]) => {
              calls.push(String(property));
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            }
          : value;
      },
    });
    const gone = [
      Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }),
      Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }),
      new Error('Connection terminated due to connection timeout'),
    ];
    for (const source of gone) {
      const outcome = await mailboxReconcileSentCommand(invocation(gmail, '2026-09-24T00:00:00Z', { source }));
      expect(outcome, source.message).toMatchObject({ ok: false, reason: 'inventory_unreadable' });
      if (!outcome.ok) expect(outcome.detail).toContain(OLD_HOST);
    }
    // A build that cannot reach another host at all refuses the same way.
    expect(await mailboxReconcileSentCommand(invocation(gmail, '2026-09-24T00:00:00Z', { source: null }))).toMatchObject({
      ok: false,
      reason: 'inventory_unreadable',
    });
    // Nothing was read from Gmail and nothing was written: there is no typed list to fall back on.
    expect(calls).toEqual([]);
  });

  it('refuses a host that is not one, the copy itself, an empty instance, and one missing a mailbox the copy has', async () => {
    const gmail = world.clientWith(world.alpha, {});
    const since = '2026-09-24T00:00:00Z';
    for (const host of ['', 'localhost', `${OLD_HOST}:5432`, `postgresql://${OLD_HOST}`, 'FSS_PROD_PG']) {
      expect(await mailboxReconcileSentCommand(invocation(gmail, since, { host })), host).toMatchObject({
        ok: false,
        reason: 'inventory_host_invalid',
      });
    }
    expect(await mailboxReconcileSentCommand(invocation(gmail, since, { host: COPY_HOST.toUpperCase() }))).toMatchObject({
      ok: false,
      reason: 'inventory_host_is_the_copy',
    });
    const empty = mailboxView(world.database.session, { drop: [world.alpha.mailboxId, world.beta.mailboxId] });
    expect(await mailboxReconcileSentCommand(invocation(gmail, since, { source: empty }))).toMatchObject({
      ok: false,
      reason: 'inventory_empty',
    });
    // The application never deletes a mailbox row, so an instance without one the copy
    // has was damaged, and its list cannot be the whole list.
    const damaged = mailboxView(world.database.session, { drop: [world.beta.mailboxId] });
    const incomplete = await mailboxReconcileSentCommand(invocation(gmail, since, { source: damaged }));
    expect(incomplete).toMatchObject({ ok: false, reason: 'inventory_source_incomplete' });
    if (!incomplete.ok) expect(incomplete.detail).toContain(world.beta.mailboxId);
    // Nor may it lack one its own append-only audit trail records connecting.
    const vanishedRow = randomUUID();
    const unaudited = mailboxView(world.database.session, {
      audited: [{ workspaceId: workspaceId(), mailboxId: vanishedRow, address: 'row.deleted@example.test' }],
    });
    const trail = await mailboxReconcileSentCommand(invocation(gmail, since, { source: unaudited }));
    expect(trail).toMatchObject({ ok: false, reason: 'inventory_source_incomplete' });
    if (!trail.ok) expect(trail.detail).toContain(vanishedRow);
    expect(await mailboxReconcileSentCommand(invocation(gmail, 'yesterday'))).toMatchObject({
      ok: false,
      reason: 'since_invalid',
    });
  });

  it('lists every mailbox with its address and status, read-only', async () => {
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

  it('with --hold-unattached, holds the firm an unattached send could belong to, once, audited, until the send is settled', async () => {
    await world.clearHolds(workspaceId());
    const at = '2026-09-24T20:00:00.000Z';
    const shared = 'second.shared.desk@northwind.example.test';
    const one = await pendingStep(shared);
    const two = await pendingStep(shared);
    const gmail = world.clientWith(world.alpha, { sentMessages: [sentMessage({ header: fssHeader(), to: shared, at })] });
    const holding = { switches: ['--hold-unattached'] };

    const first = await mailboxReconcileSentCommand(invocation(gmail, tenMinutesBefore(at), holding));
    expect(first).toMatchObject({ ok: true, value: { missing_fences_unattached: 1, unresolved: [] } });
    if (!first.ok) return;
    const held = first.value['unattached_held'] as readonly { readonly holdIds: readonly string[] }[];
    expect(held).toHaveLength(1);
    const holdIds = held[0]?.holdIds ?? [];
    expect(holdIds).toHaveLength(1);
    const holdId = holdIds[0] ?? '';
    const session = world.database.session;
    const { rows } = await session.query<{ reason_code: string; scope_kind: string; scope_key: string; source_event_kind: string }>(
      `SELECT reason_code, scope_kind, scope_key, source_event_kind FROM active_holds WHERE workspace_id = $1 AND id = $2 AND released_at IS NULL`,
      [workspaceId(), holdId],
    );
    expect(rows).toEqual([
      { reason_code: 'restore_in_progress', scope_kind: 'firm', scope_key: world.crm.alpha.firmId, source_event_kind: UNATTACHED_SEND_HOLD_SOURCE },
    ]);
    // The opening is audited, with the enrollments the send could have belonged to.
    const opened = await session.query<{ actor_kind: string; detail: { enrollmentIds: string[]; reason: string } }>(
      `SELECT actor_kind, detail FROM audit_events WHERE workspace_id = $1 AND action = 'hold.restore_opened' AND subject_id = $2`,
      [workspaceId(), holdId],
    );
    expect(opened.rows).toEqual([
      {
        actor_kind: 'system',
        detail: expect.objectContaining({ reason: 'several_live_enrollments', enrollmentIds: [one.enrollmentId, two.enrollmentId].sort() }),
      },
    ]);

    const second = await mailboxReconcileSentCommand(invocation(gmail, tenMinutesBefore(at), holding));
    expect(second.ok && (second.value['unattached_held'] as readonly { readonly holdIds: readonly string[] }[])[0]?.holdIds).toEqual(holdIds);
    const openings = await session.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events WHERE workspace_id = $1 AND action = 'hold.restore_opened' AND subject_id = $2`,
      [workspaceId(), holdId],
    );
    expect(openings.rows[0]?.count).toBe('1');

    // Released only by id, with the resolution, and "ended the duplicate" is checked.
    const release = (options: Record<string, string>): AdminInvocation => ({
      ...invocation(gmail, tenMinutesBefore(at)),
      options: { '--note': 'read the Sent message; the second enrollment was a duplicate', ...options },
      launch: LAUNCH,
    });
    const runtime = await world.database.appRuntimeSession();
    const bulk = await holdsReleaseRestoreCommand({ ...release({}), session: runtime });
    expect(bulk).toMatchObject({ ok: true, value: { released: 0, needsResolution: [holdId] } });
    expect(await holdsReleaseRestoreCommand(release({ '--hold': holdId }))).toMatchObject({ ok: false, reason: 'resolution_missing' });
    expect(
      await holdsReleaseRestoreCommand(release({ '--hold': holdId, '--resolution': 'ended-duplicate-enrollment' })),
    ).toMatchObject({ ok: false, reason: 'resolution_unverified' });
    await session.query(
      `UPDATE sequence_enrollments SET state = 'stopped', ended_at = now(), end_reason = 'admin_stop' WHERE workspace_id = $1 AND id = $2`,
      [workspaceId(), two.enrollmentId],
    );
    const done = await holdsReleaseRestoreCommand({
      ...release({ '--hold': holdId, '--resolution': 'ended-duplicate-enrollment' }),
      session: runtime,
    });
    expect(done).toMatchObject({ ok: true, value: { outcome: 'released', released: 1, holds: [expect.objectContaining({ holdId })] } });
    const audit = await session.query<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM audit_events WHERE workspace_id = $1 AND action = 'hold.restore_released' AND subject_id = $2`,
      [workspaceId(), holdId],
    );
    expect(audit.rows).toEqual([
      {
        detail: expect.objectContaining({
          resolution: 'ended-duplicate-enrollment',
          source: UNATTACHED_SEND_HOLD_SOURCE,
          launchedBy: LAUNCH.launchedBy,
          taskArn: LAUNCH.taskArn,
        }),
      },
    ]);
    expect(await holdsReleaseRestoreCommand(release({ '--hold': holdId, '--resolution': 'ended-duplicate-enrollment' }))).toMatchObject({
      ok: true,
      value: { outcome: 'already_released', released: 0, alreadyReleased: [holdId] },
    });
    await world.clearHolds(workspaceId());
  });

  it('reads every in-doubt fence a page at a time: by one over three fences', async () => {
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

  it('reads every in-doubt fence past the default page of 200, never capped', { timeout: 120_000 }, async () => {
    const session = world.database.session;
    const beta = world.beta.workspace.workspaceId;
    const prepared: string[] = [];
    for (let index = 0; index <= RECONCILE_FENCE_PAGE_SIZE; index += 1) prepared.push(await world.prepare(world.beta));
    await session.query(
      `UPDATE outbound_messages SET state = 'dispatching', attempt_token = gen_random_uuid(), dispatch_started_at = now()
        WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
      [beta, prepared],
    );
    expect(RECONCILE_FENCE_PAGE_SIZE).toBe(200);
    const ids = await inDoubtFenceIds(session, { workspaceId: beta, mailboxId: world.beta.mailboxId, since: '2026-01-01T00:00:00Z' });
    expect(ids.length).toBeGreaterThanOrEqual(RECONCILE_FENCE_PAGE_SIZE + 1);
    expect(ids).toEqual(expect.arrayContaining(prepared));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('fss admin holds release-restore and holds list', () => {
  let world: OutboundWorld;

  beforeAll(async () => {
    world = await createOutboundWorld();
  });

  afterAll(async () => {
    await world.stop();
  });

  const invoke = (
    options: Record<string, string>,
    setup: { readonly session?: SessionQueryable; readonly launch?: LaunchIdentity | null } = {},
  ): AdminInvocation => ({
    session: setup.session ?? world.database.session,
    config: readToolConfig({ DATABASE_URL: copyDatabaseUrl }),
    environment: {},
    options,
    switches: new Set(),
    ...(setup.launch === null ? {} : { launch: setup.launch ?? LAUNCH }),
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

  it('refuses without a verified launcher, a note, or a known resolution, and releases nothing', async () => {
    const hold = await openRestoreHold();
    const note = 'left from the g56 generation check; nothing restored since';
    expect(await holdsReleaseRestoreCommand(invoke({ '--note': note }, { launch: null }))).toMatchObject({ ok: false, reason: 'launcher_unknown' });
    for (const launchedBy of [null, 'david', 'arn:aws:iam::123:user/david', `${LAUNCH.launchedBy ?? ''} extra`]) {
      expect(
        await holdsReleaseRestoreCommand(invoke({ '--note': note }, { launch: { launchedBy, taskArn: LAUNCH.taskArn } })),
        String(launchedBy),
      ).toMatchObject({ ok: false, reason: 'launcher_unknown' });
    }
    // The old caller-typed attribution is not an option any more.
    expect(await holdsReleaseRestoreCommand(invoke({ '--note': '  ' }))).toMatchObject({ ok: false, reason: 'note_invalid' });
    expect(await holdsReleaseRestoreCommand(invoke({ '--note': 'x'.repeat(501) }))).toMatchObject({ ok: false, reason: 'note_invalid' });
    expect(await holdsReleaseRestoreCommand(invoke({ '--note': note, '--resolution': 'looked-fine' }))).toMatchObject({
      ok: false,
      reason: 'resolution_unknown',
    });
    expect(await holdsReleaseRestoreCommand(invoke({ '--note': note, '--hold': randomUUID() }))).toMatchObject({ ok: false, reason: 'hold_unknown' });
    const { rows } = await world.database.session.query<{ released_at: Date | null }>(
      'SELECT released_at FROM active_holds WHERE workspace_id = $1 AND id = $2',
      [world.alpha.workspace.workspaceId, hold],
    );
    expect(rows[0]?.released_at).toBeNull();
  });

  it('releases the restore holds from before, attributed to the launcher, with an audit row each, and no hold of another reason', async () => {
    await world.clearHolds(world.alpha.workspace.workspaceId);
    const hold = await openRestoreHold();
    const other = await world.database.session.query<{ id: string }>(
      `INSERT INTO active_holds (workspace_id, scope_kind, reason_code, blocked_action_kinds, source_event_kind)
       VALUES ($1, 'workspace', 'long_hold_review', ARRAY['email_send']::text[], 'fixture') RETURNING id`,
      [world.alpha.workspace.workspaceId],
    );
    const note = 'checked: opened by the generation check before W3-S8, nothing restored';
    // As the operations task runs it: the runtime role, with its own privileges (it may
    // insert into audit_events and never update it).
    const runtime = await world.database.appRuntimeSession();
    const outcome = await holdsReleaseRestoreCommand(invoke({ '--note': note }, { session: runtime }));
    expect(outcome).toMatchObject({
      ok: true,
      value: { outcome: 'released', released: 1, holds: [expect.objectContaining({ holdId: hold })], otherHoldsStillOpen: 1, launchedBy: LAUNCH.launchedBy },
    });

    const audit = await world.database.session.query<{ actor_kind: string; actor_user_id: string | null; action: string; subject_id: string; detail: Record<string, unknown> }>(
      `SELECT actor_kind, actor_user_id, action, subject_id, detail FROM audit_events WHERE workspace_id = $1 AND action = 'hold.restore_released'`,
      [world.alpha.workspace.workspaceId],
    );
    expect(audit.rows).toEqual([
      {
        actor_kind: 'system',
        actor_user_id: null,
        action: 'hold.restore_released',
        subject_id: hold,
        detail: expect.objectContaining({ note, launchedBy: LAUNCH.launchedBy, taskArn: LAUNCH.taskArn, source: 'restore.generation_mismatch' }),
      },
    ]);
    const still = await world.database.session.query<{ released_at: Date | null }>(
      'SELECT released_at FROM active_holds WHERE workspace_id = $1 AND id = $2',
      [world.alpha.workspace.workspaceId, other.rows[0]?.id],
    );
    expect(still.rows[0]?.released_at).toBeNull();

    // Twice is once: nothing is left to release, and nothing is audited again; a named
    // rerun says the hold is already released rather than that it does not exist.
    expect(await holdsReleaseRestoreCommand(invoke({ '--note': note }))).toMatchObject({
      ok: true,
      value: { outcome: 'nothing_to_release', released: 0 },
    });
    expect(await holdsReleaseRestoreCommand(invoke({ '--note': note, '--hold': hold }))).toMatchObject({
      ok: true,
      value: { outcome: 'already_released', released: 0, alreadyReleased: [hold] },
    });
    const count = await world.database.session.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events WHERE workspace_id = $1 AND action = 'hold.restore_released'`,
      [world.alpha.workspace.workspaceId],
    );
    expect(count.rows[0]?.count).toBe('1');
    // The other reason's hold is not a restore hold, released or not.
    expect(await holdsReleaseRestoreCommand(invoke({ '--note': note, '--hold': other.rows[0]?.id ?? '' }))).toMatchObject({
      ok: false,
      reason: 'hold_unknown',
    });
  });

  it('lists holds by a known reason only, and refuses a reason that is not one', async () => {
    expect(await holdsListCommand(invoke({ '--reason': 'restore_in_progress' }))).toMatchObject({ ok: true, value: { reason: 'restore_in_progress' } });
    for (const options of [{ '--reason': 'restore-in-progress' }, { '--reason': 'RESTORE_IN_PROGRESS' }, { '--exclude-reason': 'restored' }]) {
      expect(await holdsListCommand(invoke(options)), JSON.stringify(options)).toMatchObject({ ok: false, reason: 'reason_unknown' });
    }
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
