import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { withTransaction } from '../../db/queryable.ts';
import { CLUSTER_URL_ENVIRONMENT_VARIABLE } from '../../db/testing/testDatabase.ts';
import { coalesceMailSync } from '../../mail/coalesce.ts';
import type { GmailClient } from '../../mail/gmailClient.ts';
import { recordingMailLog } from '../../mail/log.ts';
import {
  fenceOf,
  lockForFencedStopFact,
  readMailbox,
  readMailboxForUpdate,
  readMailboxHold,
  resetAccountState,
  StaleMailboxGeneration,
} from '../../mail/mailboxes.ts';
import { readRecovery, runMailRecovery, startRecovery, type MailRecoveryReport } from '../../mail/recover.ts';
import { runMailSync } from '../../mail/sync.ts';
import { listWatchesDue, readCurrentWatch, renewWatch } from '../../mail/watch.ts';
import { isSuppressed } from '../../suppression/effective.ts';
import {
  createMailWorld,
  fixtureMessage,
  TEST_TOPIC_NAME,
  type MailWorld,
  type MailWorldMailbox,
} from './support/mailWorld.ts';

/**
 * Mail core correctness (slice C2B-A1): generation fencing, the continuous handoff,
 * resume by recorded ids, conditional completion, RFC Message-ID conflicts, watch
 * fencing and generation-keyed jobs. `docs/greenfield/mail.md` states the rules.
 */

let world: MailWorld | null = null;

afterEach(async () => {
  await world?.stop();
  world = null;
});

const PROSPECT = 'reception@northwind.example.test';
const STRANGER = 'someone@elsewhere.example.test';

/**
 * A second connection to the test database: what another transaction — an account
 * switch, a new baseline — does while a job's own transaction is still open.
 */
async function otherConnection(w: MailWorld): Promise<pg.Client> {
  const url = new URL((process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE] ?? '').trim());
  url.pathname = `/${w.database.name}`;
  const client = new pg.Client({ connectionString: url.toString() });
  client.on('error', () => undefined);
  await client.connect();
  return client;
}

/** Run a job's body the way the runner does: one transaction, rolled back on a throw. */
async function asJob<T>(w: MailWorld, work: () => Promise<T>): Promise<T> {
  return await withTransaction(w.database.session, work);
}

async function countRows(w: MailWorld, mailboxId: string): Promise<number> {
  const { rows } = await w.database.session.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM mail_messages WHERE mailbox_id = $1',
    [mailboxId],
  );
  return Number(rows[0]?.count ?? 0);
}

async function completeBaseline(w: MailWorld, mailbox: MailWorldMailbox): Promise<void> {
  const context = w.systemContext(mailbox.workspace.workspaceId);
  const outcome = await runMailRecovery(context, w.syncDeps(mailbox), { mailboxId: mailbox.mailboxId, generation: 1 });
  if (outcome.outcome !== 'completed') throw new Error(`the baseline did not complete: ${outcome.outcome}`);
}

describe('resetAccountState', () => {
  it('clears the cursor, its instant, the watermark and the last sync in one statement the CHECKs accept', async () => {
    world = await createMailWorld({
      alphaMessages: [
        fixtureMessage({ id: 'reset1', historyId: '1001', from: 'someone@elsewhere.example.test', to: 'sales.alpha@example.test' }),
      ],
    });
    const w = world;
    const context = w.systemContext(w.alpha.workspace.workspaceId);
    await completeBaseline(w, w.alpha);
    await w.database.session.query(
      "UPDATE mailboxes SET last_sync_error = 'an earlier failure', last_synced_at = now() WHERE id = $1",
      [w.alpha.mailboxId],
    );
    const before = await readMailbox(context, w.alpha.mailboxId);
    expect(before?.historyId).not.toBeNull();
    expect(before?.coverageWatermarkAt).not.toBeNull();

    // Either CHECK refuses a reset that clears one column without the others.
    await expect(
      w.database.session.query('UPDATE mailboxes SET history_id = NULL WHERE id = $1', [w.alpha.mailboxId]),
    ).rejects.toMatchObject({ code: '23514' });

    await withTransaction(w.database.session, async () => {
      await readMailboxForUpdate(context, w.alpha.mailboxId);
      await resetAccountState(context, { mailboxId: w.alpha.mailboxId });
    });

    const { rows } = await w.database.session.query<{
      history_id: string | null;
      history_id_updated_at: Date | null;
      coverage_watermark_at: Date | null;
      last_sync_error: string | null;
      last_synced_at: Date | null;
    }>(
      `SELECT history_id, history_id_updated_at, coverage_watermark_at, last_sync_error, last_synced_at
         FROM mailboxes WHERE id = $1`,
      [w.alpha.mailboxId],
    );
    expect(rows[0]).toEqual({
      history_id: null,
      history_id_updated_at: null,
      coverage_watermark_at: null,
      last_sync_error: null,
      last_synced_at: null,
    });
    // The other mailbox is not touched.
    const beta = await readMailbox(w.systemContext(w.beta.workspace.workspaceId), w.beta.mailboxId);
    expect(beta?.historyId).not.toBeNull();
  });

  it('refuses a mailbox that is not there', async () => {
    world = await createMailWorld();
    const w = world;
    const context = w.systemContext(w.alpha.workspace.workspaceId);
    await expect(resetAccountState(context, { mailboxId: w.beta.mailboxId })).rejects.toThrow(/found no mailbox/);
  });
});

