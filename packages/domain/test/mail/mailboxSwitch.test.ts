import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionQueryable } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import type { EnvelopeCipher } from '../../mail/envelope.ts';
import type { GmailClient } from '../../mail/gmailClient.ts';
import type { RecordedGmailClient } from '../../mail/gmailClientFake.ts';
import { lockMailboxAtFence, openMailboxHold, readMailbox, readMailboxHold, StaleMailboxGeneration } from '../../mail/mailboxes.ts';
import { readAttachmentReferences } from '../../retention/attachments.ts';
import {
  beginGmailGrant,
  completeGmailGrant,
  verifyGrantState,
  type MailGrantDeps,
} from '../../mail/oauth.ts';
import { staticSecretProvider } from '../../mail/secretProvider.ts';
import { readRefreshToken } from '../../mail/tokens.ts';
import { listWatchesDue } from '../../mail/watch.ts';
import { lockSendGateForStopFact } from '../../policy/sendGate.ts';
import { makeStepExecution } from '../../db/testing/stepExecutions.ts';
import { applyDirectSendEffects } from '../../mail/effects.ts';
import { readMessage } from '../../mail/messages.ts';
import { dispatchOutboundMessage } from '../../outbound/send.ts';
import { createOutboundWorld, type OutboundWorld } from '../outbound/support/outboundWorld.ts';
import { openExtraSession, prepareFor, seedFirm, waitUntilBlocked, type ExtraSession } from '../outbound/support/dispatchFixtures.ts';

/**
 * Switching the sales mailbox to another Google account in place (call-to-booking A2).
 *
 * The outbound world's alpha mailbox is the old account (`sales.alpha@example.test`),
 * connected, covered and with a sending history. The new account is a second Gmail
 * fixture with its own address, history id and refresh token. Every refusal case
 * snapshots the rows a grant can touch and asserts they did not move, so "nothing
 * changes" is measured, not assumed.
 *
 * No real person or address: `example.test` throughout (RFC 6761).
 */

const NEW_ADDRESS = 'david.alpha@example.test';
const NEW_HISTORY_ID = '5000';

let world: OutboundWorld;
let extras: ExtraSession[] = [];
const stateSigningKey = randomBytes(32);
const secretValue = randomBytes(24).toString('base64url');

beforeEach(async () => {
  world = await createOutboundWorld();
  extras = [];
  // The old account's current watch, registered an hour ago: a switch must cancel it.
  await world.database.session.query(
    `INSERT INTO mailbox_watches (workspace_id, mailbox_id, generation, topic_name, provider_history_id,
                                  registered_at, expires_at)
     VALUES ($1, $2, 1, 'projects/callie-fss/topics/fss-test-gmail-push', '1000',
             now() - interval '1 hour', now() + interval '6 days')`,
    [workspaceId(), world.alpha.mailboxId],
  );
}, 180_000);

afterEach(async () => {
  for (const extra of extras) await extra.close();
  await world?.stop();
});

const workspaceId = (): string => world.alpha.workspace.workspaceId;
const ownerId = (): string => world.alpha.workspace.salesperson.userId;
const userOn = (session: SessionQueryable, userId: string = ownerId(), role: 'salesperson' | 'admin' = 'salesperson'): RepositoryContext =>
  repositoryContext(workspaceScope(workspaceId(), { kind: 'user', userId, role }), session);
const owner = (): RepositoryContext => userOn(world.database.session);

/** A Gmail fixture for the account the consent screen returns, and the token it hands back. */
function account(
  emailAddress: string,
  extra: { readonly historyId?: string } = {},
): RecordedGmailClient & { readonly refreshToken: string } {
  const refreshToken = randomBytes(24).toString('base64url');
  const client = world.clientWith(world.alpha, {
    emailAddress,
    historyId: extra.historyId ?? NEW_HISTORY_ID,
    refreshToken,
  });
  return Object.assign(client, { refreshToken });
}

function grantDeps(gmail: GmailClient, overrides: Partial<MailGrantDeps> = {}): MailGrantDeps {
  return {
    gmail,
    config: world.config,
    secrets: staticSecretProvider({ gmail_oauth_client_secret: secretValue }),
    cipher: world.cipher,
    stateSigningKey,
    ...overrides,
  };
}

async function begin(
  switchTo: string | undefined,
  context: RepositoryContext = owner(),
): Promise<{ readonly state: string; readonly url: URL; readonly attemptId: string }> {
  const started = await beginGmailGrant(context, grantDeps(account(NEW_ADDRESS)), switchTo === undefined ? {} : { switchTo });
  if (!started.ok) throw new Error(`the grant did not begin: ${started.reason}`);
  const url = new URL(started.value.authorizationUrl);
  return { state: url.searchParams.get('state') ?? '', url, attemptId: started.value.attemptId };
}

interface Snapshot {
  readonly mailbox: unknown;
  readonly token: unknown;
  readonly watches: unknown;
  readonly holds: unknown;
  readonly recoveries: unknown;
  readonly accounts: unknown;
  readonly audits: unknown;
}

