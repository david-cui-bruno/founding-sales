import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { createTestDatabase, type TestDatabase } from '@fss/domain/db/testing/testDatabase.ts';
import { HandlerRegistry, type JobHandler } from '@fss/domain/jobs/handlerRegistry.ts';
import { enqueueJob } from '@fss/domain/jobs/jobStore.ts';
import { runOnce } from '../src/runner/jobRunner.ts';
import { slotClasses } from '../src/runner/slots.ts';

/**
 * The lanes, end to end against a real queue.
 *
 * The failure these tests exist for is not exotic: the claim orders by `run_at`, so a
 * hundred sequence steps queued at 09:00 are claimed before the reply someone sent at
 * 09:01, and "Callie is slow" is really "Callie is behind fifty retention batches".
 */

const SLOTS = 3;

async function createEffectTable(session: SessionQueryable): Promise<void> {
  await session.query(`
    CREATE TABLE lane_log (
      workspace_id uuid NOT NULL REFERENCES workspaces (id),
      effect_key text NOT NULL,
      CONSTRAINT lane_log_once UNIQUE (workspace_id, effect_key)
    )
  `);
  await session.query('GRANT SELECT, INSERT, UPDATE, DELETE ON lane_log TO app_runtime');
}

function laneHandler(kind: 'mail.sync' | 'retention.batch', prefix: string): JobHandler {
  return {
    kind,
    protection: 'business_uniqueness',
    maxAttempts: 4,
    leaseSeconds: 30,
    handle: async input => {
      await input.session.query('INSERT INTO lane_log (workspace_id, effect_key) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
        input.scope.workspaceId,
        `${prefix}:${input.job.idempotencyKey}`,
      ]);
    },
  };
}

describe('runner slots claim by lane', () => {
  let database: TestDatabase;
  let workspaceId: string;
  const registry = new HandlerRegistry();

  beforeAll(async () => {
    database = await createTestDatabase();
    const { rows } = await database.session.query<{ id: string }>(
      "INSERT INTO workspaces (slug, display_name) VALUES ('alpha', 'Alpha') RETURNING id",
    );
    workspaceId = rows[0]?.id ?? '';
    await createEffectTable(database.session);
    registry.register(laneHandler('mail.sync', 'urgent')).register(laneHandler('retention.batch', 'bulk'));
  });

  afterAll(async () => {
    await database.drop();
  });

  const enqueue = async (kind: 'mail.sync' | 'retention.batch', key: string): Promise<void> => {
    await enqueueJob(database.session, { workspaceId, kind, idempotencyKey: key, payload: {}, maxAttempts: 4 });
  };

  /** One poll of every slot of a three-slot worker, in slot order. */
  const round = async (): Promise<void> => {
    for (let index = 0; index < SLOTS; index += 1) {
      await runOnce(database.session, {
        registry,
        owner: `worker:${String(index)}`,
        limit: 1,
        classes: slotClasses(SLOTS, index),
      });
    }
  };

  const count = async (prefix: string): Promise<number> => {
    const { rows } = await database.session.query<{ count: string }>(
      'SELECT count(*) AS count FROM lane_log WHERE workspace_id = $1 AND effect_key LIKE $2',
      [workspaceId, `${prefix}:%`],
    );
    return Number(rows[0]?.count);
  };

  const isDone = async (kind: string, key: string): Promise<boolean> => {
    const { rows } = await database.session.query<{ state: string }>(
      'SELECT state FROM jobs WHERE workspace_id = $1 AND kind = $2 AND idempotency_key = $3',
      [workspaceId, kind, key],
    );
    return rows[0]?.state === 'done';
  };

  it('gives each slot the lanes its index asks for', () => {
    expect(slotClasses(1, 0)).toEqual(['urgent', 'bulk']);
    expect(slotClasses(2, 0)).toEqual(['urgent']);
    expect(slotClasses(2, 1)).toEqual(['urgent', 'bulk']);
    expect(slotClasses(3, 0)).toEqual(['urgent']);
    expect(slotClasses(3, 1)).toEqual(['bulk']);
    expect(slotClasses(3, 2)).toEqual(['urgent', 'bulk']);
    expect(slotClasses(8, 7)).toEqual(['urgent', 'bulk']);
  });

  it('claims an urgent job in the next poll with fifty bulk jobs already queued', async () => {
    for (let index = 0; index < 50; index += 1) await enqueue('retention.batch', `bulk-backlog:${String(index)}`);
    // One round with the backlog in place, so the slots are already at work on it.
    await round();
    expect(await count('bulk')).toBe(2);

    await enqueue('mail.sync', 'urgent-behind-the-backlog');
    const startedAt = Date.now();
    let polls = 0;
    while (!(await isDone('mail.sync', 'urgent-behind-the-backlog')) && polls < 10) {
      await round();
      polls += 1;
    }
    const latencyMilliseconds = Date.now() - startedAt;

    // One poll of the urgent slot. Not fifty; not seventeen. The bound is the slot's
    // poll interval, which is the whole claim of the lane split.
    expect(polls).toBe(1);
    expect(latencyMilliseconds).toBeLessThan(2_000);
    // And the backlog is still a backlog: the urgent job overtook it, nobody drained it.
    const { rows } = await database.session.query<{ count: string }>(
      "SELECT count(*) AS count FROM jobs WHERE workspace_id = $1 AND kind = 'retention.batch' AND state <> 'done'",
      [workspaceId],
    );
    expect(Number(rows[0]?.count)).toBeGreaterThan(40);
  });

  it('advances bulk work on the bulk slot under sustained urgent load', async () => {
    const bulkBefore = await count('bulk');
    const rounds = 5;
    for (let round_ = 0; round_ < rounds; round_ += 1) {
      // More urgent work arrives every poll than the urgent-capable slots can take, for
      // ever. The bulk-only slot is why this does not mean bulk work stops.
      for (let index = 0; index < 3; index += 1) {
        await enqueue('mail.sync', `urgent-flood:${String(round_)}:${String(index)}`);
      }
      await round();
    }
    expect((await count('bulk')) - bulkBefore).toBe(rounds);

    // The urgent lane really was saturated: more arrived each round than left.
    const { rows } = await database.session.query<{ count: string }>(
      "SELECT count(*) AS count FROM jobs WHERE workspace_id = $1 AND kind = 'mail.sync' AND state <> 'done'",
      [workspaceId],
    );
    expect(Number(rows[0]?.count)).toBeGreaterThan(0);
  });
});