describe('generation fencing', () => {
  it('an in-flight sync that read generation g commits nothing when the mailbox moves to g+1 before its CAS', async () => {
    world = await createMailWorld();
    const w = world;
    await completeBaseline(w, w.alpha);
    const context = w.systemContext(w.alpha.workspace.workspaceId);
    const before = await readMailbox(context, w.alpha.mailboxId);
    w.alpha.messages.push(
      fixtureMessage({ id: 'fenced-optout', historyId: '1013', from: PROSPECT, to: w.alpha.address, body: 'Please stop emailing me.' }),
    );

    const other = await otherConnection(w);
    try {
      const base = w.syncDeps(w.alpha);
      const gmail: GmailClient = {
        ...base.gmail,
        listHistory: async (...args) => {
          // Another transaction moves the mailbox on while this sync is reading Gmail.
          await other.query('UPDATE mailboxes SET generation = generation + 1 WHERE id = $1', [w.alpha.mailboxId]);
          return await base.gmail.listHistory(...args);
        },
      };
      await expect(
        asJob(w, async () => await runMailSync(context, { ...base, gmail }, { mailboxId: w.alpha.mailboxId })),
      ).rejects.toBeInstanceOf(StaleMailboxGeneration);
    } finally {
      await other.end().catch(() => undefined);
    }

    // Nothing it did committed: no message, no suppression, the cursor where it was.
    expect(await countRows(w, w.alpha.mailboxId)).toBe(0);
    expect(await isSuppressed(context, { scope: 'handle', canonicalKey: PROSPECT })).toBeNull();
    const after = await readMailbox(context, w.alpha.mailboxId);
    expect(after?.historyId).toBe(before?.historyId);
    expect(after?.generation).toBe((before?.generation ?? 0) + 1);
  });

  it.each(['baseline_pending', 'recovering'] as const)('the retry after a generation change is harmless: a sync of a %s mailbox reads no history and writes nothing', async syncState => {
    world = await createMailWorld();
    const w = world;
    await completeBaseline(w, w.alpha);
    const context = w.systemContext(w.alpha.workspace.workspaceId);
    w.alpha.messages.push(
      fixtureMessage({ id: 'after-switch', historyId: '1013', from: PROSPECT, to: w.alpha.address, body: 'Please stop emailing me.' }),
    );
    // What an account switch leaves behind: a new generation, a baseline pending, and
    // the new generation's recovery already started.
    await w.database.session.query(
      'UPDATE mailboxes SET generation = generation + 1, sync_state = $2 WHERE id = $1',
      [w.alpha.mailboxId, syncState],
    );
    const switched = await readMailbox(context, w.alpha.mailboxId);
    if (switched === null) throw new Error('the mailbox is gone');
    await startRecovery(context, {
      mailbox: switched,
      reason: syncState === 'recovering' ? 'history_expired' : 'baseline',
      startHistoryId: '1000',
    });

    const historyReads = w.alpha.gmail.calls.filter(call => call.method === 'listHistory').length;
    const report = await asJob(w, async () => await runMailSync(context, w.syncDeps(w.alpha), { mailboxId: w.alpha.mailboxId }));
    expect(report.outcome).toBe('recovery_underway');
    expect(w.alpha.gmail.calls.filter(call => call.method === 'listHistory').length).toBe(historyReads);
    expect(await countRows(w, w.alpha.mailboxId)).toBe(0);
    // The recovery's handoff cursor is where the recovery put it.
    expect((await readMailbox(context, w.alpha.mailboxId))?.historyId).toBe('1000');
  });

  it('an in-flight recovery that read generation g writes no progress when the mailbox moves on', async () => {
    world = await createMailWorld({
      alphaMessages: [1, 2, 3].map(index =>
        fixtureMessage({
          id: `progress${String(index)}`,
          historyId: String(1000 + index),
          from: STRANGER,
          to: 'sales.alpha@example.test',
          internalDateEpochMilliseconds: Date.parse('2026-09-10T10:00:00Z') + index * 60_000,
        }),
      ),
    });
    const w = world;
    const context = w.systemContext(w.alpha.workspace.workspaceId);
    const other = await otherConnection(w);
    try {
      const base = w.syncDeps(w.alpha);
      const gmail: GmailClient = {
        ...base.gmail,
        listMessageIds: async (...args) => {
          await other.query('UPDATE mailboxes SET generation = generation + 1 WHERE id = $1', [w.alpha.mailboxId]);
          return await base.gmail.listMessageIds(...args);
        },
      };
      await expect(
        asJob(w, async () =>
          await runMailRecovery(context, { ...base, gmail, pageSize: 2, maxMessages: 1 }, { mailboxId: w.alpha.mailboxId, generation: 1 }),
        ),
      ).rejects.toBeInstanceOf(StaleMailboxGeneration);
    } finally {
      await other.end().catch(() => undefined);
    }
    expect(await countRows(w, w.alpha.mailboxId)).toBe(0);
    const recovery = await readRecovery(context, { mailboxId: w.alpha.mailboxId, generation: 1 });
    expect(recovery?.pagesCompleted).toBe(0);
    expect(recovery?.messagesSeen).toBe(0);
    // The retry: the recovery's generation is superseded, and it writes nothing.
    const retry = await asJob(w, async () =>
      await runMailRecovery(context, w.syncDeps(w.alpha), { mailboxId: w.alpha.mailboxId, generation: 1 }),
    );
    expect(retry.outcome).toBe('generation_superseded');
    expect(await countRows(w, w.alpha.mailboxId)).toBe(0);
  });
});