/** Every row a grant can write, other than its own refusal audit. */
async function snapshot(): Promise<Snapshot> {
  const session = world.database.session;
  const q = async (sql: string): Promise<unknown> =>
    (await session.query(sql, [workspaceId(), world.alpha.mailboxId])).rows;
  return {
    mailbox: await q('SELECT * FROM mailboxes WHERE workspace_id = $1 AND id = $2'),
    token: await q('SELECT ciphertext, iv, rotated_at FROM mailbox_tokens WHERE workspace_id = $1 AND mailbox_id = $2'),
    watches: await q('SELECT * FROM mailbox_watches WHERE workspace_id = $1 AND mailbox_id = $2 ORDER BY generation'),
    holds: await q(
      "SELECT id, reason_code, released_at FROM active_holds WHERE workspace_id = $1 AND source_event_id = $2::text ORDER BY id",
    ),
    recoveries: await q('SELECT * FROM mailbox_recoveries WHERE workspace_id = $1 AND mailbox_id = $2 ORDER BY generation'),
    accounts: await q('SELECT * FROM mailbox_accounts WHERE workspace_id = $1 AND mailbox_id = $2'),
    audits: await q(
      "SELECT action FROM audit_events WHERE workspace_id = $1 AND subject_id = $2::text AND action LIKE 'mailbox.%' ORDER BY occurred_at, id",
    ),
  };
}

async function refusals(): Promise<readonly { readonly reason: string; readonly attemptId: string | null }[]> {
  const { rows } = await world.database.session.query<{ reason: string; attempt_id: string | null }>(
    `SELECT detail->>'reason' AS reason, detail->>'attemptId' AS attempt_id FROM audit_events
      WHERE workspace_id = $1 AND action = 'mailbox.grant_refused' AND actor_user_id = $2
      ORDER BY occurred_at, id`,
    [workspaceId(), ownerId()],
  );
  return rows.map(row => ({ reason: row.reason, attemptId: row.attempt_id }));
}

