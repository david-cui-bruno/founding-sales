import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { releaseDrainActive, readReleaseDrain } from '@fss/domain/release/drain.ts';
import {
  CLUSTER_URL_ENVIRONMENT_VARIABLE,
  createTestDatabase,
  type TestDatabase,
} from '@fss/domain/db/testing/testDatabase.ts';
import { researchFirmJobHandler } from '../src/handlers/research.ts';
import { main } from '../src/tools/fss.ts';
import { COMMAND_DEPENDENCIES, parseFssCommand } from '../src/tools/fss/commands.ts';
import { CHUNKED_JOB_KINDS } from '../src/tools/fss/releaseIdle.ts';

/**
 * `fss admin release idle-check` and `release drain on|off` on a real database (slice A4).
 *
 * ## The vacuous-pass traps, named
 *
 * **An idle answer over an empty database proves nothing**, so every "busy" case is
 * paired with the same fixture one row away from busy (a command six minutes old, an
 * expired lease, a chunked job, a call that ended) that must read idle. A check that
 * answered `idle: false` to everything would pass the busy cases and fail those.
 *
 * **Telephony.** `call_sessions` does not exist until migration 0027. The "busy" case
 * creates a stand-in table with the two columns the check reads, and drops it after, so
 * the same code is shown to work on both sides of the migration.
 */

let database: TestDatabase;
let url = '';
let workspaceId = '';
let deviceId = '';

async function one(sql: string, values: readonly unknown[] = []): Promise<string> {
  const { rows } = await database.session.query<{ id: string }>(sql, values);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`the fixture returned no row: ${sql.slice(0, 60)}`);
  return id;
}

async function run(argv: readonly string[]): Promise<{ readonly code: number; readonly stdout: string }> {
  const printed: string[] = [];
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
    printed.push(String(chunk));
    return true;
  });
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const code = await main(argv, { DATABASE_URL: url });
    return { code, stdout: printed.join('') };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

interface IdleAnswer {
  readonly idle: boolean;
  readonly reasons: readonly string[];
  readonly observedAt: string;
  readonly details: {
    readonly telephony: { readonly state: string; readonly inProgress: number };
    readonly recentCommands: { readonly count: number };
    readonly uninterruptibleJobs: { readonly count: number; readonly byKind: readonly { readonly kind: string; readonly count: number }[] };
    readonly releaseDrain: { readonly active: boolean };
  };
}

async function idleCheck(): Promise<IdleAnswer> {
  const { code, stdout } = await run(['admin', 'release', 'idle-check']);
  expect(code, stdout).toBe(0);
  return JSON.parse(stdout) as IdleAnswer;
}

let sequence = 0;
async function receipt(ageSeconds: number): Promise<void> {
  sequence += 1;
  await database.session.query(
    `INSERT INTO command_receipts (workspace_id, device_id, command_id, command_kind, payload_hash, result_status, created_at)
     VALUES ($1, $2, $3, 'update_setting', repeat('a', 64), 'accepted', now() - make_interval(secs => $4::int))`,
    [workspaceId, deviceId, `idle-${String(sequence)}`, ageSeconds],
  );
}

async function job(kind: string, state: 'queued' | 'running', leaseSeconds: number): Promise<void> {
  sequence += 1;
  if (state === 'queued') {
    await database.session.query(
      `INSERT INTO jobs (workspace_id, kind, payload, idempotency_key, state) VALUES ($1, $2, '{}'::jsonb, $3, 'queued')`,
      [workspaceId, kind, `idle-job-${String(sequence)}`],
    );
    return;
  }
  await database.session.query(
    `INSERT INTO jobs (workspace_id, kind, payload, idempotency_key, state, lease_owner, lease_expires_at)
     VALUES ($1, $2, '{}'::jsonb, $3, 'running', 'worker-test', now() + make_interval(secs => $4::int))`,
    [workspaceId, kind, `idle-job-${String(sequence)}`, leaseSeconds],
  );
}