describe('fenced refusal paths (fold 2)', () => {
  const holdsOf = async (w: MailWorld) =>
    (
      await w.database.session.query<{ reason_code: string }>(
        `SELECT reason_code FROM active_holds
          WHERE source_event_id = $1 AND released_at IS NULL ORDER BY reason_code`,
        [w.alpha.mailboxId],
      )
    ).rows.map(row => row.reason_code);

  it('a sync that read g gets grant_revoked after the switch commits g+1: the mailbox is not revoked and no hold opens', async () => {
    world = await createMailWorld();
    const w = world;
    await completeBaseline(w, w.alpha);
    const context = w.systemContext(w.alpha.workspace.workspaceId);
    const holdsBefore = await holdsOf(w);
    const other = await otherConnection(w);
    try {
      const base = w.alpha.gmail;
      const gmail: GmailClient = {
        ...base,
        refreshAccessToken: async () => {
          await other.query('UPDATE mailboxes SET generation = generation + 1 WHERE id = $1', [w.alpha.mailboxId]);
          return { ok: false, reason: 'grant_revoked' };
        },
      };
      await expect(
        asJob(w, async () => await runMailSync(context, { ...w.syncDeps(w.alpha), gmail }, { mailboxId: w.alpha.mailboxId })),
      ).rejects.toBeInstanceOf(StaleMailboxGeneration);
    } finally {
      await other.end().catch(() => undefined);
    }
    expect((await readMailbox(context, w.alpha.mailboxId))?.status).toBe('connected');
    expect(await holdsOf(w)).toEqual(holdsBefore);
    expect(await holdsOf(w)).not.toContain('mailbox_disconnected');
  });

  it('a sync that read g is rate limited after the switch commits g+1: no sync error lands on the new account', async () => {
    world = await createMailWorld();
    const w = world;
    await completeBaseline(w, w.alpha);
    const context = w.systemContext(w.alpha.workspace.workspaceId);
    const other = await otherConnection(w);
    try {
      const base = w.alpha.gmail;
      const gmail: GmailClient = {
        ...base,
        listHistory: async () => {
          await other.query('UPDATE mailboxes SET generation = generation + 1 WHERE id = $1', [w.alpha.mailboxId]);
          return { ok: false, reason: 'rate_limited' };
        },
      };
      await expect(
        asJob(w, async () => await runMailSync(context, { ...w.syncDeps(w.alpha), gmail }, { mailboxId: w.alpha.mailboxId })),
      ).rejects.toBeInstanceOf(StaleMailboxGeneration);
    } finally {
      await other.end().catch(() => undefined);
    }
    expect((await readMailbox(context, w.alpha.mailboxId))?.lastSyncError).toBeNull();
  });

  it('a watch renewal that read g gets grant_revoked after g+1 commits: nothing is revoked or held', async () => {
    world = await createMailWorld();
    const w = world;
    const context = w.systemContext(w.alpha.workspace.workspaceId);
    const holdsBefore = await holdsOf(w);
    const other = await otherConnection(w);
    try {
      const gmail: GmailClient = {
        ...w.alpha.gmail,
        watch: async () => {
          await other.query('UPDATE mailboxes SET generation = generation + 1 WHERE id = $1', [w.alpha.mailboxId]);
          return { ok: false, reason: 'grant_revoked' };
        },
      };
      await expect(
        asJob(w, async () =>
          await renewWatch(
            context,
            { gmail, oauth: w.syncDeps(w.alpha).oauth, cipher: w.cipher, topicName: TEST_TOPIC_NAME, log: recordingMailLog() },
            { mailboxId: w.alpha.mailboxId, generation: 1 },
          ),
        ),
      ).rejects.toBeInstanceOf(StaleMailboxGeneration);
    } finally {
      await other.end().catch(() => undefined);
    }
    expect((await readMailbox(context, w.alpha.mailboxId))?.status).toBe('connected');
    expect(await holdsOf(w)).toEqual(holdsBefore);
  });

  it('a recovery that read g is rate limited after g+1 commits: no sync error is written', async () => {
    world = await createMailWorld();
    const w = world;
    const context = w.systemContext(w.alpha.workspace.workspaceId);
    const other = await otherConnection(w);
    try {
      const gmail: GmailClient = {
        ...w.alpha.gmail,
        listMessageIds: async () => {
          await other.query('UPDATE mailboxes SET generation = generation + 1 WHERE id = $1', [w.alpha.mailboxId]);
          return { ok: false, reason: 'rate_limited' };
        },
      };
      await expect(
        asJob(w, async () => await runMailRecovery(context, { ...w.syncDeps(w.alpha), gmail }, { mailboxId: w.alpha.mailboxId, generation: 1 })),
      ).rejects.toBeInstanceOf(StaleMailboxGeneration);
    } finally {
      await other.end().catch(() => undefined);
    }
    expect((await readMailbox(context, w.alpha.mailboxId))?.lastSyncError).toBeNull();
  });
});

describe('recovery progress holds the mailbox row to commit (fold 2)', () => {
  it('a concurrent generation bump waits for the progress commit', async () => {
    world = await createMailWorld({
      alphaMessages: [1, 2, 3].map(index =>
        fixtureMessage({
          id: `held${String(index)}`,
          historyId: String(1000 + index),
          from: STRANGER,
          to: 'sales.alpha@example.test',
          internalDateEpochMilliseconds: Date.parse('2026-09-10T10:00:00Z') + index * 60_000,
        }),
      ),
    });
    const w = world;
    const context = w.systemContext(w.alpha.workspace.workspaceId);
    const other = await otherConnection(w);
    let bump: Promise<unknown> | null = null;
    let blocked = false;
    try {
      const report = await asJob(w, async () => {
        const run = await runMailRecovery(
          context,
          { ...w.syncDeps(w.alpha), pageSize: 5, maxMessages: 1 },
          { mailboxId: w.alpha.mailboxId, generation: 1 },
        );
        // The progress is written and not yet committed. A switch now must wait.
        bump = other.query('UPDATE mailboxes SET generation = generation + 1 WHERE id = $1', [w.alpha.mailboxId]);
        for (let attempt = 0; attempt < 50 && !blocked; attempt += 1) {
          const { rows } = await w.database.session.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM pg_stat_activity
              WHERE pid <> pg_backend_pid() AND pg_backend_pid() = ANY(pg_blocking_pids(pid))`,
          );
          blocked = Number(rows[0]?.count ?? 0) > 0;
          if (!blocked) await new Promise(resolve => setTimeout(resolve, 20));
        }
        return run;
      });
      expect(report.outcome).toBe('continued');
      await bump;
    } finally {
      await other.end().catch(() => undefined);
    }
    expect(blocked).toBe(true);
    expect((await readMailbox(context, w.alpha.mailboxId))?.generation).toBe(2);
  });
});

describe('the fenced row lock does not conflict with a message insert (fold 2, A2 review)', () => {
  it('a job holding the gate takes the fenced lock while another holds KEY SHARE from an uncommitted insert: no block, no deadlock', async () => {
    world = await createMailWorld();
    const w = world;
    const context = w.systemContext(w.alpha.workspace.workspaceId);
    const mailbox = await readMailbox(context, w.alpha.mailboxId);
    if (mailbox === null) throw new Error('the mailbox is gone');
    const other = await otherConnection(w);
    try {
      // Job X: a message inserted, so its transaction holds KEY SHARE on the mailbox row.
      await other.query('BEGIN');
      await other.query(
        `INSERT INTO mail_messages (workspace_id, mailbox_id, provider_message_id, provider_thread_id, direction, internal_date)
         VALUES ($1, $2, 'keyshare1', 'thread-keyshare1', 'incoming', now())`,
        [w.alpha.workspace.workspaceId, w.alpha.mailboxId],
      );
      // Job Y: the gate, then the fenced lock. A `FOR UPDATE` here would wait on X.
      await asJob(w, async () => {
        await w.database.session.query("SET LOCAL lock_timeout = '2s'");
        await lockForFencedStopFact(context, { mailboxId: mailbox.id, fence: fenceOf(mailbox), write: 'test' });
        const { rows } = await w.database.session.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM pg_stat_activity
            WHERE pid <> pg_backend_pid() AND cardinality(pg_blocking_pids(pid)) > 0 AND datname = current_database()`,
        );
        expect(rows[0]?.count).toBe('0');
      });
      await other.query('ROLLBACK');
    } finally {
      await other.end().catch(() => undefined);
    }
  });
});

