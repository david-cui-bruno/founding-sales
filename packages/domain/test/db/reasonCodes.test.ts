import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BLOCKED_ACTION_KINDS, HOLD_REASON_CODES, isRecoverableHoldReason } from '@fss/contracts';
import { createTestDatabase, type TestDatabase } from '../../db/testing/index.ts';

/**
 * One vocabulary, two places. Migration 0001 seeds `hold_reason_codes` and
 * `@fss/contracts` exports the enum; if they ever disagree, a hold created by the
 * worker would be refused by a foreign key or accepted with a code the client
 * cannot render. This test is the reason that cannot happen quietly.
 */
describe('the closed reason-code set in the database', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database.drop();
  });

  it('seeds exactly the codes @fss/contracts declares', async () => {
    const { rows } = await database.session.query<{ code: string }>(
      'SELECT code FROM hold_reason_codes ORDER BY code',
    );
    expect(rows.map(row => row.code)).toEqual([...HOLD_REASON_CODES].sort());
  });

  it('agrees with @fss/contracts about which holds expose a recovery control', async () => {
    const { rows } = await database.session.query<{ code: string; recoverable: boolean }>(
      'SELECT code, recoverable FROM hold_reason_codes',
    );
    for (const row of rows) {
      expect(row.recoverable, row.code).toBe(isRecoverableHoldReason(row.code as (typeof HOLD_REASON_CODES)[number]));
    }
  });

  it('accepts every declared blocked action kind and refuses anything else', async () => {
    const workspace = await database.session.query<{ id: string }>(
      "INSERT INTO workspaces (slug, display_name) VALUES ('codes', 'Codes') RETURNING id",
    );
    const workspaceId = workspace.rows[0]?.id;
    await database.session.query(
      "INSERT INTO active_holds (workspace_id, scope_kind, scope_key, reason_code, blocked_action_kinds, source_event_kind) VALUES ($1, 'firm', 'firm-1', 'uncertain_reply', $2::text[], 'message')",
      [workspaceId, BLOCKED_ACTION_KINDS],
    );
    const stored = await database.session.query<{ blocked_action_kinds: string[] }>(
      'SELECT blocked_action_kinds FROM active_holds WHERE workspace_id = $1',
      [workspaceId],
    );
    expect(stored.rows[0]?.blocked_action_kinds).toEqual([...BLOCKED_ACTION_KINDS]);
  });

  it('accepts every declared reason code as a hold reason', async () => {
    const workspace = await database.session.query<{ id: string }>(
      "INSERT INTO workspaces (slug, display_name) VALUES ('every-code', 'Every code') RETURNING id",
    );
    const workspaceId = workspace.rows[0]?.id;
    for (const code of HOLD_REASON_CODES) {
      await database.session.query(
        "INSERT INTO active_holds (workspace_id, scope_kind, scope_key, reason_code, blocked_action_kinds, source_event_kind) VALUES ($1, 'firm', $2, $3, ARRAY['email_send'], 'test')",
        [workspaceId, `firm-${code}`, code],
      );
    }
    const counted = await database.session.query<{ count: string }>(
      'SELECT count(*) AS count FROM active_holds WHERE workspace_id = $1',
      [workspaceId],
    );
    expect(Number(counted.rows[0]?.count)).toBe(HOLD_REASON_CODES.length);
  });
});
