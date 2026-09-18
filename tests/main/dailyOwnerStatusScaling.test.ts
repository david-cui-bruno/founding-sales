import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openDatabase, closeDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { createDomainServices } from '../../src/main/domain/createDomainServices';
import { AccountRepository } from '../../src/main/domain/accounts/accountRepository';
import { DelegationRepository } from '../../src/main/delegation/delegationRepository';
import { buildDailySnapshot } from '../../src/main/domain/today/dailyProjection';
import type { DailySnapshot } from '../../src/shared/contracts/dailyContract';

const now = '2026-09-15T12:00:00.000Z';
const workspaceId = 'fictional-owner-scaling';
const pendingSql = 'SELECT command_json FROM delegated_commands WHERE workspace_id=? ORDER BY created_at,command_id';

// Optional audit capture compares the complete public output, including revision,
// to the unmodified implementation on this deterministic encrypted fixture.
function evidence(label: string, snapshot: DailySnapshot, scans: number) {
  console.info(`daily-owner-scaling ${label}: pending SQL scans=${scans}`);
  const directory = process.env.DAILY_OWNER_EVIDENCE_DIR;
  if (!directory) return;
  const path = join(directory, `${label}.json`);
  if (process.env.DAILY_OWNER_EVIDENCE_MODE === 'baseline') {
    writeFileSync(path, JSON.stringify({ snapshot, scans }, null, 2));
  } else if (process.env.DAILY_OWNER_EVIDENCE_MODE === 'compare') {
    const baseline = JSON.parse(readFileSync(path, 'utf8')) as { snapshot: DailySnapshot; scans: number };
    expect(snapshot).toEqual(baseline.snapshot);
    console.info(`daily-owner-scaling ${label}: full baseline equality, scans ${baseline.scans} -> ${scans}`);
  }
}