beforeAll(async () => {
  database = await createTestDatabase();
  const named = await database.session.query<{ name: string }>('SELECT current_database() AS name');
  const clusterUrl = new URL(process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE] ?? '');
  clusterUrl.pathname = `/${named.rows[0]?.name ?? ''}`;
  url = clusterUrl.toString();

  workspaceId = await one("INSERT INTO workspaces (slug, display_name) VALUES ('idle', 'Idle') RETURNING id");
  const userId = await one(
    "INSERT INTO users (google_sub, email, display_name) VALUES ('idle-sub', 'idle@example.test', 'Idle') RETURNING id",
  );
  await database.session.query("INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')", [
    workspaceId,
    userId,
  ]);
  deviceId = await one(
    `INSERT INTO devices (workspace_id, user_id, device_label, secret_hash, client_version)
     VALUES ($1, $2, 'Idle Mac', repeat('a', 64), '1.0.20') RETURNING id`,
    [workspaceId, userId],
  );
}, 120_000);

beforeEach(async () => {
  await database.session.query('DELETE FROM command_receipts');
  await database.session.query('DELETE FROM jobs');
  await database.session.query('DROP TABLE IF EXISTS call_sessions');
});

afterAll(async () => {
  await database.drop();
});

describe('fss admin release idle-check', () => {
  it('is idle on an empty system, and says telephony is not installed yet', async () => {
    const answer = await idleCheck();
    expect(answer).toMatchObject({
      idle: true,
      reasons: [],
      details: { telephony: { state: 'not_installed', inProgress: 0 }, recentCommands: { count: 0 }, uninterruptibleJobs: { count: 0 } },
    });
    expect(Number.isNaN(Date.parse(answer.observedAt))).toBe(false);
  });

  it('is busy because of a command in the last five minutes, and idle when the newest is older', async () => {
    await receipt(6 * 60);
    expect((await idleCheck()).idle, 'a command six minutes old counted').toBe(true);
    await receipt(30);
    const busy = await idleCheck();
    expect(busy.idle).toBe(false);
    expect(busy.details.recentCommands.count).toBe(1);
    expect(busy.reasons.join(' ')).toContain('API command');
  });

  it('is busy because of a running job that cannot be interrupted', async () => {
    await job('mail.sync', 'running', 60);
    const busy = await idleCheck();
    expect(busy.idle).toBe(false);
    expect(busy.details.uninterruptibleJobs.byKind).toEqual([expect.objectContaining({ kind: 'mail.sync', count: 1 })]);
    expect(busy.reasons.join(' ')).toContain('mail.sync');
  });

  it('is not busy with only queued jobs, an expired lease, or a running chunked job', async () => {
    await job('mail.sync', 'queued', 0);
    await job('sequence.action', 'queued', 0);
    await job('mail.sync', 'running', -30);
    await job('research.firm', 'running', 60);
    expect(await idleCheck()).toMatchObject({ idle: true, reasons: [] });
    // The positive control: the same table, one live non-chunked lease, and it reads busy.
    await job('sequence.action', 'running', 60);
    expect((await idleCheck()).idle).toBe(false);
  });

  it('reads call_sessions when it exists: busy for a live call, idle for an ended or stale one', async () => {
    await database.session.query('CREATE TABLE call_sessions (status text NOT NULL, started_at timestamptz NOT NULL)');
    expect(await idleCheck()).toMatchObject({ idle: true, details: { telephony: { state: 'installed', inProgress: 0 } } });
    await database.session.query(
      `INSERT INTO call_sessions (status, started_at)
       VALUES ('ended', now() - interval '10 minutes'), ('in_progress', now() - interval '5 hours')`,
    );
    expect((await idleCheck()).idle, 'an ended call and a five-hour-old leftover counted').toBe(true);
    await database.session.query("INSERT INTO call_sessions (status, started_at) VALUES ('in_progress', now() - interval '3 minutes')");
    const busy = await idleCheck();
    expect(busy.idle).toBe(false);
    expect(busy.details.telephony).toMatchObject({ state: 'installed', inProgress: 1 });
    expect(busy.reasons.join(' ')).toContain('call');
  });

  it('writes nothing: it is one READ ONLY transaction', async () => {
    const before = await database.session.query<{ count: string }>('SELECT count(*)::text AS count FROM audit_events');
    await idleCheck();
    const after = await database.session.query<{ count: string }>('SELECT count(*)::text AS count FROM audit_events');
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it('keeps its chunked-kind list equal to the handlers that declare themselves chunked', () => {
    const chunked = [researchFirmJobHandler({} as Parameters<typeof researchFirmJobHandler>[0])].filter(h => h.chunked === true).map(h => h.kind);
    expect([...CHUNKED_JOB_KINDS].sort()).toEqual([...chunked].sort());
  });

  it('declares itself database-only, and the grammar takes --minutes only on drain on', () => {
    for (const name of ['release idle-check', 'release drain on', 'release drain off']) expect(COMMAND_DEPENDENCIES[name]).toBe('database');
    expect(parseFssCommand(['admin', 'release', 'drain', 'on', '--minutes', '5'])).toMatchObject({ ok: true });
    expect(parseFssCommand(['admin', 'release', 'drain', 'off', '--minutes', '5'])).toMatchObject({ ok: false, reason: 'flag_unknown' });
    expect(parseFssCommand(['admin', 'release', 'idle-check'])).toMatchObject({ ok: true });
  });
});

describe('fss admin release drain', () => {
  // audit_events is append-only, so a drain test starts from "off" by writing an off.
  beforeEach(async () => {
    await run(['admin', 'release', 'drain', 'off']);
  });

  it('turns on for twenty minutes by default, is seen by releaseDrainActive, and turns off', async () => {
    expect(await releaseDrainActive(database.session)).toBe(false);
    const on = await run(['admin', 'release', 'drain', 'on']);
    expect(on.code, on.stdout).toBe(0);
    expect(JSON.parse(on.stdout)).toMatchObject({ drain: 'on', minutes: 20, capped: false, active: true });
    expect(await releaseDrainActive(database.session)).toBe(true);
    const until = (await readReleaseDrain(database.session)).until;
    const minutesAhead = (Date.parse(until ?? '') - Date.now()) / 60_000;
    expect(minutesAhead).toBeGreaterThan(19);
    expect(minutesAhead).toBeLessThanOrEqual(20);
    expect((await idleCheck()).details.releaseDrain.active).toBe(true);

    const off = await run(['admin', 'release', 'drain', 'off']);
    expect(JSON.parse(off.stdout)).toMatchObject({ drain: 'off', active: false });
    expect(await releaseDrainActive(database.session)).toBe(false);
    // Off when already off is not an error.
    expect((await run(['admin', 'release', 'drain', 'off'])).code).toBe(0);
  });

  it('caps --minutes at sixty and refuses what is not a whole number of minutes', async () => {
    const capped = await run(['admin', 'release', 'drain', 'on', '--minutes', '90']);
    expect(JSON.parse(capped.stdout)).toMatchObject({ minutes: 60, capped: true });
    for (const bad of ['0', 'abc', '1.5', '-3']) {
      const refused = await run(['admin', 'release', 'drain', 'on', '--minutes', bad]);
      expect(refused.code, `--minutes ${bad}`).not.toBe(0);
    }
  });

  it('lapses by itself, and the audit row names the action and the instant', async () => {
    await database.session.query(
      `INSERT INTO audit_events (workspace_id, actor_kind, action, subject_kind, subject_id, detail)
       VALUES ($1, 'system', 'release.drain_on', 'release', 'drain', jsonb_build_object('until', to_char(now() - interval '1 minute', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))`,
      [workspaceId],
    );
    expect(await releaseDrainActive(database.session), 'a lapsed drain was still active').toBe(false);
    await run(['admin', 'release', 'drain', 'on', '--minutes', '5']);
    expect(await releaseDrainActive(database.session)).toBe(true);
    const row = await database.session.query<{ action: string; until: string }>(
      `SELECT action, detail->>'until' AS until FROM audit_events WHERE action = 'release.drain_on' ORDER BY occurred_at DESC LIMIT 1`,
    );
    expect(row.rows[0]?.action).toBe('release.drain_on');
    expect(Date.parse(row.rows[0]?.until ?? '')).toBeGreaterThan(Date.now());
  });

  it('never touches sending_enabled', async () => {
    const before = await database.session.query<{ count: string }>('SELECT count(*)::text AS count FROM workspace_settings');
    await run(['admin', 'release', 'drain', 'on']);
    await run(['admin', 'release', 'drain', 'off']);
    const after = await database.session.query<{ count: string }>('SELECT count(*)::text AS count FROM workspace_settings');
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });
});
