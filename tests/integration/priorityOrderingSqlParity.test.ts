import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import {
  PRIORITY_ORDERABLE_SQL_ALIAS,
  PROSPECT_PRIORITY_ORDER_BY_SQL,
  compareProspectPriority,
} from '../../src/main/domain/prioritization/priorityOrdering';
import type { OrderablePriorityRow } from '../../src/main/domain/prioritization/prioritizationTypes';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../fixtures/tempDatabase';

const PRIORITIES = ['p0', 'p1', 'p2', 'p3'] as const;
const REACHABILITIES = ['direct', 'indirect', 'none'] as const;
const EXPIRATIONS: readonly (string | null)[] = [null, '2026-09-01T00:00:00.000Z', '2026-09-15T00:00:00.000Z'];
const CLOUD_AXES: readonly (number | null)[] = [null, 0, 41, 62, 100];
const LAST_CONTACTS: readonly (string | null)[] = [null, '2026-08-01T00:00:00.000Z', '2026-08-15T00:00:00.000Z'];

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]!;
}

describe('priority ordering SQL parity', () => {
  let database: AppDatabase;
  let temp: TempDatabase;

  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${temp.path}.backups`, workspaceKey: key,
    });
    database.raw.exec(`
      CREATE TEMP TABLE priority_orderable_rows (
        prospect_id TEXT PRIMARY KEY,
        effective_priority TEXT NOT NULL,
        earliest_trigger_expires_at TEXT,
        timing_millipoints INTEGER NOT NULL,
        fit_points INTEGER NOT NULL,
        reachability TEXT NOT NULL,
        data_confidence INTEGER NOT NULL,
        last_contact_at TEXT,
        cloud_source_percentile REAL,
        cloud_timing INTEGER
      )
    `);
  });

  afterEach(() => {
    closeDatabase(database);
    temp.cleanup();
  });

  function sqlOrder(rows: readonly OrderablePriorityRow[]): string[] {
    database.raw.exec('DELETE FROM priority_orderable_rows');
    const insert = database.raw.prepare(`
      INSERT INTO priority_orderable_rows VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows) {
      insert.run(
        row.prospectId,
        row.effectivePriority,
        row.earliestTriggerExpiresAt,
        row.timingMilliPoints,
        row.fitPoints,
        row.reachability,
        row.dataConfidence,
        row.lastContactAt,
        row.cloudSourcePercentile,
        row.cloudTiming,
      );
    }
    const ordered = database.raw.prepare(`
      SELECT ${PRIORITY_ORDERABLE_SQL_ALIAS}.prospect_id AS prospect_id
      FROM priority_orderable_rows AS ${PRIORITY_ORDERABLE_SQL_ALIAS}
      ORDER BY ${PROSPECT_PRIORITY_ORDER_BY_SQL}
    `).all() as { prospect_id: string }[];
    return ordered.map((row) => row.prospect_id);
  }

  function jsOrder(rows: readonly OrderablePriorityRow[]): string[] {
    return [...rows].sort(compareProspectPriority).map((row) => row.prospectId);
  }

  it('orders boundary-heavy fixtures identically in JS and encrypted SQLite', () => {
    const rows: OrderablePriorityRow[] = [];
    let index = 0;
    for (const effectivePriority of PRIORITIES) {
      for (const reachability of REACHABILITIES) {
        for (const earliestTriggerExpiresAt of EXPIRATIONS) {
          for (const lastContactAt of LAST_CONTACTS) {
            index += 1;
            rows.push({
              prospectId: `boundary-${String(index).padStart(3, '0')}`,
              effectivePriority,
              earliestTriggerExpiresAt,
              timingMilliPoints: (index % 3) * 10_000,
              fitPoints: (index % 4) * 10,
              reachability,
              dataConfidence: index % 11,
              lastContactAt,
              cloudSourcePercentile: CLOUD_AXES[(index + 2) % CLOUD_AXES.length]!,
              cloudTiming: CLOUD_AXES[index % CLOUD_AXES.length]!,
            });
          }
        }
      }
    }
    // Equal bands, different raw axes, and stable-ID ties.
    rows.push(
      {
        prospectId: 'tie-a',
        effectivePriority: 'p1',
        earliestTriggerExpiresAt: null,
        timingMilliPoints: 12_000,
        fitPoints: 15,
        reachability: 'direct',
        dataConfidence: 5,
        lastContactAt: null,
        cloudSourcePercentile: null,
        cloudTiming: null,
      },
      {
        prospectId: 'tie-b',
        effectivePriority: 'p1',
        earliestTriggerExpiresAt: null,
        timingMilliPoints: 12_000,
        fitPoints: 15,
        reachability: 'direct',
        dataConfidence: 5,
        lastContactAt: null,
        cloudSourcePercentile: null,
        cloudTiming: null,
      },
    );
    expect(sqlOrder(rows)).toEqual(jsOrder(rows));
  });

  it('orders randomized fixtures identically across five seeds', () => {
    for (const seed of [11, 23, 47, 89, 131]) {
      const random = mulberry32(seed);
      const rows: OrderablePriorityRow[] = [];
      for (let index = 0; index < 200; index += 1) {
        rows.push({
          prospectId: `random-${seed}-${String(index).padStart(3, '0')}`,
          effectivePriority: pick(random, PRIORITIES),
          earliestTriggerExpiresAt: pick(random, EXPIRATIONS),
          timingMilliPoints: Math.floor(random() * 40_001),
          fitPoints: Math.floor(random() * 31),
          reachability: pick(random, REACHABILITIES),
          dataConfidence: Math.floor(random() * 11),
          lastContactAt: pick(random, LAST_CONTACTS),
          cloudSourcePercentile: pick(random, CLOUD_AXES),
          cloudTiming: pick(random, CLOUD_AXES),
        });
      }
      expect(sqlOrder(rows)).toEqual(jsOrder(rows));
    }
  });
});
