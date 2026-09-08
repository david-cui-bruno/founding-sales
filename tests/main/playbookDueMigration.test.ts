import { afterEach, expect, it } from 'vitest';
import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { createMigrationRunner, migrateToLatest, productionMigrations } from '../../src/main/db/migrate';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from '../fixtures/tempDatabase';
import { DOMAIN_TIMESTAMP, insertOpenCycleWithAction, seedProspect } from '../fixtures/domainRows';

let database: AppDatabase | undefined;
let temp: TempDatabase | undefined;
afterEach(() => { if (database) closeDatabase(database); temp?.cleanup(); });
it('forward migrates legacy actions without deleting supplemental history and dates Unreviewed review work', async () => {
  temp = createTempDatabase();
  const key = createTestWorkspaceKey();
  database = openDatabase({ path: temp.path, key });
  const options = { backupDirectory: `${temp.path}.backups`, workspaceKey: key };
  await createMigrationRunner(productionMigrations.slice(0, 17))(database, options);
  const p = seedProspect(database.raw, 'legacy');
  insertOpenCycleWithAction({ database: database.raw, prefix: 'legacy', prospect: p });
  database.raw.prepare(`INSERT INTO next_actions (id, sales_cycle_id, action_type, status, timezone,
    work_intent, created_at) VALUES ('supplemental', 'legacy-cycle', 'review', 'pending',
    'America/New_York', 'internal_review', ?)`).run(DOMAIN_TIMESTAMP);
  database.raw.prepare(`INSERT INTO next_actions (id, sales_cycle_id, action_type, status, timezone,
    work_intent, created_at, completed_at, settlement_json) VALUES ('historical', 'legacy-cycle',
    'review', 'completed', 'America/New_York', 'internal_review', ?, ?, '{}')`)
    .run(DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
  const u = seedProspect(database.raw, 'unreviewed');
  database.raw.prepare(`INSERT INTO sales_cycles (id, person_id, prospect_id, entry_source_event_id,
    stage, workflow_status, current_next_action_id, stage_entered_at, created_at, updated_at)
    VALUES ('review-cycle', ?, ?, ?, 'unreviewed', 'active', NULL, ?, ?, ?)`)
    .run(u.personId, u.prospectId, u.sourceEventId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
  const before = database.raw.prepare('SELECT id, sales_cycle_id, status, settlement_json, created_at FROM next_actions ORDER BY id').all();
  await migrateToLatest(database, options);
  expect(database.raw.prepare('SELECT due_at, due_source FROM next_actions WHERE id = ?').get('legacy-action'))
    .toEqual({ due_at: DOMAIN_TIMESTAMP, due_source: 'legacy_unscheduled' });
  expect(database.raw.prepare("SELECT id, sales_cycle_id, status, settlement_json, created_at FROM next_actions WHERE sales_cycle_id = 'legacy-cycle' ORDER BY id").all())
    .toEqual(before);
  expect(database.raw.prepare("SELECT current_next_action_id FROM sales_cycles WHERE id = 'legacy-cycle'").get())
    .toEqual({ current_next_action_id: 'legacy-action' });
  expect(database.raw.prepare('SELECT COUNT(*) AS count FROM persons').get()).toEqual({ count: 2 });
  expect(database.raw.prepare(`SELECT a.action_type, a.channel, a.due_at FROM sales_cycles c
    JOIN next_actions a ON a.id = c.current_next_action_id WHERE c.id = 'review-cycle'`).get())
    .toEqual({ action_type: 'review_lead', channel: null, due_at: DOMAIN_TIMESTAMP });
  expect(database.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});
