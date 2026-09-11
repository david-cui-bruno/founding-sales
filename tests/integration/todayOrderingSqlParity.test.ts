import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import {
  PRIORITY_ORDERABLE_SQL_ALIAS,
  PROSPECT_PRIORITY_ORDER_BY_SQL,
  compareProspectPriority,
} from '../../src/main/domain/prioritization/priorityOrdering';
import { planDailyAccountCalls } from '../../src/main/domain/today/todayOrdering';
import type { OrderablePriorityRow } from '../../src/main/domain/prioritization/prioritizationTypes';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../fixtures/tempDatabase';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PRIORITIES = ['p0', 'p1', 'p2', 'p3'] as const;
const REACHABILITIES = ['direct', 'indirect', 'none'] as const;
const EXPIRATIONS: readonly (string | null)[] = [
  null, '2026-09-01T00:00:00.000Z', '2026-09-15T00:00:00.000Z',
];
const CLOUD_AXES: readonly (number | null)[] = [null, 0, 41, 62, 100];
const LAST_CONTACTS: readonly (string | null)[] = [
  null, '2026-08-01T00:00:00.000Z', '2026-08-15T00:00:00.000Z',
];

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

describe('Today discretionary suborder SQL parity', () => {
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
      CREATE TEMP TABLE today_orderable_rows (
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
    database.raw.exec('DELETE FROM today_orderable_rows');
    const insert = database.raw.prepare(`
      INSERT INTO today_orderable_rows VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    // Today exposes the CTE under the exact fixed alias and uses the Task 11
    // fragment unchanged for the discretionary suborder.
    const ordered = database.raw.prepare(`
      WITH ${PRIORITY_ORDERABLE_SQL_ALIAS} AS (
        SELECT * FROM today_orderable_rows
      )
      SELECT ${PRIORITY_ORDERABLE_SQL_ALIAS}.prospect_id AS prospect_id
      FROM ${PRIORITY_ORDERABLE_SQL_ALIAS}
      ORDER BY ${PROSPECT_PRIORITY_ORDER_BY_SQL}
    `).all() as { prospect_id: string }[];
    return ordered.map((row) => row.prospect_id);
  }

  it('matches the Task 11 comparator over shuffled randomized and boundary rows', () => {
    for (const seed of [7, 41, 97]) {
      const random = mulberry32(seed);
      const rows: OrderablePriorityRow[] = [];
      for (let index = 0; index < 150; index += 1) {
        rows.push({
          prospectId: `today-${seed}-${String(index).padStart(3, '0')}`,
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
      const shuffled = [...rows].sort(() => random() - 0.5);
      const expected = [...rows].sort(compareProspectPriority).map((row) => row.prospectId);
      expect(sqlOrder(shuffled)).toEqual(expected);
    }
  });

  it('matches daily account call planning SQL over due ranked and actual-completed account IDs', () => {
    database.raw.exec(`
      CREATE TEMP TABLE due_accounts(account_id TEXT NOT NULL, position INTEGER NOT NULL);
      CREATE TEMP TABLE ranked_accounts(account_id TEXT NOT NULL, position INTEGER NOT NULL);
      CREATE TEMP TABLE actual_completed_accounts(account_id TEXT NOT NULL);
    `);
    const due = ['warm-a', 'warm-a', 'warm-b'];
    const ranked = ['done-cold', 'new-a', 'warm-a', 'new-a', 'new-b'];
    const completed = ['done-cold'];
    for (const [position, accountId] of due.entries()) {
      database.raw.prepare('INSERT INTO due_accounts(account_id,position) VALUES(?,?)').run(accountId, position);
    }
    for (const [position, accountId] of ranked.entries()) {
      database.raw.prepare('INSERT INTO ranked_accounts(account_id,position) VALUES(?,?)').run(accountId, position);
    }
    for (const accountId of completed) {
      database.raw.prepare('INSERT INTO actual_completed_accounts(account_id) VALUES(?)').run(accountId);
    }
    const sqlRows = database.raw.prepare(`
      WITH unique_due AS (
        SELECT account_id, MIN(position) AS position FROM due_accounts GROUP BY account_id
      ), unique_ranked AS (
        SELECT account_id, MIN(position) AS position FROM ranked_accounts GROUP BY account_id
      ), new_accounts AS (
        SELECT r.account_id, r.position
        FROM unique_ranked r
        LEFT JOIN unique_due d ON d.account_id = r.account_id
        LEFT JOIN actual_completed_accounts c ON c.account_id = r.account_id
        WHERE d.account_id IS NULL AND c.account_id IS NULL
        ORDER BY r.position
        LIMIT 2
      ), planned AS (
        SELECT account_id, position, 0 AS band FROM unique_due
        UNION ALL
        SELECT account_id, position, 1 AS band FROM new_accounts
      )
      SELECT account_id AS accountId FROM planned ORDER BY band, position
    `).all() as { accountId: string }[];
    expect(sqlRows.map(row => row.accountId)).toEqual(planDailyAccountCalls({
      due,
      ranked,
      newCallSlots: 2,
      completedAccountIds: completed,
      totalCallCapacity: 3,
    }).accountIds);
  });

  it('statically bans copied tuples, blended scores, SQL arithmetic, and early limits', () => {
    const todayDirectory = join(process.cwd(), 'src/main/domain/today');
    for (const name of ['todayOrdering.ts', 'todayRepository.ts', 'todayService.ts', 'todayTypes.ts']) {
      const text = readFileSync(join(todayDirectory, name), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      // No locally copied tuple ranks or reimplemented priority arithmetic.
      expect(/PRIORITY_RANK\s*=/.test(text) && name !== 'todayOrdering.ts',
        `${name} copies priority ranks`).toBe(false);
      expect(/timing\w*\s*[*+]\s*fit/i.test(text), `${name} blends fit and timing`).toBe(false);
      expect(/\bscore\b/i.test(text), `${name} declares a score`).toBe(false);
      // No caller-selected alias for the fixed fragment.
      expect(/ORDER BY[^;]*CASE\s+\w+\.effective_priority/i.test(text)
        && !/priority_orderable/.test(text), `${name} reimplements the priority order`).toBe(false);
      // No capacity LIMIT on the base row set before classification. The
      // correlated single-row last-activity subquery is display-only and
      // intentionally uses LIMIT 1.
      if (name === 'todayRepository.ts') {
        const baseQuery = text.slice(
          text.indexOf('FROM sales_cycles'), text.indexOf('ORDER BY cycle.id'),
        );
        const outsideSubqueries = baseQuery.replace(/\(\s*SELECT[\s\S]*?\)/g, '');
        expect(/LIMIT/i.test(outsideSubqueries), 'base query applies an early LIMIT').toBe(false);
      }
    }
  });
});