describe('conditional completion', () => {
  const finalRunWith = async (
    w: MailWorld,
    change: string,
  ): Promise<void> => {
    const context = w.systemContext(w.alpha.workspace.workspaceId);
    const other = await otherConnection(w);
    try {
      const base = w.syncDeps(w.alpha);
      const gmail: GmailClient = {
        ...base.gmail,
        listMessageIds: async (...args) => {
          await other.query(change, [w.alpha.mailboxId]);
          return await base.gmail.listMessageIds(...args);
        },
      };
      await expect(
        asJob(w, async () => await runMailRecovery(context, { ...base, gmail }, { mailboxId: w.alpha.mailboxId, generation: 1 })),
      ).rejects.toBeInstanceOf(StaleMailboxGeneration);
    } finally {
      await other.end().catch(() => undefined);
    }
  };

  const expectNotCompleted = async (w: MailWorld): Promise<void> => {
    const context = w.systemContext(w.alpha.workspace.workspaceId);
    const recovery = await readRecovery(context, { mailboxId: w.alpha.mailboxId, generation: 1 });
    expect(recovery?.completedAt).toBeNull();
    const mailbox = await readMailbox(context, w.alpha.mailboxId);
    expect(mailbox?.syncState).toBe('baseline_pending');
    expect(mailbox?.coverageWatermarkAt).toBeNull();
    expect(await readMailboxHold(context, w.alpha.mailboxId, 'coverage_incomplete')).not.toBeNull();
    expect(await countRows(w, w.alpha.mailboxId)).toBe(0);
  };

  it('a mailbox bumped to g+1 during the final run: nothing completes, nothing is released, nothing is recorded', async () => {
    world = await createMailWorld({
      alphaMessages: [fixtureMessage({ id: 'final1', historyId: '1001', from: STRANGER, to: 'sales.alpha@example.test' })],
    });
    await finalRunWith(world, 'UPDATE mailboxes SET generation = generation + 1 WHERE id = $1');
    await expectNotCompleted(world);
  });

  it('a cursor moved off the handoff id during the final run: the completion refuses it', async () => {
    world = await createMailWorld({
      alphaMessages: [fixtureMessage({ id: 'final2', historyId: '1001', from: STRANGER, to: 'sales.alpha@example.test' })],
    });
    await finalRunWith(world, "UPDATE mailboxes SET history_id = '5555', history_id_updated_at = now() WHERE id = $1");
    await expectNotCompleted(world);
  });
});

describe('the continuous handoff', () => {
  it('an opt-out arriving after toAt, during the recovery, is suppressed by the first mail.sync after completion', async () => {
    world = await createMailWorld();
    const w = world;
    const context = w.systemContext(w.alpha.workspace.workspaceId);
    const recovery = await readRecovery(context, { mailboxId: w.alpha.mailboxId, generation: 1 });
    if (recovery === null) throw new Error('the connect started no baseline');
    const mailbox = await readMailbox(context, w.alpha.mailboxId);
    // startRecovery stored the profile's history id, read before toAt, as the cursor.
    expect(mailbox?.historyId).toBe('1000');

    // Gmail receives the opt-out after the interval's end, while the recovery runs, and
    // the mailbox's history id moves past it.
    w.alpha.messages.push(
      fixtureMessage({
        id: 'late-optout',
        historyId: '1013',
        from: PROSPECT,
        to: w.alpha.address,
        body: 'Please stop emailing me.',
        internalDateEpochMilliseconds: Date.parse(recovery.toAt) + 5 * 60_000,
      }),
    );
    (w.alpha.fixture as { historyId: string }).historyId = '1013';

    const finished = await asJob(w, async () =>
      await runMailRecovery(context, w.syncDeps(w.alpha), { mailboxId: w.alpha.mailboxId, generation: 1 }),
    );
    expect(finished.outcome).toBe('completed');
    // Completion adopted the captured id, not the profile's current one.
    expect((await readMailbox(context, w.alpha.mailboxId))?.historyId).toBe('1000');
    expect(await isSuppressed(context, { scope: 'handle', canonicalKey: PROSPECT })).toBeNull();

    const synced = await asJob(w, async () => await runMailSync(context, w.syncDeps(w.alpha), { mailboxId: w.alpha.mailboxId }));
    expect(synced.outcome).toBe('synced');
    expect(synced.suppressionsRecorded).toBeGreaterThan(0);
    expect(await isSuppressed(context, { scope: 'handle', canonicalKey: PROSPECT })).not.toBeNull();
  });
});

describe('legacy recoveries adopt a handoff (fold 2)', () => {
  it.each([
    ['no cursor', "UPDATE mailboxes SET history_id = NULL, history_id_updated_at = NULL WHERE id = $1"],
    [
      'an expired cursor older than the recovery',
      `UPDATE mailboxes SET history_id = '777',
              history_id_updated_at = (SELECT started_at FROM mailbox_recoveries WHERE mailbox_id = $1) - interval '1 hour'
        WHERE id = $1`,
    ],
  ])('a recovery left with %s takes a fresh handoff at its next run', async (_label, legacy) => {
    world = await createMailWorld();
    const w = world;
    const context = w.systemContext(w.alpha.workspace.workspaceId);
    await w.database.session.query(legacy, [w.alpha.mailboxId]);
    (w.alpha.fixture as { historyId: string }).historyId = '1050';
    const report = await asJob(w, async () =>
      await runMailRecovery(context, w.syncDeps(w.alpha), { mailboxId: w.alpha.mailboxId, generation: 1 }),
    );
    expect(report.outcome).toBe('completed');
    expect((await readMailbox(context, w.alpha.mailboxId))?.historyId).toBe('1050');
    expect(w.alpha.gmail.calls.filter(call => call.method === 'getProfile').length).toBeGreaterThan(0);
  });
});

