import { spawn, type ChildProcess } from 'node:child_process';

export type DomainWriteWorkerInput = Readonly<{
  databasePath: string;
  nativeBinding: string;
  keyHex: string;
  readyPath: string;
  personId: string;
  prospectId: string;
  sourceEventId: string;
  cycleId: string;
  actionId: string;
  eventId: string;
  timestamp: string;
}>;

export function spawnDomainWriteWorker(input: DomainWriteWorkerInput): ChildProcess {
  return spawn(process.execPath, ['-e', contenderSource, JSON.stringify(input)], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

export type ActionCompletionWorkerInput = Readonly<{
  databasePath: string;
  nativeBinding: string;
  keyHex: string;
  readyPath: string;
  cycleId: string;
  enrollmentId: string;
  actionId: string;
  replacementActionId: string;
  activityId: string;
  timestamp: string;
  settlementJson: string;
}>;

export function spawnActionCompletionWorker(input: ActionCompletionWorkerInput): ChildProcess {
  return spawn(process.execPath, ['-e', actionCompletionSource, JSON.stringify(input)], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

export type SqlTransactionWorkerInput = Readonly<{
  databasePath: string;
  nativeBinding: string;
  keyHex: string;
  readyPath: string;
  statements: readonly Readonly<{ sql: string; params: readonly unknown[] }>[];
}>;

export function spawnSqlTransactionWorker(input: SqlTransactionWorkerInput): ChildProcess {
  return spawn(process.execPath, ['-e', sqlTransactionSource, JSON.stringify(input)], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

export type LifecycleCommandWorkerInput = Readonly<{
  databasePath: string;
  keyHex: string;
  readyPath: string;
  ids: readonly string[];
  timestamp: string;
  command: Readonly<Record<string, unknown>>;
}>;

export function spawnLifecycleCommandWorker(input: LifecycleCommandWorkerInput): ChildProcess {
  return spawn(process.execPath, [
    'node_modules/vite-node/vite-node.mjs', '--script',
    'tests/support/lifecycleCommandContender.ts', JSON.stringify(input),
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
}

export type OptOutCommandWorkerInput = Readonly<{
  databasePath: string;
  keyHex: string;
  readyPath: string;
  startPath: string;
  attemptPath: string;
  lockedPath: string;
  releasePath: string;
  ids: readonly string[];
  timestamp: string;
  command: Readonly<Record<string, unknown>>;
}>;

export function spawnOptOutCommandWorker(input: OptOutCommandWorkerInput): ChildProcess {
  return spawn(process.execPath, [
    'node_modules/vite-node/vite-node.mjs', '--script',
    'tests/support/optOutCommandContender.ts', JSON.stringify(input),
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
}

const contenderSource = String.raw`
const { writeFileSync } = require('node:fs');
const Database = require('better-sqlite3-multiple-ciphers');
const input = JSON.parse(process.argv[1]);
const database = new Database(input.databasePath, { nativeBinding: input.nativeBinding });
try {
  database.pragma("cipher='sqlcipher'");
  database.pragma('legacy=4');
  database.pragma("key=\"x'" + input.keyHex + "'\"");
  database.prepare('SELECT count(*) FROM sqlite_master').get();
  database.pragma('recursive_triggers = ON');
  database.pragma('foreign_keys = ON');
  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 5000');
  database.exec('BEGIN IMMEDIATE');
  writeFileSync(input.readyPath, 'locked', { mode: 0o600 });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
  database.prepare(
    'INSERT INTO sales_cycles (id,person_id,prospect_id,entry_source_event_id,stage,' +
    'workflow_status,current_next_action_id,stage_entered_at,version,created_at,updated_at) ' +
    "VALUES (?,?,?,?, 'unreviewed','active',?,?,1,?,?)"
  ).run(input.cycleId,input.personId,input.prospectId,input.sourceEventId,
    input.actionId,input.timestamp,input.timestamp,input.timestamp);
  database.prepare(
    'INSERT INTO next_actions (id,sales_cycle_id,action_type,channel,status,due_at,' +
    "timezone,work_intent,created_at,updated_at) VALUES (?,?,'review_lead',NULL,'pending',?," +
    "'America/New_York','internal_review',?,?)"
  ).run(input.actionId,input.cycleId,input.timestamp,input.timestamp,input.timestamp);
  database.prepare(
    'INSERT INTO stage_events (id,sales_cycle_id,from_stage,to_stage,effective_at,' +
    "confirmed_at,confirmation_kind,transition_sequence,created_at) VALUES (?,?,NULL," +
    "'unreviewed',?,?,'mechanical',1,?)"
  ).run(input.eventId,input.cycleId,input.timestamp,input.timestamp,input.timestamp);
  database.exec('COMMIT');
} catch (error) {
  if (database.inTransaction) database.exec('ROLLBACK');
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
} finally {
  database.close();
}
`;

const actionCompletionSource = String.raw`
const { writeFileSync } = require('node:fs');
const Database = require('better-sqlite3-multiple-ciphers');
const input = JSON.parse(process.argv[1]);
const database = new Database(input.databasePath, { nativeBinding: input.nativeBinding });
try {
  database.pragma("cipher='sqlcipher'");
  database.pragma('legacy=4');
  database.pragma("key=\"x'" + input.keyHex + "'\"");
  database.prepare('SELECT count(*) FROM sqlite_master').get();
  database.pragma('recursive_triggers = ON');
  database.pragma('foreign_keys = ON');
  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 5000');
  database.exec('BEGIN IMMEDIATE');
  writeFileSync(input.readyPath, 'locked', { mode: 0o600 });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
  const enrollment = database.prepare(
    "UPDATE cadence_enrollments SET status='completed',stop_reason='phase_completed'," +
    'version=version+1,updated_at=? WHERE id=? AND sales_cycle_id=? AND status=\'active\' AND version=1'
  ).run(input.timestamp,input.enrollmentId,input.cycleId);
  if (enrollment.changes !== 1) throw new Error('stale enrollment');
  database.prepare(
    'INSERT INTO next_actions (id,sales_cycle_id,action_type,channel,status,due_at,' +
    "timezone,work_intent,created_at,updated_at) VALUES (?,?,'confirm_offer',NULL,'pending',?," +
    "'America/New_York','internal_review',?,?)"
  ).run(input.replacementActionId,input.cycleId,input.timestamp,input.timestamp,input.timestamp);
  const cycle = database.prepare(
    'UPDATE sales_cycles SET current_next_action_id=?,version=version+1,updated_at=? ' +
    'WHERE id=? AND version=1 AND stage=\'interviewed\' AND workflow_status=\'active\' ' +
    'AND current_next_action_id=?'
  ).run(input.replacementActionId,input.timestamp,input.cycleId,input.actionId);
  if (cycle.changes !== 1) throw new Error('stale cycle');
  const action = database.prepare(
    "UPDATE next_actions SET status='completed',completion_activity_id=?,settlement_json=?," +
    'completed_at=?,version=version+1,updated_at=? ' +
    "WHERE id=? AND sales_cycle_id=? AND status='pending' AND version=1"
  ).run(
    input.activityId,input.settlementJson,input.timestamp,input.timestamp,
    input.actionId,input.cycleId
  );
  if (action.changes !== 1) throw new Error('stale action');
  database.exec('COMMIT');
} catch (error) {
  if (database.inTransaction) database.exec('ROLLBACK');
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
} finally {
  database.close();
}
`;

const sqlTransactionSource = String.raw`
const { writeFileSync } = require('node:fs');
const Database = require('better-sqlite3-multiple-ciphers');
const input = JSON.parse(process.argv[1]);
const database = new Database(input.databasePath, { nativeBinding: input.nativeBinding });
try {
  database.pragma("cipher='sqlcipher'");
  database.pragma('legacy=4');
  database.pragma("key=\"x'" + input.keyHex + "'\"");
  database.prepare('SELECT count(*) FROM sqlite_master').get();
  database.pragma('recursive_triggers = ON');
  database.pragma('foreign_keys = ON');
  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 5000');
  database.exec('BEGIN IMMEDIATE');
  writeFileSync(input.readyPath, 'locked', { mode: 0o600 });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
  for (const statement of input.statements) {
    database.prepare(statement.sql).run(...statement.params);
  }
  database.exec('COMMIT');
} catch (error) {
  if (database.inTransaction) database.exec('ROLLBACK');
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
} finally {
  database.close();
}
`;
