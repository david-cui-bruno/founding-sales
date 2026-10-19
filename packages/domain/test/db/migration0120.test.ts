import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { phoneFixture, type PhoneFixture } from '../dial/phoneHandoffFixtures.ts';
import { logCallOutcome } from '../../dial/calls.ts';
let db: TestDatabase;
let f: PhoneFixture;
beforeAll(async () => { db = await createTestDatabase(); f = await phoneFixture(db); });
afterAll(async () => { await db.drop(); });
beforeEach(async () => { await db.session.query('BEGIN'); await f.publish(); return async () => { await db.session.query('ROLLBACK'); }; });
async function rejects(sql: string, values: readonly unknown[]) {
  await db.session.query('SAVEPOINT invalid_phone_row');
  await expect(db.session.query(sql, values)).rejects.toThrow();
  await db.session.query('ROLLBACK TO SAVEPOINT invalid_phone_row');
}
describe('0120 durable attempt constraints and least privilege', () => {
  it('forbids deleting attempt history and rewriting/deleting snapshot evidence as app_runtime', async () => {
    const row = (await db.session.query<{ attempt_delete: boolean; snapshot_delete: boolean; scrub_update: boolean; attempt_insert: boolean }>(`SELECT
      has_table_privilege('app_runtime','phone_handoff_attempts','DELETE') AS attempt_delete,
      has_table_privilege('app_runtime','national_registry_snapshots','DELETE') AS snapshot_delete,
      has_table_privilege('app_runtime','national_registry_endpoint_scrubs','UPDATE') AS scrub_update,
      has_table_privilege('app_runtime','phone_handoff_attempts','INSERT') AS attempt_insert`)).rows[0];
    expect(row).toEqual({ attempt_delete: false, snapshot_delete: false, scrub_update: false, attempt_insert: true });
  });
  it('enforces bounded dispatch validity, one command and erasure-complete tombstones', async () => {
    const attempt = await f.reserve();
    if (!attempt.ok) throw new Error(attempt.reason);
    await rejects("UPDATE phone_handoff_attempts SET expires_at=reserved_at+interval '16 seconds' WHERE id=$1", [attempt.value.attemptId]);
    await rejects('UPDATE phone_handoff_attempts SET e164=NULL WHERE id=$1', [attempt.value.attemptId]);
    await rejects('UPDATE phone_handoff_attempts SET erased_at=clock_timestamp() WHERE id=$1', [attempt.value.attemptId]);
    await rejects(`INSERT INTO phone_handoff_attempts SELECT workspace_id,gen_random_uuid(),firm_id,actor_user_id,device_id,command_id,contact_id,
      opportunity_id,phone_route_id,route_version,e164,item_id,registry_snapshot_id,registry_scrubbed_at,reserved_at,expires_at,call_log_id,erased_at
      FROM phone_handoff_attempts WHERE id=$1`, [attempt.value.attemptId]);
  });
  it('requires real scope and area-code bounds, never a global unknown-coverage row', async () => {
    await rejects("UPDATE national_registry_snapshots SET covered_area_codes=ARRAY[]::text[] WHERE workspace_id=$1", [f.w]);
    await rejects("UPDATE national_registry_snapshots SET covered_area_codes=ARRAY['000'] WHERE workspace_id=$1", [f.w]);
  });
  it('allows only a temporary merge transition, never an invalid final outcome association', async () => {
    const attempt = await f.reserve();
    if (!attempt.ok) throw new Error(attempt.reason);
    const logged = await logCallOutcome(f.context, { firmId: f.crm.alpha.firmId, phoneHandoffAttemptId: attempt.value.attemptId, outcome: 'no_answer' });
    if (!logged.ok) throw new Error(logged.reason);
    await db.session.query('SAVEPOINT bad_final_association');
    await db.session.query('SET CONSTRAINTS call_logs_opportunity_fkey DEFERRED');
    await db.session.query('UPDATE call_logs SET opportunity_id=gen_random_uuid() WHERE id=$1', [logged.value.callLogId]);
    await expect(db.session.query('SET CONSTRAINTS call_logs_opportunity_fkey IMMEDIATE')).rejects.toThrow();
    await db.session.query('ROLLBACK TO SAVEPOINT bad_final_association');
  });
});