describe('resume by recorded ids', () => {
  const runUntilDone = async (
    w: MailWorld,
    between: (run: number) => void = () => undefined,
  ): Promise<readonly MailRecoveryReport[]> => {
    const context = w.systemContext(w.alpha.workspace.workspaceId);
    const reports: MailRecoveryReport[] = [];
    for (let run = 0; run < 10; run += 1) {
      const report = await asJob(w, async () =>
        await runMailRecovery(
          context,
          { ...w.syncDeps(w.alpha), pageSize: 2, maxMessages: 2 },
          { mailboxId: w.alpha.mailboxId, generation: 1 },
        ),
      );
      reports.push(report);
      if (report.outcome !== 'continued') break;
      between(run);
    }
    return reports;
  };

  const stranger = (id: string, index: number) =>
    fixtureMessage({
      id,
      historyId: String(1000 + index),
      from: STRANGER,
      to: 'sales.alpha@example.test',
      internalDateEpochMilliseconds: Date.parse('2026-09-10T10:00:00Z') + index * 60_000,
    });

  it('five messages, pages of two, two per run: each processed exactly once, coverage proved, no page token ever sent', async () => {
    const ids = ['walk1', 'walk2', 'walk3', 'walk4', 'walk5'];
    world = await createMailWorld({ alphaMessages: ids.map((id, index) => stranger(id, index + 1)) });
    const w = world;
    const context = w.systemContext(w.alpha.workspace.workspaceId);

    const reports = await runUntilDone(w);
    expect(reports.map(report => report.outcome)).toEqual(['continued', 'continued', 'completed']);
    expect(reports.at(-1)?.coverageProved).toBe(true);
    for (const id of ids) expect(w.alpha.gmail.metadataReads.filter(read => read === id), id).toHaveLength(1);
    expect(await countRows(w, w.alpha.mailboxId)).toBe(5);

    // Single-page time slices: the recovery never follows a page token (fold 2).
    const listings = w.alpha.gmail.calls.filter(call => call.method === 'listMessageIds');
    expect(listings.length).toBeGreaterThan(0);
    expect(listings.map(call => call.detail['pageToken'])).toEqual(listings.map(() => null));

    const mailbox = await readMailbox(context, w.alpha.mailboxId);
    expect(mailbox?.syncState).toBe('ready');
    expect(await readMailboxHold(context, w.alpha.mailboxId, 'coverage_incomplete')).toBeNull();
    expect((await readRecovery(context, { mailboxId: w.alpha.mailboxId, generation: 1 }))?.completedAt).not.toBeNull();
  });

  it('fold 2: a message deleted between two listing calls of one run cannot shift a survivor out of the walk', async () => {
    world = await createMailWorld({
      alphaMessages: [stranger('shiftA', 1), stranger('shiftB', 2), stranger('shiftC', 3)],
    });
    const w = world;
    const context = w.systemContext(w.alpha.workspace.workspaceId);
    const base = w.alpha.gmail;
    let deleted = false;
    const gmail: GmailClient = {
      ...base,
      listMessageIds: async (...args) => {
        const outcome = await base.listMessageIds(...args);
        // A is deleted right after the first answer that listed it.
        if (!deleted && outcome.ok && outcome.messageIds.includes('shiftA')) {
          deleted = true;
          const index = w.alpha.messages.findIndex(message => message.id === 'shiftA');
          w.alpha.messages.splice(index, 1);
        }
        return outcome;
      },
    };
    const reports: MailRecoveryReport[] = [];
    for (let run = 0; run < 5; run += 1) {
      const report = await asJob(w, async () =>
        await runMailRecovery(context, { ...w.syncDeps(w.alpha), gmail, pageSize: 2, maxMessages: 2 }, { mailboxId: w.alpha.mailboxId, generation: 1 }),
      );
      reports.push(report);
      if (report.outcome !== 'continued') break;
    }
    expect(deleted).toBe(true);
    expect(reports.at(-1)?.outcome).toBe('completed');
    const { rows } = await w.database.session.query<{ provider_message_id: string }>(
      'SELECT provider_message_id FROM mail_messages WHERE mailbox_id = $1 ORDER BY provider_message_id',
      [w.alpha.mailboxId],
    );
    expect(rows.map(row => row.provider_message_id)).toEqual(['shiftB', 'shiftC']);
  });

  it('a message deleted between runs shifts nothing: the one after it is processed, and completion waits for it', async () => {
    world = await createMailWorld({
      alphaMessages: [stranger('keepA', 1), stranger('goneB', 2), stranger('laterC', 3)],
    });
    const w = world;
    const reports = await runUntilDone(w, () => {
      const index = w.alpha.messages.findIndex(message => message.id === 'goneB');
      if (index >= 0) w.alpha.messages.splice(index, 1);
    });
    expect(reports.map(report => report.outcome)).toEqual(['continued', 'completed']);
    expect(w.alpha.gmail.metadataReads).toEqual(['keepA', 'goneB', 'laterC']);
    const { rows } = await w.database.session.query<{ provider_message_id: string }>(
      'SELECT provider_message_id FROM mail_messages WHERE mailbox_id = $1 ORDER BY provider_message_id',
      [w.alpha.mailboxId],
    );
    expect(rows.map(row => row.provider_message_id)).toEqual(['goneB', 'keepA', 'laterC']);
  });
});

