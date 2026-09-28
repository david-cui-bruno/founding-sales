import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { createTestDatabase, type TestDatabase } from '@fss/domain/db/testing/testDatabase.ts';
import { HandlerRegistry, type JobHandler } from '@fss/domain/jobs/handlerRegistry.ts';
import { enqueueJob } from '@fss/domain/jobs/jobStore.ts';
import { runOnce } from '../src/runner/jobRunner.ts';
import { slotClasses, slotLanes, URGENT_STREAK_LIMIT } from '../src/runner/slots.ts';

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

  /** A worker of `concurrency` slots, each remembering its own streak, as the bootstrap builds it. */
  const worker = (concurrency: number): { poll: () => Promise<void> } => {
    const lanes = Array.from({ length: concurrency }, (_, index) => slotLanes(concurrency, index));
    return {
      poll: async () => {
        for (const [index, slot] of lanes.entries()) {
          const report = await runOnce(database.session, {
            registry,
            owner: `worker${String(concurrency)}:${String(index)}`,
            limit: 1,
            classes: slot.order(),
          });
          slot.record(report.claimedClass);
        }
      },
    };
  };

  const threeSlots = worker(SLOTS);
  /** One poll of every slot of a three-slot worker, in slot order. */
  const round = async (): Promise<void> => {
    await threeSlots.poll();
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
    // poll interval, which is the whole claim of the lane split. The wall clock is not
    // the assertion — a loaded machine may take as long as it likes over one poll.
    expect(polls).toBe(1);
    expect(latencyMilliseconds).toBeLessThan(60_000);
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
    // One per round from the bulk-only slot, and whatever the flexible slot adds when
    // its urgent streak runs out: at least the rounds, never fewer.
    const advanced = (await count('bulk')) - bulkBefore;
    expect(advanced).toBeGreaterThanOrEqual(rounds);
    expect(advanced).toBeLessThanOrEqual(rounds + Math.ceil(rounds / URGENT_STREAK_LIMIT));

    // The urgent lane really was saturated: more arrived each round than left.
    const { rows } = await database.session.query<{ count: string }>(
      "SELECT count(*) AS count FROM jobs WHERE workspace_id = $1 AND kind = 'mail.sync' AND state <> 'done'",
      [workspaceId],
    );
    expect(Number(rows[0]?.count)).toBeGreaterThan(0);
  });
});

describe('a flexible slot cannot starve bulk work', () => {
  let database: TestDatabase;
  let workspaceId: string;
  const registry = new HandlerRegistry();

  beforeAll(async () => {
    database = await createTestDatabase();
    const { rows } = await database.session.query<{ id: string }>(
      "INSERT INTO workspaces (slug, display_name) VALUES ('beta', 'Beta') RETURNING id",
    );
    workspaceId = rows[0]?.id ?? '';
    await createEffectTable(database.session);
    registry.register(laneHandler('mail.sync', 'urgent')).register(laneHandler('retention.batch', 'bulk'));
  });

  afterAll(async () => {
    await database.drop();
  });

  const countBulk = async (): Promise<number> => {
    const { rows } = await database.session.query<{ count: string }>(
      "SELECT count(*) AS count FROM lane_log WHERE workspace_id = $1 AND effect_key LIKE 'bulk:%'",
      [workspaceId],
    );
    return Number(rows[0]?.count);
  };

  /**
   * Urgent work that never runs out, and one bulk job waiting behind it. At one or two
   * slots there is no bulk-only slot, so if "urgent first" were unbounded this would
   * never finish.
   */
  const bulkIsClaimedUnderSustainedUrgentLoad = async (concurrency: number): Promise<number> => {
    const lanes = Array.from({ length: concurrency }, (_, index) => slotLanes(concurrency, index));
    await enqueueJob(database.session, {
      workspaceId,
      kind: 'retention.batch',
      idempotencyKey: `bulk-behind-the-flood:${String(concurrency)}`,
      payload: {},
      maxAttempts: 4,
    });
    const before = await countBulk();
    let polls = 0;
    while ((await countBulk()) === before && polls < 20) {
      for (let index = 0; index < concurrency * 2; index += 1) {
        await enqueueJob(database.session, {
          workspaceId,
          kind: 'mail.sync',
          idempotencyKey: `flood:${String(concurrency)}:${String(polls)}:${String(index)}`,
          payload: {},
          maxAttempts: 4,
        });
      }
      for (const [index, slot] of lanes.entries()) {
        const report = await runOnce(database.session, {
          registry,
          owner: `starve${String(concurrency)}:${String(index)}`,
          limit: 1,
          classes: slot.order(),
        });
        slot.record(report.claimedClass);
      }
      polls += 1;
    }
    return polls;
  };

  it('claims bulk work within the streak bound at concurrency 1', async () => {
    const polls = await bulkIsClaimedUnderSustainedUrgentLoad(1);
    expect(polls).toBeLessThanOrEqual(URGENT_STREAK_LIMIT + 1);
  });

  it('claims bulk work within the streak bound at concurrency 2', async () => {
    const polls = await bulkIsClaimedUnderSustainedUrgentLoad(2);
    expect(polls).toBeLessThanOrEqual(URGENT_STREAK_LIMIT + 1);
  });

  it('flips one poll in every streak, and only after the streak', () => {
    const slot = slotLanes(1, 0);
    for (let poll = 0; poll < URGENT_STREAK_LIMIT; poll += 1) {
      expect(slot.order()).toEqual(['urgent', 'bulk']);
      slot.record('urgent');
    }
    expect(slot.order()).toEqual(['bulk', 'urgent']);
    // The flipped poll resets the streak whatever it claimed, so urgent is not
    // interleaved away: the next poll is urgent-first again.
    slot.record('urgent');
    expect(slot.order()).toEqual(['urgent', 'bulk']);
    // A poll that claimed bulk, or nothing, also resets it.
    slot.record('bulk');
    expect(slot.order()).toEqual(['urgent', 'bulk']);
    slot.record(null);
    expect(slot.order()).toEqual(['urgent', 'bulk']);
  });

  it('never flips a fixed slot', () => {
    const urgentOnly = slotLanes(3, 0);
    const bulkOnly = slotLanes(3, 1);
    for (let poll = 0; poll < URGENT_STREAK_LIMIT + 2; poll += 1) {
      expect(urgentOnly.order()).toEqual(['urgent']);
      urgentOnly.record('urgent');
      expect(bulkOnly.order()).toEqual(['bulk']);
      bulkOnly.record('bulk');
    }
  });
});
