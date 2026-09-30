import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CLUSTER_URL_ENVIRONMENT_VARIABLE,
  createTestDatabase,
  type TestDatabase,
} from '@fss/domain/db/testing/testDatabase.ts';
import { CURRENT_SCHEMA_VERSION } from '@fss/domain/db/schemaRange.ts';
import { main } from '../src/tools/fss.ts';
import { COMMAND_DEPENDENCIES } from '../src/tools/fss/commands.ts';

/**
 * `fss admin pipeline stage-counts` (call-to-booking slice W): the 0028 remap report.
 * The fixture puts one open opportunity in Demo booked, one pin and one remap event, so
 * every asserted number is non-zero because a row is there, and asserts nothing was
 * written by counting the stage events before and after.
 */

let database: TestDatabase;
let url = '';
let workspaceId = '';

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

beforeAll(async () => {
  database = await createTestDatabase();
  const named = await database.session.query<{ name: string }>('SELECT current_database() AS name');
  const clusterUrl = new URL(process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE] ?? '');
  clusterUrl.pathname = `/${named.rows[0]?.name ?? ''}`;
  url = clusterUrl.toString();

  workspaceId = await one(
    "INSERT INTO workspaces (slug, display_name, business_time_zone) VALUES ('stagecounts', 'Stage Counts', 'America/New_York') RETURNING id",
  );
  const userId = await one(
    "INSERT INTO users (google_sub, email, display_name) VALUES ('stagecounts-sub', 'owner@example.test', 'Owner') RETURNING id",
  );
  await database.session.query("INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')", [
    workspaceId,
    userId,
  ]);
  const firmId = await one('INSERT INTO firms (workspace_id, name) VALUES ($1, $2) RETURNING id', [workspaceId, 'Counted Firm']);
  const stageId = await one("SELECT id FROM pipeline_stages WHERE workspace_id = $1 AND key = 'demo_booked'", [workspaceId]);
  const newStageId = await one("SELECT id FROM pipeline_stages WHERE workspace_id = $1 AND key = 'new'", [workspaceId]);
  const opportunityId = await one(
    'INSERT INTO opportunities (workspace_id, firm_id, stage_id, control_mode_changed_at) VALUES ($1, $2, $3, now()) RETURNING id',
    [workspaceId, firmId, stageId],
  );
  const eventId = await one(
    `INSERT INTO opportunity_stage_events (workspace_id, opportunity_id, firm_id, from_stage_id, to_stage_id, actor_kind, reason)
     VALUES ($1, $2, $3, $4, $5, 'system', 'stage_remap_20260930') RETURNING id`,
    [workspaceId, opportunityId, firmId, newStageId, stageId],
  );
  await database.session.query(
    `INSERT INTO opportunity_stage_pins (workspace_id, opportunity_id, firm_id, stage_id, pinned_by_user_id, source_event_id, pinned_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())`,
    [workspaceId, opportunityId, firmId, stageId, userId, eventId],
  );
});

afterAll(async () => {
  await database.drop();
});

describe('fss admin pipeline stage-counts', () => {
  it('reaches only the database', () => {
    expect(COMMAND_DEPENDENCIES['pipeline stage-counts']).toBe('database');
  });

  it('counts each stage, the pins and the remap moves, and writes nothing', async () => {
    const before = await database.session.query<{ count: string }>('SELECT count(*) AS count FROM opportunity_stage_events');
    const { code, stdout } = await run(['admin', 'pipeline', 'stage-counts']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as {
      ok: boolean;
      report: {
        schemaVersion: number;
        workspaces: { workspaceId: string; remapped: number; pins: number; stages: { key: string; open: number; retired: boolean }[] }[];
      };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.report.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    const mine = parsed.report.workspaces.find(entry => entry.workspaceId === workspaceId);
    expect(mine?.remapped).toBe(1);
    expect(mine?.pins).toBe(1);
    expect(mine?.stages.filter(stage => !stage.retired).map(stage => stage.key)).toEqual([
      'new',
      'demo_booked',
      'qualified',
      'onboarding',
      'won',
      'lost',
    ]);
    expect(mine?.stages.find(stage => stage.key === 'demo_booked')?.open).toBe(1);
    const after = await database.session.query<{ count: string }>('SELECT count(*) AS count FROM opportunity_stage_events');
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });
});