describe('recovery budgets (fold 1)', () => {
  /**
   * Three proven duplicates, one vanished id and two new messages, in a recovery with
   * `maxMessages` 2. The duplicates and the vanished id write no row, so they must not
   * spend the budget: if they did, every run would re-take the same first ids and the
   * recovery would never complete.
   */
  it('maxMessages 2 with 3 proven duplicates, a vanished id and 2 new messages completes, and counts each kind', async () => {
    const at = (minute: number): number => Date.parse('2026-09-11T11:30:00Z') + minute * 60_000;
    const original = (index: number) =>
      fixtureMessage({
        id: `orig${String(index)}`,
        historyId: String(900 + index),
        from: STRANGER,
        to: 'sales.alpha@example.test',
        subject: `Copy ${String(index)}`,
        messageId: `copied${String(index)}@x.test`,
        internalDateEpochMilliseconds: at(index),
      });
    world = await createMailWorld({ alphaMessages: [1, 2, 3].map(original) });
    const w = world;
    await completeBaseline(w, w.alpha);
    const context = w.systemContext(w.alpha.workspace.workspaceId);

    // Second copies of the three originals (same direction, From, Subject, Date and
    // Message-ID, another Gmail id), a message Gmail lists and cannot read, and two new
    // messages — all inside the next recovery's interval, the vanished one second.
    w.alpha.messages.push(
      { ...original(1), id: 'dupe1', historyId: '1011' },
      fixtureMessage({ id: 'vanished1', historyId: '1012', from: STRANGER, to: 'sales.alpha@example.test', internalDateEpochMilliseconds: at(4) }),
      { ...original(2), id: 'dupe2', historyId: '1013' },
      { ...original(3), id: 'dupe3', historyId: '1014' },
      fixtureMessage({ id: 'new1', historyId: '1015', from: STRANGER, to: 'sales.alpha@example.test', internalDateEpochMilliseconds: at(5) }),
      fixtureMessage({ id: 'new2', historyId: '1016', from: STRANGER, to: 'sales.alpha@example.test', internalDateEpochMilliseconds: at(6) }),
    );
    const before = await readMailbox(context, w.alpha.mailboxId);
    const gmail = w.clientWith(w.alpha, { expiredHistoryIds: [before?.historyId ?? ''], vanishedMessageIds: ['vanished1'] });
    const started = await asJob(w, async () => await runMailSync(context, { ...w.syncDeps(w.alpha), gmail }, { mailboxId: w.alpha.mailboxId }));
    expect(started.outcome).toBe('recovery_started');

    const reports: MailRecoveryReport[] = [];
    for (let run = 0; run < 5; run += 1) {
      const report = await asJob(w, async () =>
        await runMailRecovery(context, { ...w.syncDeps(w.alpha), gmail, pageSize: 2, maxMessages: 2 }, { mailboxId: w.alpha.mailboxId, generation: 2 }),
      );
      reports.push(report);
      if (report.outcome !== 'continued') break;
    }
    expect(reports.map(report => report.outcome)).toEqual(['completed']);
    const final = reports[0];
    expect(final?.duplicateRfcId).toBe(3);
    expect(final?.vanishedMessages).toBe(1);
    expect(final?.messagesRecorded).toBe(2);
    expect(final?.coverageProved).toBe(true);

    const { rows } = await w.database.session.query<{ provider_message_id: string }>(
      'SELECT provider_message_id FROM mail_messages WHERE mailbox_id = $1 ORDER BY provider_message_id',
      [w.alpha.mailboxId],
    );
    expect(rows.map(row => row.provider_message_id)).toEqual(['new1', 'new2', 'orig1', 'orig2', 'orig3']);
    expect((await readMailbox(context, w.alpha.mailboxId))?.syncState).toBe('ready');
    expect(await readMailboxHold(context, w.alpha.mailboxId, 'coverage_incomplete')).toBeNull();
  });

  it('a run reads at most three times maxMessages ids, and does not complete when the cap stops it', async () => {
    world = await createMailWorld({
      alphaMessages: Array.from({ length: 8 }, (_, index) =>
        fixtureMessage({
          id: `gone${String(index)}`,
          historyId: String(1001 + index),
          from: STRANGER,
          to: 'sales.alpha@example.test',
          internalDateEpochMilliseconds: Date.parse('2026-09-10T10:00:00Z') + index * 60_000,
        }),
      ),
    });
    const w = world;
    const context = w.systemContext(w.alpha.workspace.workspaceId);
    const gmail = w.clientWith(w.alpha, { vanishedMessageIds: Array.from({ length: 8 }, (_, index) => `gone${String(index)}`) });
    const log = recordingMailLog();
    const report = await asJob(w, async () =>
      await runMailRecovery(context, { ...w.syncDeps(w.alpha), gmail, log, pageSize: 2, maxMessages: 2 }, { mailboxId: w.alpha.mailboxId, generation: 1 }),
    );
    expect(report.outcome).toBe('continued');
    expect(report.vanishedMessages).toBe(6);
    expect(gmail.metadataReads).toHaveLength(6);
    // Fold 2: a run that records nothing and does not complete says so.
    expect(log.lines.find(line => line.event === 'mail.recovery_no_progress')?.fields).toMatchObject({
      mailboxId: w.alpha.mailboxId,
      generation: 1,
      idsRead: 6,
      vanishedMessages: 6,
      duplicateRfcId: 0,
    });
  });
});