async function fixture(count = 4, scope: string | undefined = workspaceId) {
  const directory = mkdtempSync(join(process.env.JCODE_SCRATCH_DIR ?? tmpdir(), 'daily-owner-scaling-'));
  const key = { bytes: Buffer.alloc(32, 0x43), version: 1 as const };
  const db = openDatabase({ path: join(directory, 'fictional.sqlite3'), key });
  try {
    await migrateToLatest(db, { backupDirectory: join(directory, 'backups'), workspaceKey: key });
    const clock = { now: () => now };
    let nextId = 0;
    const accounts = new AccountRepository({ database: db, clock, ids: { next: () => `fictional-${String(++nextId).padStart(4, '0')}` } });
    const delegation = new DelegationRepository({ database: db, workspaceId, clock });
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const account = accounts.create({ commandId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, name: `Fictional PM ${i}`, domain: 'example.invalid' });
      ids.push(account.id);
      delegation.initializeLocalAuthority(account.id);
    }
    db.raw.prepare('UPDATE meeting_first_call_settings SET new_call_slots=0').run();
    const queue = (commandId: string, accountId: string, expectedVersion = 0) => delegation.queueCommand({
      commandId, workspaceId, accountId, expectedAuthorityGeneration: 0, expectedVersion,
      kind: 'pause', payload: { reason: 'Fictional operator pause' },
    });
    // Deliberate on-disk corruption only in this disposable fixture. Restore the guard before reading.
    const mutateCommands = (sql: string, ...args: string[]) => db.raw.transaction(() => {
      const trigger = db.raw.prepare("SELECT sql FROM sqlite_master WHERE name='delegated_commands_no_update'").get() as { sql: string };
      db.raw.exec('DROP TRIGGER delegated_commands_no_update');
      db.raw.prepare(sql).run(...args);
      db.raw.exec(trigger.sql);
    })();
    const services = createDomainServices({ database: db, clock,
      ids: { next: () => { throw Error('daily read allocated ID'); } }, expectedWorkspaceId: scope });
    let scans = 0;
    const trace: string[] = [];
    const prepare = db.raw.prepare.bind(db.raw);
    // Observe real native statement execution. No repository or query result is replaced.
    const spy = vi.spyOn(db.raw, 'prepare').mockImplementation((sql: string) => {
      const statement = prepare(sql);
      if (sql === pendingSql) {
        const all = statement.all.bind(statement);
        vi.spyOn(statement, 'all').mockImplementation((...args: unknown[]) => {
          scans++; trace.push('pending');
          return all(...args);
        });
      }
      if (sql.startsWith('SELECT event_json FROM delegated_applied_events WHERE workspace_id=')) {
        const get = statement.get.bind(statement);
        vi.spyOn(statement, 'get').mockImplementation((...args: unknown[]) => {
          trace.push(`status:${String(args[1])}`);
          return get(...args);
        });
      }
      if (sql === 'SELECT * FROM delegated_authorities WHERE account_id=?') {
        const get = statement.get.bind(statement);
        vi.spyOn(statement, 'get').mockImplementation((...args: unknown[]) => {
          trace.push(`authority:${String(args[0])}`);
          return get(...args);
        });
      }
      return statement;
    });
    const read = (label: string) => {
      scans = 0; trace.length = 0;
      const changes = prepare('SELECT total_changes() AS n').get();
      const before = prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all();
      // query_only makes accidental writes fail even if later rolled back.
      db.raw.pragma('query_only=ON');
      let snapshot: DailySnapshot;
      try { snapshot = services.daily.get(); } finally { db.raw.pragma('query_only=OFF'); }
      expect(prepare('SELECT total_changes() AS n').get()).toEqual(changes);
      expect(prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all()).toEqual(before);
      expect(db.raw.inTransaction).toBe(false);
      evidence(label, snapshot, scans);
      return { snapshot, scans, trace: [...trace] };
    };
    const emptyWeek = (from: string, to: string) => ({ from, to, mornings: 0, firms: 0, callsPlaced: 0,
      outcomes: { connected: 0, interested: 0, not_interested: 0, gatekeeper: 0, voicemail: 0, no_answer: 0, busy: 0, wrong_number: 0 },
      notes: 0, callbacksPromised: 0, callbacksKept: 0, drafts: 0, replies: 0, holds: [] });
    const expected = (ownerStatus: DailySnapshot['ownerStatus'], issues: DailySnapshot['issues'] = []) => buildDailySnapshot({
      workspaceId, generatedAt: now, workflowMode: 'legacy',
      accounts: ids.map(id => accounts.snapshot(id, now)).sort((a, b) => a.account.id.localeCompare(b.account.id)),
      calls: { accountIds: [], workloadConflict: false }, callSettings: { newCallSlots: 0, totalCallCapacity: null },
      // Derived from callSettings and outside the revision hash (D2 default allocation).
      allocation: { newCallSlots: 0, source: 'configured' },
      approvals: [], meetings: [], campaigns: [], ownerStatus, transport: [], issues,
      // Derived too, and also outside the revision hash. A workspace with no recorded work reports
      // zeros for both founder-local weeks rather than omitting them, and `now` is a Tuesday, so
      // this week is Monday 14 to Sunday 20 September in America/New_York.
      usage: { timezone: 'America/New_York', thisWeek: emptyWeek('2026-09-14', '2026-09-20'), lastWeek: emptyWeek('2026-09-07', '2026-09-13') },
    });
    const owner = (accountId: string, pendingCommands: DailySnapshot['ownerStatus'][number]['pendingCommands'] = []) => ({
      accountId, authority: { accountId, owner: 'local' as const, generation: 0, state: 'local' as const },
      executionVersion: 0, pendingCommands, status: pendingCommands.length ? 'pending' as const : 'unknown' as const,
    });
    return { db, ids, queue, delegation, services, read, expected, owner, mutateCommands,
      close() { spy.mockRestore(); closeDatabase(db); key.bytes.fill(0); rmSync(directory, { recursive: true, force: true }); } };
  } catch (error) { closeDatabase(db); key.bytes.fill(0); rmSync(directory, { recursive: true, force: true }); throw error; }
}