async function mailboxRow(): Promise<{
  email_address: string;
  generation: number;
  sync_state: string;
  history_id: string | null;
  coverage_watermark_at: Date | null;
  last_synced_at: Date | null;
  created_at: Date;
}> {
  const { rows } = await world.database.session.query<{
    email_address: string;
    generation: number;
    sync_state: string;
    history_id: string | null;
    coverage_watermark_at: Date | null;
    last_synced_at: Date | null;
    created_at: Date;
  }>(
    `SELECT email_address, generation, sync_state, history_id, coverage_watermark_at, last_synced_at, created_at
       FROM mailboxes WHERE workspace_id = $1 AND id = $2`,
    [workspaceId(), world.alpha.mailboxId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('the mailbox is gone');
  return row;
}

async function countWhere(table: string, column = 'mailbox_id'): Promise<number> {
  const { rows } = await world.database.session.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${table} WHERE workspace_id = $1 AND ${column} = $2`,
    [workspaceId(), world.alpha.mailboxId],
  );
  return Number(rows[0]?.count ?? 0);
}

describe('beginning a switch', () => {
  it('signs the intent and an attempt id into the state and hints the account to Google', async () => {
    const started = await begin(NEW_ADDRESS.toUpperCase());
    expect(started.url.searchParams.get('login_hint')).toBe(NEW_ADDRESS);
    const claims = verifyGrantState(stateSigningKey, started.state, Math.floor(Date.now() / 1000));
    expect(claims?.switchTo).toBe(NEW_ADDRESS);
    expect(claims?.attemptId).toBe(started.attemptId);
  });

  it('carries an attempt id and no hint without switchTo', async () => {
    const started = await begin(undefined);
    expect(started.url.searchParams.has('login_hint')).toBe(false);
    const claims = verifyGrantState(stateSigningKey, started.state, Math.floor(Date.now() / 1000));
    expect(claims?.switchTo).toBeUndefined();
    expect(claims?.attemptId).toBe(started.attemptId);
  });

  it('refuses the same address, another domain, and a mailbox with a fence still pending', async () => {
    const deps = grantDeps(account(NEW_ADDRESS));
    expect(await beginGmailGrant(owner(), deps, { switchTo: world.alpha.address })).toEqual({
      ok: false,
      reason: 'mailbox_switch_same_address',
    });
    expect(await beginGmailGrant(owner(), deps, { switchTo: 'david@elsewhere.example' })).toEqual({
      ok: false,
      reason: 'mailbox_switch_wrong_domain',
    });
    await prepareFor(world, world.alpha, await seedFirm(world, world.alpha, 'pending-at-begin'));
    expect(await beginGmailGrant(owner(), deps, { switchTo: NEW_ADDRESS })).toEqual({
      ok: false,
      reason: 'mailbox_switch_pending_sends',
    });
  });

  it('is a plain connect for an owner with no mailbox: no intent in the state', async () => {
    const admin = userOn(world.database.session, world.alpha.workspace.admin.userId, 'admin');
    const started = await begin(NEW_ADDRESS, admin);
    const claims = verifyGrantState(stateSigningKey, started.state, Math.floor(Date.now() / 1000));
    expect(claims?.switchTo).toBeUndefined();
    expect(started.url.searchParams.get('login_hint')).toBe(NEW_ADDRESS);
  });
});

describe('completing a switch', () => {
  it('moves the row to the new account and keeps its id, history, fences, ramp and suppressions', async () => {
    // A sending history on the old account: one sent fence and its send day.
    const firm = await seedFirm(world, world.alpha, 'history');
    const sentFence = await prepareFor(world, world.alpha, firm);
    const sent = await dispatchOutboundMessage(world.systemContext(workspaceId()), world.sendDeps(world.alpha), {
      outboundMessageId: sentFence,
    });
    expect(sent.outcome).toBe('sent');
    await world.database.session.query(
      `INSERT INTO mail_messages (workspace_id, mailbox_id, provider_message_id, provider_thread_id, direction,
                                  internal_date, header_from, matched)
       VALUES ($1, $2, 'old-account-1', 'old-thread-1', 'incoming', now() - interval '1 day', $3, false)`,
      [workspaceId(), world.alpha.mailboxId, firm.address],
    );
    await world.database.session.query(
      `INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source)
       VALUES ($1, 'switch-optout', 'handle', $2, 'v1', 'prospect_opt_out')`,
      [workspaceId(), firm.address],
    );
    const before = {
      messages: await countWhere('mail_messages'),
      fences: await countWhere('outbound_messages'),
      days: await countWhere('mailbox_send_days'),
      ramp: await countWhere('mailbox_send_ramp'),
      row: await mailboxRow(),
    };
    const { rows: suppressionsBefore } = await world.database.session.query(
      'SELECT * FROM effective_suppressions WHERE workspace_id = $1 ORDER BY canonical_key',
      [workspaceId()],
    );
    expect(before.fences).toBe(1);
    expect(before.days).toBeGreaterThan(0);

    const started = await begin(NEW_ADDRESS);
    const gmail = account(NEW_ADDRESS);
    const done = await completeGmailGrant(owner(), grantDeps(gmail), { state: started.state, code: 'switch-code' });
    expect(done).toMatchObject({
      ok: true,
      value: { mailboxId: world.alpha.mailboxId, emailAddress: NEW_ADDRESS, switched: true, oldWatchStopped: true },
    });

    const after = await mailboxRow();
    expect(after.email_address).toBe(NEW_ADDRESS);
    expect(after.generation).toBe(before.row.generation + 1);
    expect(after.sync_state).toBe('baseline_pending');
    // The old account's cursor and watermark are gone; the cursor is the new account's.
    expect(after.history_id).toBe(NEW_HISTORY_ID);
    expect(after.coverage_watermark_at).toBeNull();
    expect(after.last_synced_at).toBeNull();

    expect(await countWhere('mail_messages')).toBe(before.messages);
    expect(await countWhere('outbound_messages')).toBe(before.fences);
    expect(await countWhere('mailbox_send_days')).toBe(before.days);
    expect(await countWhere('mailbox_send_ramp')).toBe(before.ramp);
    const { rows: suppressionsAfter } = await world.database.session.query(
      'SELECT * FROM effective_suppressions WHERE workspace_id = $1 ORDER BY canonical_key',
      [workspaceId()],
    );
    expect(suppressionsAfter).toEqual(suppressionsBefore);

    // The account intervals: the old one closed from the row's creation, the new one open.
    const { rows: accounts } = await world.database.session.query<{
      email_address: string;
      active_from: Date;
      active_until: Date | null;
      generation_from: number;
    }>(
      `SELECT email_address, active_from, active_until, generation_from FROM mailbox_accounts
        WHERE workspace_id = $1 AND mailbox_id = $2 ORDER BY active_from`,
      [workspaceId(), world.alpha.mailboxId],
    );
    expect(accounts.map(row => [row.email_address, row.active_until === null, row.generation_from])).toEqual([
      [world.alpha.address, false, 1],
      [NEW_ADDRESS, true, after.generation],
    ]);
    expect(accounts[0]?.active_from.toISOString()).toBe(before.row.created_at.toISOString());
    expect(accounts[0]?.active_until?.toISOString()).toBe(accounts[1]?.active_from.toISOString());

    // The new account's token replaced the old one.
    expect(await readRefreshToken(owner(), { mailboxId: world.alpha.mailboxId, cipher: world.cipher })).toBe(
      gmail.refreshToken,
    );
    // The old watch was stopped with the old token and its row cancelled; the mailbox is due.
    expect(gmail.calls.map(call => call.method)).toEqual([
      'exchangeAuthorizationCode',
      'getProfile',
      'refreshAccessToken',
      'stopWatch',
    ]);
    const { rows: watches } = await world.database.session.query<{ cancelled_reason: string | null }>(
      'SELECT cancelled_reason FROM mailbox_watches WHERE workspace_id = $1 AND mailbox_id = $2',
      [workspaceId(), world.alpha.mailboxId],
    );
    expect(watches).toEqual([{ cancelled_reason: 'mailbox_switched' }]);
    const due = await listWatchesDue(world.database.session, new Date().toISOString());
    expect(due.map(row => row.mailboxId)).toContain(world.alpha.mailboxId);

    // Held until the new baseline proves coverage, and the baseline is the new generation's.
    expect(await readMailboxHold(owner(), world.alpha.mailboxId, 'coverage_incomplete')).not.toBeNull();
    expect(await countWhere('mailbox_recoveries')).toBe(2);

    const { rows: audit } = await world.database.session.query<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM audit_events WHERE workspace_id = $1 AND action = 'mailbox.switched' AND subject_id = $2`,
      [workspaceId(), world.alpha.mailboxId],
    );
    expect(audit.map(row => row.detail)).toEqual([
      { from: world.alpha.address, to: NEW_ADDRESS, attemptId: started.attemptId, switchedAt: expect.any(String) as string },
    ]);
    // The stop, after the commit, recorded on its own row.
    const { rows: stopped } = await world.database.session.query<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM audit_events WHERE workspace_id = $1 AND action = 'mailbox.switch_old_watch' AND subject_id = $2`,
      [workspaceId(), world.alpha.mailboxId],
    );
    expect(stopped.map(row => row.detail)).toEqual([{ attemptId: started.attemptId, oldWatchStopped: true }]);
  });

  it('stops the old watch with the OLD token, after the commit', async () => {
    const oldToken = await readRefreshToken(owner(), { mailboxId: world.alpha.mailboxId, cipher: world.cipher });
    const started = await begin(NEW_ADDRESS);
    const gmail = account(NEW_ADDRESS);
    const refreshedWith: string[] = [];
    let committedAtStop: string | null = null;
    const watching: GmailClient = {
      ...gmail,
      refreshAccessToken: async (...args: Parameters<GmailClient['refreshAccessToken']>) => {
        refreshedWith.push(args[1]);
        return await gmail.refreshAccessToken(...args);
      },
      stopWatch: async (...args: Parameters<GmailClient['stopWatch']>) => {
        // Read on another connection: only a committed switch is visible there.
        const probe = await openExtraSession(world);
        extras.push(probe);
        const { rows } = await probe.session.query<{ email_address: string }>(
          'SELECT email_address FROM mailboxes WHERE workspace_id = $1 AND id = $2',
          [workspaceId(), world.alpha.mailboxId],
        );
        committedAtStop = rows[0]?.email_address ?? null;
        await gmail.stopWatch(...args);
      },
    };
    const done = await completeGmailGrant(owner(), grantDeps(watching), { state: started.state, code: 'switch-code' });
    expect(done).toMatchObject({ ok: true, value: { switched: true, oldWatchStopped: true } });
    expect(refreshedWith).toEqual([oldToken]);
    expect(committedAtStop).toBe(NEW_ADDRESS);
  });

  it('switches when users.stop fails, and records that it did', async () => {
    const started = await begin(NEW_ADDRESS);
    const gmail = account(NEW_ADDRESS);
    const failing: GmailClient = {
      ...gmail,
      stopWatch: async () => {
        await Promise.resolve();
        throw new Error('the fixture users.stop failed');
      },
    };
    const done = await completeGmailGrant(owner(), grantDeps(failing), { state: started.state, code: 'switch-code' });
    expect(done).toMatchObject({ ok: true, value: { switched: true, oldWatchStopped: false } });
    const { rows } = await world.database.session.query<{ stopped: boolean }>(
      `SELECT (detail->>'oldWatchStopped')::boolean AS stopped FROM audit_events
        WHERE workspace_id = $1 AND action = 'mailbox.switch_old_watch'`,
      [workspaceId()],
    );
    expect(rows).toEqual([{ stopped: false }]);
    expect((await mailboxRow()).email_address).toBe(NEW_ADDRESS);
  });

  it('refuses another account without intent: mailbox_switch_not_requested, and nothing changes', async () => {
    const started = await begin(undefined);
    const before = await snapshot();
    const done = await completeGmailGrant(owner(), grantDeps(account(NEW_ADDRESS)), {
      state: started.state,
      code: 'silent-switch',
    });
    expect(done).toEqual({ ok: false, reason: 'mailbox_switch_not_requested' });
    expect(await snapshot()).toEqual(before);
    expect(await refusals()).toEqual([{ reason: 'mailbox_switch_not_requested', attemptId: started.attemptId }]);
  });

  it('refuses an intent completed by a different account: mailbox_switch_address_mismatch, and nothing changes', async () => {
    const started = await begin(NEW_ADDRESS);
    const before = await snapshot();
    const done = await completeGmailGrant(owner(), grantDeps(account('someone.else@example.test')), {
      state: started.state,
      code: 'wrong-account',
    });
    expect(done).toEqual({ ok: false, reason: 'mailbox_switch_address_mismatch' });
    expect(await snapshot()).toEqual(before);
    expect(await refusals()).toEqual([{ reason: 'mailbox_switch_address_mismatch', attemptId: started.attemptId }]);
  });

  it('refuses a fence prepared after the switch began, inside the transaction, and rolls back', async () => {
    const started = await begin(NEW_ADDRESS);
    await prepareFor(world, world.alpha, await seedFirm(world, world.alpha, 'pending-at-callback'));
    const before = await snapshot();
    const gmail = account(NEW_ADDRESS);
    const done = await completeGmailGrant(owner(), grantDeps(gmail), { state: started.state, code: 'late-fence' });
    expect(done).toEqual({ ok: false, reason: 'mailbox_switch_pending_sends' });
    // Nothing moved here, and nothing at Google either: the old watch is stopped only
    // after a switch commits (review finding 6).
    expect(await snapshot()).toEqual(before);
    expect(gmail.calls.map(call => call.method)).not.toContain('stopWatch');
    expect(await refusals()).toEqual([{ reason: 'mailbox_switch_pending_sends', attemptId: started.attemptId }]);
  });

  it('refuses the second of two switch attempts to the same account: mailbox_switch_same_address, nothing changes', async () => {
    const first = await begin(NEW_ADDRESS);
    const second = await begin(NEW_ADDRESS);
    expect((await completeGmailGrant(owner(), grantDeps(account(NEW_ADDRESS)), { state: first.state, code: 'first' })).ok).toBe(true);
    const before = await snapshot();
    const gmail = account(NEW_ADDRESS);
    const done = await completeGmailGrant(owner(), grantDeps(gmail), { state: second.state, code: 'second' });
    expect(done).toEqual({ ok: false, reason: 'mailbox_switch_same_address' });
    expect(await snapshot()).toEqual(before);
    expect(gmail.calls.map(call => call.method)).not.toContain('stopWatch');
    expect(await refusals()).toEqual([{ reason: 'mailbox_switch_same_address', attemptId: second.attemptId }]);
    // A plain re-consent of the same account, without intent, is still accepted.
    const plain = await begin(undefined);
    expect(
      (await completeGmailGrant(owner(), grantDeps(account(NEW_ADDRESS)), { state: plain.state, code: 'plain' })).ok,
    ).toBe(true);
  });

  it('commits nothing when token storage fails: the old address, token and cursor stay', async () => {
    const started = await begin(NEW_ADDRESS);
    const oldToken = await readRefreshToken(owner(), { mailboxId: world.alpha.mailboxId, cipher: world.cipher });
    const before = await snapshot();
    const broken: EnvelopeCipher = {
      ...world.cipher,
      encrypt: async () => {
        await Promise.resolve();
        throw new Error('the fixture envelope key is unavailable');
      },
    };
    await expect(
      completeGmailGrant(owner(), grantDeps(account(NEW_ADDRESS), { cipher: broken }), {
        state: started.state,
        code: 'broken-cipher',
      }),
    ).rejects.toThrow('the fixture envelope key is unavailable');
    expect(await snapshot()).toEqual(before);
    const row = await mailboxRow();
    expect(row.email_address).toBe(world.alpha.address);
    expect(row.history_id).not.toBeNull();
    expect(await readRefreshToken(owner(), { mailboxId: world.alpha.mailboxId, cipher: world.cipher })).toBe(oldToken);
  });

  it('releases a mailbox_disconnected hold on a switch', async () => {
    await openMailboxHold(owner(), { mailboxId: world.alpha.mailboxId, ownerUserId: ownerId(), reasonCode: 'mailbox_disconnected' });
    const started = await begin(NEW_ADDRESS);
    const done = await completeGmailGrant(owner(), grantDeps(account(NEW_ADDRESS)), { state: started.state, code: 'switch' });
    expect(done.ok).toBe(true);
    expect(await readMailboxHold(owner(), world.alpha.mailboxId, 'mailbox_disconnected')).toBeNull();
  });
});

describe('a same-address re-consent', () => {
  it('behaves as before: no reset, no account intervals, no cancelled watch; and it releases mailbox_disconnected', async () => {
    await openMailboxHold(owner(), { mailboxId: world.alpha.mailboxId, ownerUserId: ownerId(), reasonCode: 'mailbox_disconnected' });
    const before = await mailboxRow();
    const started = await begin(undefined);
    const gmail = account(world.alpha.address, { historyId: '1234' });
    const done = await completeGmailGrant(owner(), grantDeps(gmail), { state: started.state, code: 'reconsent' });
    expect(done).toMatchObject({ ok: true, value: { switched: false, oldWatchStopped: null } });
    const after = await mailboxRow();
    expect(after.email_address).toBe(world.alpha.address);
    expect(after.generation).toBe(before.generation + 1);
    expect(after.sync_state).toBe('baseline_pending');
    // Not reset: the watermark and the last sync survive a re-consent, as before A2.
    expect(after.coverage_watermark_at?.toISOString()).toBe(before.coverage_watermark_at?.toISOString());
    expect(await countWhere('mailbox_accounts')).toBe(0);
    expect(gmail.calls.map(call => call.method)).not.toContain('stopWatch');
    const { rows: watches } = await world.database.session.query<{ cancelled_at: Date | null }>(
      'SELECT cancelled_at FROM mailbox_watches WHERE workspace_id = $1 AND mailbox_id = $2',
      [workspaceId(), world.alpha.mailboxId],
    );
    expect(watches).toEqual([{ cancelled_at: null }]);
    const { rows: audits } = await world.database.session.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE workspace_id = $1 AND subject_id = $2 AND action LIKE 'mailbox.%'
        ORDER BY occurred_at, id`,
      [workspaceId(), world.alpha.mailboxId],
    );
    expect(audits.map(row => row.action)).toEqual(['mailbox.connected', 'mailbox.connected']);
    expect(await readMailboxHold(owner(), world.alpha.mailboxId, 'mailbox_disconnected')).toBeNull();
  });
});