describe('the listing walk (fold 3)', () => {
  const recoveryBounds = async (w: MailWorld): Promise<{ readonly fromMs: number; readonly toMs: number }> => {
    const { rows } = await w.database.session.query<{ from_at: Date; to_at: Date }>(
      'SELECT from_at, to_at FROM mailbox_recoveries WHERE mailbox_id = $1 AND generation = 1',
      [w.alpha.mailboxId],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('no recovery');
    return { fromMs: row.from_at.getTime(), toMs: row.to_at.getTime() };
  };

  it.each([
    ['fromAt', 'after_inclusive'],
    ['toAt', 'after_inclusive'],
    ['fromAt', 'strict'],
    ['toAt', 'strict'],
  ] as const)('a message exactly at %s is listed when the bounds read %s', async (edge, listBounds) => {
    world = await createMailWorld();
    const w = world;
    const context = w.systemContext(w.alpha.workspace.workspaceId);
    const bounds = await recoveryBounds(w);
    // Both ends are whole seconds here, which is the exact-second case.
    expect(bounds.fromMs % 1000).toBe(0);
    expect(bounds.toMs % 1000).toBe(0);
    w.alpha.messages.push(
      fixtureMessage({
        id: 'edge1',
        historyId: '999',
        from: STRANGER,
        to: 'sales.alpha@example.test',
        internalDateEpochMilliseconds: edge === 'fromAt' ? bounds.fromMs : bounds.toMs,
      }),
    );
    const gmail = w.clientWith(w.alpha, { listBounds });
    const report = await asJob(w, async () =>
      await runMailRecovery(context, { ...w.syncDeps(w.alpha), gmail }, { mailboxId: w.alpha.mailboxId, generation: 1 }),
    );
    expect(report.outcome).toBe('completed');
    expect(await countRows(w, w.alpha.mailboxId)).toBe(1);
  });

  it('two adjacent seconds holding more than a page complete, by paging within that one small query', async () => {
    const second = Date.parse('2026-09-10T10:00:00Z');
    world = await createMailWorld({
      alphaMessages: [0, 1, 2, 3, 4, 5].map(index =>
        fixtureMessage({
          id: `dense${String(index)}`,
          historyId: String(1001 + index),
          from: STRANGER,
          to: 'sales.alpha@example.test',
          internalDateEpochMilliseconds: second + (index < 3 ? 0 : 1000),
        }),
      ),
    });
    const w = world;
    const context = w.systemContext(w.alpha.workspace.workspaceId);
    const log = recordingMailLog();
    const reports: MailRecoveryReport[] = [];
    for (let run = 0; run < 6; run += 1) {
      const report = await asJob(w, async () =>
        await runMailRecovery(context, { ...w.syncDeps(w.alpha), log, pageSize: 2, maxMessages: 2 }, { mailboxId: w.alpha.mailboxId, generation: 1 }),
      );
      reports.push(report);
      if (report.outcome !== 'continued') break;
    }
    expect(reports.at(-1)?.outcome).toBe('completed');
    expect(await countRows(w, w.alpha.mailboxId)).toBe(6);
    expect(log.lines.some(line => line.event === 'mail.recovery_slice_paginated')).toBe(true);
  });
});

describe('cursor_moved is fenced to commit (fold 3)', () => {
  it('a sync whose CAS finds the cursor moved holds the row at its generation until it commits', async () => {
    world = await createMailWorld();
    const w = world;
    await completeBaseline(w, w.alpha);
    const context = w.systemContext(w.alpha.workspace.workspaceId);
    w.alpha.messages.push(
      fixtureMessage({ id: 'moved1', historyId: '1013', from: STRANGER, to: w.alpha.address }),
    );
    const other = await otherConnection(w);
    let bump: Promise<unknown> | null = null;
    let blocked = false;
    try {
      const base = w.alpha.gmail;
      const gmail: GmailClient = {
        ...base,
        listHistory: async (...args) => {
          // Another sync advances the cursor first, so this run's CAS matches nothing.
          await other.query("UPDATE mailboxes SET history_id = '1500', history_id_updated_at = now() WHERE id = $1", [w.alpha.mailboxId]);
          return await base.listHistory(...args);
        },
      };
      const report = await asJob(w, async () => {
        const run = await runMailSync(context, { ...w.syncDeps(w.alpha), gmail }, { mailboxId: w.alpha.mailboxId });
        // A switch now must wait for this job's commit.
        bump = other.query('UPDATE mailboxes SET generation = generation + 1 WHERE id = $1', [w.alpha.mailboxId]);
        for (let attempt = 0; attempt < 50 && !blocked; attempt += 1) {
          const { rows } = await w.database.session.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM pg_stat_activity
              WHERE pid <> pg_backend_pid() AND pg_backend_pid() = ANY(pg_blocking_pids(pid))`,
          );
          blocked = Number(rows[0]?.count ?? 0) > 0;
          if (!blocked) await new Promise(resolve => setTimeout(resolve, 20));
        }
        return run;
      });
      expect(report.outcome).toBe('cursor_moved');
      await bump;
    } finally {
      await other.end().catch(() => undefined);
    }
    expect(blocked).toBe(true);
  });
});

describe('RFC Message-ID collisions', () => {
  const deliver = async (w: MailWorld, ...messages: ReturnType<typeof fixtureMessage>[]) => {
    const context = w.systemContext(w.alpha.workspace.workspaceId);
    const log = recordingMailLog();
    w.alpha.messages.push(...messages);
    const report = await asJob(w, async () =>
      await runMailSync(context, { ...w.syncDeps(w.alpha), log }, { mailboxId: w.alpha.mailboxId }),
    );
    return { report, log };
  };

  const rowsOf = async (w: MailWorld) =>
    (
      await w.database.session.query<{ provider_message_id: string; rfc_message_id: string | null; direction: string }>(
        'SELECT provider_message_id, rfc_message_id, direction FROM mail_messages WHERE mailbox_id = $1 ORDER BY provider_message_id',
        [w.alpha.mailboxId],
      )
    ).rows;

  it('a proven duplicate — same direction, From, Subject and Date — is the recorded message, and no effect runs again', async () => {
    world = await createMailWorld();
    const w = world;
    await completeBaseline(w, w.alpha);
    const first = await deliver(
      w,
      fixtureMessage({ id: 'dup1', historyId: '1011', from: PROSPECT, to: w.alpha.address, messageId: 'shared@x.test', body: 'Please stop emailing me.' }),
    );
    expect(first.report.suppressionsRecorded).toBe(2);
    const journal = w.journal.appended.length;
    const second = await deliver(
      w,
      fixtureMessage({ id: 'dup2', historyId: '1012', from: PROSPECT, to: w.alpha.address, messageId: 'shared@x.test', body: 'Please stop emailing me.' }),
    );
    expect(second.report.outcome).toBe('synced');
    expect(second.report.duplicateRfcId).toBe(1);
    expect(second.report.rfcIdConflicts).toBe(0);
    expect(second.report.messagesRecorded).toBe(0);
    expect(second.report.suppressionsRecorded).toBe(0);
    expect(w.journal.appended.length).toBe(journal);
    expect(await rowsOf(w)).toEqual([{ provider_message_id: 'dup1', rfc_message_id: 'shared@x.test', direction: 'incoming' }]);
  });

  const expectConflict = async (
    w: MailWorld,
    outcome: Awaited<ReturnType<typeof deliver>>,
    ids: { readonly first: string; readonly second: string },
  ): Promise<void> => {
    expect(outcome.report.outcome).toBe('synced');
    expect(outcome.report.rfcIdConflicts).toBe(1);
    expect(outcome.report.duplicateRfcId).toBe(0);
    const rows = await rowsOf(w);
    expect(rows.find(row => row.provider_message_id === ids.first)?.rfc_message_id).toBe('shared@x.test');
    expect(rows.find(row => row.provider_message_id === ids.second)?.rfc_message_id).toBeNull();
    const line = outcome.log.lines.find(entry => entry.event === 'mail.rfc_id_conflict');
    expect(line?.fields).toEqual({
      mailboxId: w.alpha.mailboxId,
      providerMessageId: ids.second,
      existingProviderMessageId: ids.first,
      rfcMessageId: 'shared@x.test',
    });
  };

  it('a changed sender is a conflict: recorded without the id, logged, counted', async () => {
    world = await createMailWorld();
    const w = world;
    await completeBaseline(w, w.alpha);
    await deliver(w, fixtureMessage({ id: 'sender1', historyId: '1011', from: STRANGER, to: w.alpha.address, messageId: 'shared@x.test' }));
    const outcome = await deliver(
      w,
      fixtureMessage({ id: 'sender2', historyId: '1012', from: 'another@elsewhere.example.test', to: w.alpha.address, messageId: 'shared@x.test' }),
    );
    await expectConflict(w, outcome, { first: 'sender1', second: 'sender2' });
  });

  it('a changed direction is a conflict, and the new row keeps its own direction', async () => {
    world = await createMailWorld();
    const w = world;
    await completeBaseline(w, w.alpha);
    await deliver(
      w,
      fixtureMessage({ id: 'dir1', historyId: '1011', from: w.alpha.address, to: STRANGER, messageId: 'shared@x.test', labelIds: ['SENT'] }),
    );
    const outcome = await deliver(w, fixtureMessage({ id: 'dir2', historyId: '1012', from: w.alpha.address, to: STRANGER, messageId: 'shared@x.test' }));
    await expectConflict(w, outcome, { first: 'dir1', second: 'dir2' });
    expect((await rowsOf(w)).map(row => row.direction)).toEqual(['outgoing', 'incoming']);
  });

  it('changed content is a conflict: another Subject, or the same Subject with another Date', async () => {
    world = await createMailWorld();
    const w = world;
    await completeBaseline(w, w.alpha);
    await deliver(w, fixtureMessage({ id: 'content1', historyId: '1011', from: STRANGER, to: w.alpha.address, messageId: 'shared@x.test', subject: 'One' }));
    const subject = await deliver(
      w,
      fixtureMessage({ id: 'content2', historyId: '1012', from: STRANGER, to: w.alpha.address, messageId: 'shared@x.test', subject: 'Two' }),
    );
    await expectConflict(w, subject, { first: 'content1', second: 'content2' });
    const date = await deliver(
      w,
      fixtureMessage({
        id: 'content3',
        historyId: '1013',
        from: STRANGER,
        to: w.alpha.address,
        messageId: 'shared@x.test',
        subject: 'One',
        internalDateEpochMilliseconds: Date.parse('2026-09-10T15:00:00Z'),
      }),
    );
    expect(date.report.rfcIdConflicts).toBe(1);
    expect(date.report.duplicateRfcId).toBe(0);
  });

  it('an incoming opt-out colliding with an outgoing message id is classified and suppressed', async () => {
    world = await createMailWorld();
    const w = world;
    await completeBaseline(w, w.alpha);
    const context = w.systemContext(w.alpha.workspace.workspaceId);
    await deliver(
      w,
      fixtureMessage({ id: 'sent1', historyId: '1011', from: w.alpha.address, to: PROSPECT, messageId: 'shared@x.test', labelIds: ['SENT'] }),
    );
    const outcome = await deliver(
      w,
      fixtureMessage({ id: 'optout2', historyId: '1012', from: PROSPECT, to: w.alpha.address, messageId: 'shared@x.test', body: 'Please stop emailing me.' }),
    );
    await expectConflict(w, outcome, { first: 'sent1', second: 'optout2' });
    expect(outcome.report.suppressionsRecorded).toBe(2);
    expect(await isSuppressed(context, { scope: 'handle', canonicalKey: PROSPECT })).not.toBeNull();
    const { rows } = await w.database.session.query<{ class: string }>(
      `SELECT c.class FROM mail_message_classifications AS c
         JOIN mail_messages AS m ON m.workspace_id = c.workspace_id AND m.id = c.mail_message_id
        WHERE m.mailbox_id = $1 AND m.provider_message_id = 'optout2'`,
      [w.alpha.mailboxId],
    );
    expect(rows).toHaveLength(1);
  });
});

describe('watch fencing', () => {
  const watchDeps = (w: MailWorld, gmail: GmailClient, log = recordingMailLog()) => ({
    gmail,
    oauth: w.syncDeps(w.alpha).oauth,
    cipher: w.cipher,
    topicName: TEST_TOPIC_NAME,
    log,
  });

  it('a registration names the watched address', async () => {
    world = await createMailWorld();
    const w = world;
    const context = w.systemContext(w.alpha.workspace.workspaceId);
    const log = recordingMailLog();
    const report = await asJob(w, async () => await renewWatch(context, watchDeps(w, w.alpha.gmail, log), { mailboxId: w.alpha.mailboxId, generation: 1 }));
    expect(report.outcome).toBe('renewed');
    expect(log.lines.find(line => line.event === 'mail.watch_registered')?.fields['watchedAddress']).toBe(w.alpha.address);
  });

  it('a renewal that read generation g inserts no current watch when the mailbox moves to g+1 before it commits', async () => {
    world = await createMailWorld();
    const w = world;
    const context = w.systemContext(w.alpha.workspace.workspaceId);
    const other = await otherConnection(w);
    try {
      const gmail: GmailClient = {
        ...w.alpha.gmail,
        watch: async (...args) => {
          const registered = await w.alpha.gmail.watch(...args);
          await other.query('UPDATE mailboxes SET generation = generation + 1 WHERE id = $1', [w.alpha.mailboxId]);
          return registered;
        },
      };
      await expect(
        asJob(w, async () => await renewWatch(context, watchDeps(w, gmail), { mailboxId: w.alpha.mailboxId, generation: 1 })),
      ).rejects.toBeInstanceOf(StaleMailboxGeneration);
    } finally {
      await other.end().catch(() => undefined);
    }
    expect(await readCurrentWatch(context, w.alpha.mailboxId)).toBeNull();
    const due = await listWatchesDue(w.database.session, new Date().toISOString());
    expect(due.find(entry => entry.mailboxId === w.alpha.mailboxId)).toMatchObject({ generation: 1, mailboxGeneration: 2 });
  });
});

describe('generation-keyed jobs', () => {
  it('a dead mail.sync for generation g does not block a sync for g+1', async () => {
    world = await createMailWorld();
    const w = world;
    const workspaceId = w.alpha.workspace.workspaceId;
    const session = w.database.session;
    const first = await coalesceMailSync(session, { workspaceId, mailboxId: w.alpha.mailboxId });
    await session.query("UPDATE jobs SET state = 'dead', dead_at = now() WHERE id = $1", [first.jobId]);
    // Still generation g: the dead row absorbs the ask, as 13.2 wants.
    expect((await coalesceMailSync(session, { workspaceId, mailboxId: w.alpha.mailboxId })).outcome).toBe('dead');

    await session.query('UPDATE mailboxes SET generation = generation + 1 WHERE id = $1', [w.alpha.mailboxId]);
    const next = await coalesceMailSync(session, { workspaceId, mailboxId: w.alpha.mailboxId });
    expect(next.outcome).toBe('enqueued');
    expect(next.jobId).not.toBe(first.jobId);
    const { rows } = await session.query<{ idempotency_key: string; state: string }>(
      "SELECT idempotency_key, state FROM jobs WHERE workspace_id = $1 AND kind = 'mail.sync' ORDER BY idempotency_key",
      [workspaceId],
    );
    expect(rows).toEqual([
      { idempotency_key: `mail-sync:${w.alpha.mailboxId}:1`, state: 'dead' },
      { idempotency_key: `mail-sync:${w.alpha.mailboxId}:2`, state: 'queued' },
    ]);
  });
});