describe('public daily.get owner history scaling on real encrypted SQLite', () => {
  it.each([1, 4, 12])('scans once for %i accounts, preserving full output, SQL pending order, and fresh reads', async count => {
    const f = await fixture(count);
    try {
      // Insert in reverse lexical order with tied times. Include rejected history.
      const z = f.queue('pending-z', f.ids[0]!);
      f.queue('rejected-history', f.ids[count - 1]!, 999);
      const a = f.queue('pending-a', f.ids[0]!);
      const last = count > 1 ? f.queue('pending-middle', f.ids[count - 1]!) : null;
      const owners = f.ids.map((id, i) => f.owner(id, i === 0 ? [a, z] : i === count - 1 && last ? [last] : []));
      const first = f.read(`valid-${count}`);
      expect(first.snapshot).toEqual(f.expected(owners));
      const second = f.read(`repeat-${count}`);
      expect(second.snapshot).toEqual(first.snapshot);
      const fresh = f.queue('pending-b', f.ids[0]!);
      owners[0] = f.owner(f.ids[0]!, [a, fresh, z]);
      const third = f.read(`fresh-${count}`);
      expect(third.snapshot).toEqual(f.expected(owners));
      expect(third.snapshot.revision).not.toBe(first.snapshot.revision);
      expect([first.scans, second.scans, third.scans]).toEqual([1, 1, 1]);
      // H history status reads plus P per-account status reads, not cached receipts.
      expect(first.trace.filter(step => step.startsWith('status:'))).toHaveLength(count === 1 ? 5 : 7);
      expect(third.trace.filter(step => step.startsWith('status:'))).toHaveLength(count === 1 ? 7 : 9);
    } finally { f.close(); }
  });

  it.each(['first', 'middle', 'last', 'receipt'] as const)('memoizes whole-history %s failure, not a filtered success, and retries next invocation', async corruption => {
    const f = await fixture();
    try {
      f.queue('a-good', f.ids[0]!);
      const badId = corruption === 'first' ? '0-bad' : corruption === 'middle' ? 'm-bad' : 'z-bad';
      // Same workspace but outside the displayed account set: it must still poison every owner read.
      f.db.raw.pragma('foreign_keys=OFF');
      f.queue(badId, 'undisplayed-fictional-account');
      f.db.raw.pragma('foreign_keys=ON');
      f.queue('y-good', f.ids[1]!);
      const column = corruption === 'receipt' ? 'receipt_json' : 'command_json';
      const original = f.db.raw.prepare(`SELECT ${column} AS value FROM delegated_commands WHERE command_id=?`).get(badId) as { value: string };
      f.mutateCommands(`UPDATE delegated_commands SET ${column}='{}' WHERE command_id=?`, badId);
      const broken = f.read(`invalid-${corruption}`);
      expect(broken.snapshot).toEqual(f.expected([], [{ code: 'invalid_local_record', count: 4 }]));
      f.mutateCommands(`UPDATE delegated_commands SET ${column}=? WHERE command_id=?`, original.value, badId);
      const repaired = f.read(`repaired-${corruption}`);
      expect(repaired.snapshot.ownerStatus).toHaveLength(4);
      expect(repaired.snapshot.issues).toEqual([]);
      expect([broken.scans, repaired.scans]).toEqual([1, 1]);
    } finally { f.close(); }
  });

  it.each([1, 4])('keeps lazy authority-first failure for %i failed authorities', async failed => {
    const f = await fixture();
    try {
      f.queue('pending-a', f.ids[3]!);
      // Deliberately corrupt only this fixture. Restore native checks before the read.
      f.db.raw.pragma('ignore_check_constraints=ON');
      for (const id of f.ids.slice(0, failed)) f.db.raw.prepare('UPDATE delegated_authorities SET generation=-1 WHERE account_id=?').run(id);
      f.db.raw.pragma('ignore_check_constraints=OFF');
      const result = f.read(`authority-${failed}`);
      expect(result.snapshot.ownerStatus.map(o => o.accountId)).toEqual(f.ids.slice(failed));
      expect(result.snapshot.issues).toEqual([{ code: 'invalid_local_record', count: failed }]);
      expect(result.trace.slice(0, failed)).toEqual(f.ids.slice(0, failed).map(id => `authority:${id}`));
      if (failed < 4) expect(result.trace[failed]).toBe(`authority:${f.ids[failed]}`);
      expect(result.scans).toBe(failed === 4 ? 0 : 1);
    } finally { f.close(); }
  });

  it('preserves applied worker receipts, owner states, execution versions, and absent authority', async () => {
    const f = await fixture();
    try {
      const accountId = f.ids[0]!;
      const commandId = 'delegate-fictional';
      f.delegation.queueCommand({ commandId, workspaceId, accountId, expectedAuthorityGeneration: 0,
        expectedVersion: 0, kind: 'delegate', payload: { delegationId: 'fictional-delegation', approvedAt: now } });
      const authority = { accountId, owner: 'worker' as const, generation: 1, state: 'active' as const };
      const receipt = { commandId, status: 'applied' as const, authorityGeneration: 1, aggregateVersion: 1, reason: null as null };
      expect(f.delegation.applyWorkerEvent({ id: 'fictional-applied-event', workspaceId, accountId,
        authorityGeneration: 1, aggregateVersion: 1, kind: 'authority.changed', payload: { authority, receipt } })).toBe('applied');
      f.db.raw.prepare('DELETE FROM delegated_authorities WHERE account_id=?').run(f.ids[2]!);
      const owners = f.ids.map(id => f.owner(id)) as DailySnapshot['ownerStatus'];
      owners[0] = { accountId, authority, executionVersion: 1, pendingCommands: [], status: 'owner_applied' };
      owners[2] = { accountId: f.ids[2]!, authority: null, executionVersion: null, pendingCommands: [], status: 'unknown' };
      const applied = f.read('worker-applied');
      expect(applied.snapshot).toEqual(f.expected(owners));
      const pending = f.delegation.queueCommand({ commandId: 'worker-pause', workspaceId, accountId,
        expectedAuthorityGeneration: 1, expectedVersion: 1, kind: 'pause', payload: { reason: 'Fictional pause' } });
      owners[0] = { ...owners[0]!, pendingCommands: [pending], status: 'pending' };
      const queued = f.read('worker-pending');
      expect(queued.snapshot).toEqual(f.expected(owners));
      expect([applied.scans, queued.scans]).toEqual([1, 1]);
    } finally { f.close(); }
  });

  it('retains created-at ordering ahead of command ID ordering', async () => {
    const f = await fixture();
    try {
      const a = f.queue('a-later', f.ids[0]!);
      const z = f.queue('z-earlier', f.ids[0]!);
      f.mutateCommands('UPDATE delegated_commands SET created_at=? WHERE command_id=?', '2026-09-14T12:00:00.000Z', 'z-earlier');
      const result = f.read('created-at-order');
      expect(result.snapshot).toEqual(f.expected(f.ids.map((id, i) => f.owner(id, i === 0 ? [z, a] : []))));
      expect(result.scans).toBe(1);
    } finally { f.close(); }
  });

  it('memoizes an empty pending snapshot without dropping owners', async () => {
    const f = await fixture();
    try {
      const result = f.read('empty-history');
      expect(result.snapshot).toEqual(f.expected(f.ids.map(id => f.owner(id))));
      expect(result.scans).toBe(1);
    } finally { f.close(); }
  });

  it('preserves one issue per account when authority and history failures coexist', async () => {
    const f = await fixture();
    try {
      f.queue('bad-history', f.ids[2]!);
      f.mutateCommands("UPDATE delegated_commands SET command_json='{}'");
      f.db.raw.pragma('ignore_check_constraints=ON');
      f.db.raw.prepare('UPDATE delegated_authorities SET generation=-1 WHERE account_id=?').run(f.ids[0]!);
      f.db.raw.pragma('ignore_check_constraints=OFF');
      const result = f.read('authority-and-history');
      expect(result.snapshot).toEqual(f.expected([], [{ code: 'invalid_local_record', count: 4 }]));
      expect(result.trace.slice(0, 3)).toEqual([`authority:${f.ids[0]}`, `authority:${f.ids[1]}`, 'pending']);
      expect(result.scans).toBe(1);
    } finally { f.close(); }
  });

  it('does not inspect corrupt history with zero accounts', async () => {
    const f = await fixture(0);
    try {
      f.db.raw.pragma('foreign_keys=OFF');
      f.queue('bad-history', 'undisplayed-fictional-account');
      f.db.raw.pragma('foreign_keys=ON');
      f.mutateCommands("UPDATE delegated_commands SET command_json='{}'");
      const result = f.read('zero');
      expect(result.snapshot).toEqual(f.expected([]));
      expect(result.scans).toBe(0);
    } finally { f.close(); }
  });

  it('excludes foreign ownership and foreign workspace history without changing scope issues', async () => {
    const f = await fixture();
    try {
      f.queue('foreign-history', f.ids[3]!);
      f.db.raw.prepare('UPDATE delegated_authorities SET workspace_id=? WHERE account_id=?').run('foreign-workspace', f.ids[3]!);
      f.mutateCommands("UPDATE delegated_commands SET workspace_id='foreign-workspace',command_json='{}'");
      f.db.raw.prepare('INSERT INTO delegated_meetings VALUES(?,?,?,?,?,?,?,?,?)').run(workspaceId, f.ids[3]!, 'foreign-meeting', 'google_calendar', 'provider-fictional', 1, 'held', '{}', now);
      const result = f.read('scope');
      expect(result.snapshot.accounts.map(a => a.account.id)).toEqual(f.ids.slice(0, 3));
      expect(result.snapshot.ownerStatus).toEqual(f.ids.slice(0, 3).map(id => f.owner(id)));
      expect(result.snapshot.issues).toEqual([{ code: 'scope_mismatch', count: 1 }]);
      expect(result.scans).toBe(1);
    } finally { f.close(); }
  });

  it('preserves unknown scope early return and rejects nested public reads', async () => {
    const f = await fixture(4, '');
    try {
      f.queue('bad-history', f.ids[0]!);
      f.mutateCommands("UPDATE delegated_commands SET command_json='{}'");
      const result = f.read('unknown-scope');
      expect(result.snapshot.workspaceId).toBeNull();
      expect(result.snapshot.accounts).toEqual([]);
      expect(result.snapshot.ownerStatus).toEqual([]);
      expect(result.snapshot.issues).toEqual([{ code: 'scope_unknown', count: 1 }]);
      expect(result.scans).toBe(0);
      f.db.raw.transaction(() => expect(() => f.services.daily.get()).toThrow('daily_read_transaction_scope'))();
    } finally { f.close(); }
  });
});