describe('the switch transaction takes the send gate, then the mailbox row', () => {
  async function extra(): Promise<ExtraSession> {
    const opened = await openExtraSession(world);
    extras.push(opened);
    return opened;
  }

  it('waits on the gate holding no mailbox row lock', async () => {
    const holder = await extra();
    const grantSession = await extra();
    const probe = await extra();
    const started = await begin(NEW_ADDRESS);
    await holder.session.query('BEGIN');
    await lockSendGateForStopFact(holder.context(workspaceId()));

    const pending = completeGmailGrant(userOn(grantSession.session), grantDeps(account(NEW_ADDRESS)), {
      state: started.state,
      code: 'gate-first',
    });
    await waitUntilBlocked(world.database.session, grantSession.pid, 'advisory');
    // Blocked by the gate's holder, and the mailbox row is free: nothing was locked first.
    const { rows: blockers } = await world.database.session.query<{ blocked: boolean }>(
      'SELECT $1::int = ANY (pg_blocking_pids($2)) AS blocked',
      [holder.pid, grantSession.pid],
    );
    expect(blockers).toEqual([{ blocked: true }]);
    await probe.session.query('BEGIN');
    const free = await probe.session.query('SELECT id FROM mailboxes WHERE workspace_id = $1 AND id = $2 FOR UPDATE NOWAIT', [
      workspaceId(),
      world.alpha.mailboxId,
    ]);
    expect(free.rows).toHaveLength(1);
    await probe.session.query('ROLLBACK');

    await holder.session.query('ROLLBACK');
    expect((await pending).ok).toBe(true);
  });

  it('does not deadlock with an import holding KEY SHARE on the row that then waits for the gate', async () => {
    const importer = await extra();
    const grantSession = await extra();
    const started = await begin(NEW_ADDRESS);
    const importContext = importer.context(workspaceId());
    const fenceBefore = await readMailbox(importContext, world.alpha.mailboxId);
    if (fenceBefore === null) throw new Error('no mailbox');
    // The import's shape: a message row first (the foreign key takes KEY SHARE on the
    // mailbox), then the send gate for a direct send's effects.
    await importer.session.query('BEGIN');
    await importer.session.query(
      `INSERT INTO mail_messages (workspace_id, mailbox_id, provider_message_id, provider_thread_id, direction,
                                  internal_date, matched)
       VALUES ($1, $2, 'import-in-flight', 'import-in-flight', 'outgoing', now(), false)`,
      [workspaceId(), world.alpha.mailboxId],
    );
    let grantError: unknown = null;
    const grant = completeGmailGrant(userOn(grantSession.session), grantDeps(account(NEW_ADDRESS)), {
      state: started.state,
      code: 'deadlock-probe',
    }).catch((error: unknown) => {
      grantError = error;
      return null;
    });
    // The callback is running: give it the gate first, the ordering that deadlocked.
    await new Promise(resolve => setTimeout(resolve, 150));
    // The import now takes the gate and makes its fenced write, then commits.
    await lockSendGateForStopFact(importContext);
    await lockMailboxAtFence(importContext, {
      mailboxId: world.alpha.mailboxId,
      fence: { generation: fenceBefore.generation, emailAddress: fenceBefore.emailAddress },
      write: 'direct send',
    });
    await importer.session.query('COMMIT');
    const outcome = await grant;
    // No deadlock: nobody was aborted with 40P01. The import, which held its row lock
    // first, committed against the old account; the callback then switched.
    expect((grantError as { code?: string } | null)?.code).toBeUndefined();
    expect(outcome?.ok).toBe(true);
    const { rows } = await world.database.session.query<{ link: string | null }>(
      "SELECT id AS link FROM mail_messages WHERE workspace_id = $1 AND provider_message_id = 'import-in-flight'",
      [workspaceId()],
    );
    const link = await readAttachmentReferences(owner(), { mailMessageId: rows[0]?.link ?? '' });
    expect(link.value?.openInGmailUrl).toContain(encodeURIComponent(world.alpha.address));
    // And an import that read the old account and writes after the switch fails stale.
    const late = await extra();
    await late.session.query('BEGIN');
    await expect(
      lockMailboxAtFence(late.context(workspaceId()), {
        mailboxId: world.alpha.mailboxId,
        fence: { generation: fenceBefore.generation, emailAddress: fenceBefore.emailAddress },
        write: 'direct send',
      }),
    ).rejects.toBeInstanceOf(StaleMailboxGeneration);
    await late.session.query('ROLLBACK');
  });

  it('dates the switch from when it holds its locks: a sync committed during the wait stays the old account’s', async () => {
    const holder = await extra();
    const grantSession = await extra();
    const started = await begin(NEW_ADDRESS);
    await holder.session.query('BEGIN');
    await lockSendGateForStopFact(holder.context(workspaceId()));
    const pending = completeGmailGrant(userOn(grantSession.session), grantDeps(account(NEW_ADDRESS)), {
      state: started.state,
      code: 'waited',
    });
    await waitUntilBlocked(world.database.session, grantSession.pid, 'advisory');
    // While the callback waits: the old account's sync records a message and commits,
    // and the new account's Gmail dates a Sent item.
    const { rows: recorded } = await world.database.session.query<{ id: string; at: string }>(
      `INSERT INTO mail_messages (workspace_id, mailbox_id, provider_message_id, provider_thread_id, direction,
                                  internal_date, matched)
       VALUES ($1, $2, 'old-during-wait', 'old-during-wait', 'incoming', now(), false)
       RETURNING id, clock_timestamp()::text AS at`,
      [workspaceId(), world.alpha.mailboxId],
    );
    const duringWait = recorded[0]?.at ?? '';
    await holder.session.query('ROLLBACK');
    expect((await pending).ok).toBe(true);

    const link = await readAttachmentReferences(owner(), { mailMessageId: recorded[0]?.id ?? '' });
    expect(link.value?.openInGmailUrl).toContain(encodeURIComponent(world.alpha.address));

    const firm = await seedFirm(world, world.alpha, 'wait-sent');
    const { rows: sentRows } = await world.database.session.query<{ id: string }>(
      `INSERT INTO mail_messages (workspace_id, mailbox_id, provider_message_id, provider_thread_id, direction,
                                  internal_date, header_from, header_to, matched)
       VALUES ($1, $2, 'new-sent-during-wait', 'new-sent-during-wait', 'outgoing', $3::timestamptz, $4, $5::text[], true)
       RETURNING id`,
      [workspaceId(), world.alpha.mailboxId, duringWait, NEW_ADDRESS, [firm.address]],
    );
    const message = await readMessage(world.systemContext(workspaceId()), sentRows[0]?.id ?? '');
    if (message === null) throw new Error('not stored');
    const effect = await applyDirectSendEffects(world.systemContext(workspaceId()), {
      message,
      candidate: { firmId: firm.firmId, opportunityId: firm.opportunityId, contactId: firm.contactId, rule: 'participant', viaClosedOpportunity: false },
    });
    expect(effect.recorded).toBe(false);
  });

  it('never holds the gate while it waits for the row: it retries until the row is free', async () => {
    const holder = await extra();
    const grantSession = await extra();
    const probe = await extra();
    const started = await begin(NEW_ADDRESS);
    await holder.session.query('BEGIN');
    await holder.session.query('SELECT id FROM mailboxes WHERE workspace_id = $1 AND id = $2 FOR KEY SHARE', [
      workspaceId(),
      world.alpha.mailboxId,
    ]);
    let settled = false;
    const pending = completeGmailGrant(userOn(grantSession.session), grantDeps(account(NEW_ADDRESS)), {
      state: started.state,
      code: 'row-busy',
    }).finally(() => {
      settled = true;
    });
    // While the row is held, the gate is repeatedly free: a stop fact can take it.
    await new Promise(resolve => setTimeout(resolve, 300));
    // (A retry holds it for a few milliseconds each time, so a probe that lands in one of
    // those is asked again.)
    let taken = false;
    for (let attempt = 0; attempt < 20 && !taken; attempt += 1) {
      await probe.session.query('BEGIN');
      const { rows: gate } = await probe.session.query<{ taken: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended('fss.send-gate:' || $1, 0)) AS taken",
        [workspaceId()],
      );
      await probe.session.query('ROLLBACK');
      taken = gate[0]?.taken === true;
      if (!taken) await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(taken).toBe(true);
    expect(settled).toBe(false);

    await holder.session.query('ROLLBACK');
    expect((await pending).ok).toBe(true);
  });

});

