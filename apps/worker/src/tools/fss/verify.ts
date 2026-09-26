import { randomUUID } from 'node:crypto';
import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { readSchemaVersionReport } from './migrate.ts';
import { describeToolConfig, type ToolConfig } from './config.ts';

/**
 * `fss verify` (David's decision of 21 September, condition 1 of the in-VPC design).
 *
 * The question a deployment cannot otherwise answer: *can the runtime user use this
 * database?* Three parts, all cheap, and it runs as the **runtime** user because that
 * is whose privileges are in doubt:
 *
 *   * the applied schema version, and whether each binary's declared range accepts it;
 *   * which parts of the configuration are present — names and booleans, never a value;
 *   * one INSERT and one SELECT inside a transaction that is **rolled back**.
 *
 * ## Why a write at all, and why nothing is kept
 *
 * A read-only check passes against a user who has lost `INSERT`, against a full
 * volume, and against a read replica somebody pointed the tool at by mistake. Each of
 * those is a deployment that looks ready and is not. So the check writes — and then
 * rolls back, so a verification can never be mistaken for activity, and repeated
 * verification leaves nothing behind. The row is
 * then read back *after* the rollback as well, and `persisted` being false is part of
 * the report rather than an assumption.
 *
 * ## Why `heartbeats`
 *
 * It is the one operational table with a nullable `workspace_id` (0001:
 * `heartbeats_mailbox_is_workspace_scoped` requires it to be null for every component
 * except `mailbox`), so the check works on a database that has been migrated and has
 * no workspace yet — which is exactly when a deployment verifies, between the
 * migration and the first service starting. Nothing business-shaped is touched: no
 * `audit_events` row, no counter, no job. A unique `instance_key` per run means the
 * INSERT cannot collide with a live worker's heartbeat even before the rollback
 * releases it.
 */

export type VerifyRefusal = 'schema_unreadable' | 'write_refused' | 'read_refused' | 'rollback_failed';

export interface VerifyReport {
  readonly schemaVersion: number;
  readonly currentSchemaVersion: number;
  readonly apiAccepts: boolean;
  readonly workerAccepts: boolean;
  readonly pending: readonly number[];
  readonly connectedRole: string;
  /** The table the write check used, so a report says what it proved. */
  readonly writeCheckTable: 'heartbeats';
  readonly write: boolean;
  readonly read: boolean;
  /** False, always, and asserted after the rollback rather than assumed. */
  readonly persisted: boolean;
  readonly configured: Readonly<Record<string, unknown>>;
}

export type VerifyResult =
  | { readonly ok: true; readonly value: VerifyReport }
  | { readonly ok: false; readonly reason: VerifyRefusal; readonly detail: string };

export interface VerifyOptions {
  /** Who ran it. A public identifier: a task id, a run prefix, an operator's name. */
  readonly actor?: string | undefined;
  readonly note?: string | undefined;
}

/** The component the write check claims to be. `worker` requires a null workspace. */
const WRITE_CHECK_COMPONENT = 'worker';

export async function runVerify(
  session: SessionQueryable,
  config: ToolConfig,
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  let schema;
  let connectedRole = 'unknown';
  try {
    schema = await readSchemaVersionReport(session);
    const role = await session.query<{ role: string }>('SELECT current_user AS role');
    connectedRole = role.rows[0]?.role ?? 'unknown';
  } catch (error) {
    return {
      ok: false,
      reason: 'schema_unreadable',
      detail: error instanceof Error ? error.name : 'the schema version could not be read',
    };
  }

  const instanceKey = `fss-verify:${randomUUID()}`;
  let write = false;
  let read = false;
  await session.query('BEGIN');
  try {
    const written = await session.query<{ id: string }>(
      `INSERT INTO heartbeats (workspace_id, component, instance_key, observed_at, detail)
       VALUES (NULL, $1, $2, now(), $3::jsonb)
       RETURNING id`,
      [
        WRITE_CHECK_COMPONENT,
        instanceKey,
        JSON.stringify({ check: 'fss-verify', actor: options.actor ?? 'fss', note: options.note ?? null }),
      ],
    );
    const id = written.rows[0]?.id;
    write = id !== undefined;
    if (id !== undefined) {
      const back = await session.query<{ id: string }>('SELECT id FROM heartbeats WHERE id = $1', [id]);
      read = back.rows[0]?.id === id;
    }
  } catch (error) {
    await session.query('ROLLBACK').catch(() => undefined);
    return {
      ok: false,
      reason: 'write_refused',
      // The class of failure, never the statement: a `pg` error message can carry one.
      detail: error instanceof Error ? error.name : 'the verification write was refused',
    };
  }
  // Always a rollback. There is no branch in which this check keeps a row.
  await session.query('ROLLBACK');

  if (!read) {
    return { ok: false, reason: 'read_refused', detail: 'the written row could not be read back' };
  }

  const after = await session.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM heartbeats WHERE instance_key = $1',
    [instanceKey],
  );
  const persisted = Number(after.rows[0]?.count ?? '0') > 0;
  if (persisted) {
    return { ok: false, reason: 'rollback_failed', detail: 'the verification row survived the rollback' };
  }

  return {
    ok: true,
    value: {
      schemaVersion: schema.schemaVersion,
      currentSchemaVersion: schema.currentSchemaVersion,
      apiAccepts: schema.apiAccepts,
      workerAccepts: schema.workerAccepts,
      pending: schema.pending,
      connectedRole,
      writeCheckTable: 'heartbeats',
      write,
      read,
      persisted,
      configured: { ...describeToolConfig(config) },
    },
  };
}