/**
 * The direct-send boundaries (A2, design 5). A message is a direct send only if it was
 * sent (Gmail internal date) at or after the current account's `active_from`; it
 * consumes a permission only if sent at or after the permission's creation, and ends an
 * enrollment only if sent at or after the enrollment's creation. Every case calls the
 * real `applyDirectSendEffects` on a stored outgoing message, as the import does.
 */
describe('direct-send boundaries', () => {
  interface Work {
    readonly firmId: string;
    readonly opportunityId: string;
    readonly prospecting: { readonly enrollmentId: string; readonly address: string; readonly contactId: string };
    readonly followUp: {
      readonly enrollmentId: string;
      readonly address: string;
      readonly contactId: string;
      readonly permissionId: string;
    };
  }

  const worker = (): RepositoryContext => world.systemContext(workspaceId());

  async function enrollment(firmId: string, opportunityId: string, originKind: 'prospecting' | 'follow_up') {
    const executionId = await makeStepExecution(world.database.session, {
      workspaceId: workspaceId(),
      firmId,
      opportunityId,
      userId: ownerId(),
      templateVersionId: world.alpha.templateVersionId,
      originKind,
    });
    const { rows } = await world.database.session.query<{
      id: string;
      contact_id: string;
      permission_id: string | null;
      address: string;
    }>(
      `SELECT n.id, n.contact_id, n.permission_id,
              (SELECT a.address FROM email_addresses a WHERE a.workspace_id = n.workspace_id AND a.contact_id = n.contact_id
                ORDER BY a.created_at, a.id LIMIT 1) AS address
         FROM step_executions e
         JOIN sequence_enrollments n ON n.workspace_id = e.workspace_id AND n.id = e.enrollment_id
        WHERE e.workspace_id = $1 AND e.id = $2`,
      [workspaceId(), executionId],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('the enrollment fixture is missing');
    return { enrollmentId: row.id, contactId: row.contact_id, address: row.address, permissionId: row.permission_id };
  }

  /** A prospecting enrollment and a single-email follow-up permission (and its run) at one firm. */
  async function work(label: string): Promise<Work> {
    const firm = await seedFirm(world, world.alpha, label);
    const prospecting = await enrollment(firm.firmId, firm.opportunityId, 'prospecting');
    const followUp = await enrollment(firm.firmId, firm.opportunityId, 'follow_up');
    if (followUp.permissionId === null) throw new Error('the follow-up fixture has no permission');
    const updated = await world.database.session.query(
      `UPDATE follow_up_permissions
          SET kind = 'conversation', scope = 'single_email', sequence_version_id = NULL,
              template_version_id = $3, max_steps = 1
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceId(), followUp.permissionId, world.alpha.templateVersionId],
    );
    expect(updated.rowCount).toBe(1);
    return {
      firmId: firm.firmId,
      opportunityId: firm.opportunityId,
      prospecting,
      followUp: { ...followUp, permissionId: followUp.permissionId },
    };
  }

  let stored = 0;
  /** The account's own outgoing message to both people, sent at `sentAt`. */
  async function sentAt(target: Work, instant: string) {
    stored += 1;
    const { rows } = await world.database.session.query<{ id: string }>(
      `INSERT INTO mail_messages (workspace_id, mailbox_id, provider_message_id, provider_thread_id, direction,
                                  internal_date, header_from, header_to, matched)
       VALUES ($1, $2, $3, $3, 'outgoing', $4::timestamptz, $5, $6::text[], true)
       RETURNING id`,
      [
        workspaceId(),
        world.alpha.mailboxId,
        `boundary-${String(stored)}`,
        instant,
        (await mailboxRow()).email_address,
        [target.prospecting.address, target.followUp.address],
      ],
    );
    const message = await readMessage(worker(), rows[0]?.id ?? '');
    if (message === null) throw new Error('the message fixture was not stored');
    return await applyDirectSendEffects(worker(), {
      message,
      candidate: {
        firmId: target.firmId,
        opportunityId: target.opportunityId,
        contactId: target.followUp.contactId,
        rule: 'participant',
        viaClosedOpportunity: false,
      },
    });
  }

  async function state(target: Work) {
    const { rows } = await world.database.session.query<{ id: string; state: string; end_reason: string | null }>(
      `SELECT id, state, end_reason FROM sequence_enrollments WHERE workspace_id = $1 AND id = ANY ($2::uuid[]) ORDER BY id`,
      [workspaceId(), [target.prospecting.enrollmentId, target.followUp.enrollmentId]],
    );
    const { rows: permission } = await world.database.session.query<{ consumed_reason: string | null }>(
      'SELECT consumed_reason FROM follow_up_permissions WHERE workspace_id = $1 AND id = $2',
      [workspaceId(), target.followUp.permissionId],
    );
    return {
      prospecting: rows.find(row => row.id === target.prospecting.enrollmentId)?.end_reason ?? null,
      followUp: rows.find(row => row.id === target.followUp.enrollmentId)?.end_reason ?? null,
      permission: permission[0]?.consumed_reason ?? null,
    };
  }

  async function createdAt(): Promise<number> {
    const { rows } = await world.database.session.query<{ at: Date }>('SELECT clock_timestamp() AS at');
    return rows[0]?.at.getTime() ?? 0;
  }

  async function switchNow(): Promise<string> {
    const started = await begin(NEW_ADDRESS);
    const done = await completeGmailGrant(owner(), grantDeps(account(NEW_ADDRESS)), { state: started.state, code: 'switch' });
    expect(done.ok).toBe(true);
    const { rows } = await world.database.session.query<{ active_from: Date }>(
      'SELECT active_from FROM mailbox_accounts WHERE workspace_id = $1 AND mailbox_id = $2 AND active_until IS NULL',
      [workspaceId(), world.alpha.mailboxId],
    );
    return rows[0]?.active_from.toISOString() ?? '';
  }

  const settleMs = async (ms: number): Promise<void> => await new Promise(resolve => setTimeout(resolve, ms));

  it('pre-switch Sent items of the new account end nothing and consume nothing; post-switch ones do', async () => {
    const target = await work('switch-boundary');
    await settleMs(20);
    const between = new Date((await createdAt()) - 5).toISOString();
    await settleMs(20);
    const since = await switchNow();
    expect(Date.parse(between)).toBeLessThan(Date.parse(since));

    // Sent after both were created, but before the account was this mailbox's.
    const before = await sentAt(target, between);
    expect(before.recorded).toBe(false);
    expect(await state(target)).toEqual({ prospecting: null, followUp: null, permission: null });

    const after = await sentAt(target, new Date().toISOString());
    expect(after.recorded).toBe(true);
    expect(await state(target)).toEqual({
      prospecting: 'direct_send',
      followUp: 'direct_send',
      permission: 'fulfilled_by_direct_send',
    });
  });

  it('a delayed import of a message sent before the grant does not consume it; one sent after does', async () => {
    const early = new Date(Date.now() - 3_600_000).toISOString();
    const target = await work('before-grant');
    // No switch: the mailbox has no account rows and no account bound.
    const stale = await sentAt(target, early);
    expect(stale.recorded).toBe(true);
    expect(stale.consumedPermissionIds).toEqual([]);
    expect(stale.endedEnrollmentIds).toEqual([]);
    expect(await state(target)).toEqual({ prospecting: null, followUp: null, permission: null });

    const fresh = await sentAt(target, new Date().toISOString());
    expect(fresh.consumedPermissionIds).toEqual([target.followUp.permissionId]);
    expect(await state(target)).toEqual({
      prospecting: 'direct_send',
      followUp: 'direct_send',
      permission: 'fulfilled_by_direct_send',
    });
  });

  it('compares every boundary exactly: a message at .123 is before a creation at .123900', async () => {
    const target = await work('exact-boundary');
    const session = world.database.session;
    const created = '2026-09-30T12:00:00.123900Z';
    // (b) the permission, and (c) both enrollments, created a fraction of a millisecond
    // after the message's Gmail date.
    await session.query('UPDATE follow_up_permissions SET created_at = $3 WHERE workspace_id = $1 AND id = $2', [
      workspaceId(),
      target.followUp.permissionId,
      created,
    ]);
    await session.query(
      'UPDATE sequence_enrollments SET created_at = $3, started_at = $3 WHERE workspace_id = $1 AND id = ANY ($2::uuid[])',
      [workspaceId(), [target.prospecting.enrollmentId, target.followUp.enrollmentId], created],
    );
    const early = await sentAt(target, '2026-09-30T12:00:00.123Z');
    expect(early.consumedPermissionIds).toEqual([]);
    expect(early.endedEnrollmentIds).toEqual([]);
    expect(await state(target)).toEqual({ prospecting: null, followUp: null, permission: null });

    // (a) the account: a current account that began at .123900 does not own a .123 Sent item.
    await session.query(
      `INSERT INTO mailbox_accounts (workspace_id, mailbox_id, email_address, active_from, generation_from)
       VALUES ($1, $2, $3, $4, 1)`,
      [workspaceId(), world.alpha.mailboxId, world.alpha.address, '2026-09-30T13:00:00.123900Z'],
    );
    const beforeAccount = await sentAt(target, '2026-09-30T13:00:00.123Z');
    expect(beforeAccount.recorded).toBe(false);
    const atAccount = await sentAt(target, '2026-09-30T13:00:00.124Z');
    expect(atAccount.recorded).toBe(true);
  });

  it('a same-address re-consent sets no bound: a message from before it is still a direct send', async () => {
    const target = await work('reconsent-no-bound');
    await settleMs(20);
    const between = new Date((await createdAt()) - 5).toISOString();
    await settleMs(20);
    const started = await begin(undefined);
    const done = await completeGmailGrant(owner(), grantDeps(account(world.alpha.address)), {
      state: started.state,
      code: 'reconsent',
    });
    expect(done).toMatchObject({ ok: true, value: { switched: false } });
    expect(await countWhere('mailbox_accounts')).toBe(0);

    const outcome = await sentAt(target, between);
    expect(outcome.recorded).toBe(true);
    expect(await state(target)).toEqual({
      prospecting: 'direct_send',
      followUp: 'direct_send',
      permission: 'fulfilled_by_direct_send',
    });
  });
});
