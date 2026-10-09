import {seedAskFinancialReceipt} from './support/askAnswerCases.ts';
import {randomUUID} from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import type { SessionQueryable } from '../../db/queryable.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from './support/fixtures.ts';

/**
 * Append-only is a privilege, not a convention (specification 5.2 and 10.2).
 *
 * These run as `app_runtime`, not as the database owner: `SET ROLE` drops the
 * superuser's bypass, so a refusal here is the refusal production would give.
 */
describe('append-only privileges', () => {
  let database: TestDatabase;
  let runtime: SessionQueryable;
  let seeded: TwoWorkspaces;

  beforeAll(async () => {
    database = await createTestDatabase();
    seeded = await seedTwoWorkspaces(database.session);
    runtime = await database.appRuntimeSession();
    await database.session.query(
      "INSERT INTO audit_events (workspace_id, actor_kind, actor_user_id, action, subject_kind, subject_id) VALUES ($1, 'user', $2, 'firm.reassigned', 'firm', 'firm-1')",
      [seeded.alpha.workspaceId, seeded.alpha.admin.userId],
    );
    await database.session.query(
      "INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source) VALUES ($1, 'event-1', 'handle', 'someone@example.test', 'v1', 'prospect_opt_out')",
      [seeded.alpha.workspaceId],
    );
  });

  afterAll(async () => {
    await database.drop();
  });

  it('preserves immutable body-free business decisions as app_runtime',async()=>{await expect(runtime.query("UPDATE crm_business_decision_revisions SET decision='include'")).rejects.toMatchObject({code:'42501'});await expect(runtime.query('DELETE FROM crm_business_decision_revisions')).rejects.toMatchObject({code:'42501'});await expect(runtime.query('TRUNCATE crm_business_decision_revisions')).rejects.toMatchObject({code:'42501'});});

  it('cannot reopen completed CRM requests by deleting or changing their opaque identity',async()=>{await expect(runtime.query('DELETE FROM crm_mail_reply_resolutions')).rejects.toMatchObject({code:'42501'});await expect(runtime.query('UPDATE crm_mail_reply_resolutions SET request_message_id=gen_random_uuid()')).rejects.toMatchObject({code:'42501'});await expect(runtime.query('TRUNCATE crm_mail_reply_resolutions')).rejects.toMatchObject({code:'42501'});});

  it('allows only null-redaction of exact completion proof and never replaces or restores it',async()=>{
    const workspaceId=seeded.alpha.workspaceId,requestId=randomUUID();
    const receipts=[];for(let index=0;index<2;index++)receipts.push((await runtime.query<{id:string}>("INSERT INTO crm_mail_progress_receipts(workspace_id,source_id,source_revision,source_hash,event_kind,context_hash,original_firm_ids,original_person_ids,state) VALUES($1,gen_random_uuid(),1,repeat('a',64),'contacted',repeat('b',64),'{}','{}','deleted') RETURNING id",[workspaceId])).rows[0]!.id);
    await runtime.query("INSERT INTO crm_mail_reply_resolutions(workspace_id,request_message_id,sent_receipt_id,request_provider_at) VALUES($1,$2,$3,'2026-09-24T14:00:00Z')",[workspaceId,requestId,receipts[0]]);
    await expect(runtime.query('UPDATE crm_mail_reply_resolutions SET sent_receipt_id=$3 WHERE workspace_id=$1 AND request_message_id=$2',[workspaceId,requestId,receipts[1]])).rejects.toMatchObject({code:'23514'});
    await expect(runtime.query("UPDATE crm_mail_reply_resolutions SET request_provider_at='2026-09-25T14:00:00Z' WHERE workspace_id=$1 AND request_message_id=$2",[workspaceId,requestId])).rejects.toMatchObject({code:'23514'});
    await runtime.query('UPDATE crm_mail_reply_resolutions SET request_provider_at=NULL WHERE workspace_id=$1 AND request_message_id=$2',[workspaceId,requestId]);
    await runtime.query('DELETE FROM crm_mail_progress_receipts WHERE workspace_id=$1 AND id=$2',[workspaceId,receipts[0]]);
    await expect(runtime.query('UPDATE crm_mail_reply_resolutions SET sent_receipt_id=$3 WHERE workspace_id=$1 AND request_message_id=$2',[workspaceId,requestId,receipts[1]])).rejects.toMatchObject({code:'23514'});
    await expect(runtime.query("UPDATE crm_mail_reply_resolutions SET request_provider_at='2026-09-24T14:00:00Z' WHERE workspace_id=$1 AND request_message_id=$2",[workspaceId,requestId])).rejects.toMatchObject({code:'23514'});
  });

  it('preserves Ask request and conserved financial history and protects canonical window proof', async () => {
    for (const table of ['crm_ask_requests','crm_ask_financial_receipts']) {
      await expect(runtime.query(`DELETE FROM ${table} WHERE false`)).rejects.toMatchObject({code:'42501'});
      await expect(runtime.query(`TRUNCATE ${table}`)).rejects.toMatchObject({code:'42501'});
    }
    await expect(runtime.query("UPDATE crm_ask_request_windows SET source_hash=repeat('b',64) WHERE false")).rejects.toMatchObject({code:'42501'});
    await expect(runtime.query('TRUNCATE crm_ask_request_windows')).rejects.toMatchObject({code:'42501'});
    for (const table of ['crm_ask_requests','crm_ask_purposes','crm_ask_request_windows','crm_ask_financial_receipts']) {
      await expect(runtime.query(`SELECT 1 FROM ${table} LIMIT 0`)).resolves.toMatchObject({rows:[]});
    }
  });

  it('conserves Ask attempt proof across legitimate dispatch and refuses terminal or backward changes', async () => {
    const f={session:database.session,seeded};
    const unknown=await seedAskFinancialReceipt(f);
    await runtime.query("UPDATE crm_ask_financial_receipts SET dispatch_state='calling' WHERE workspace_id=$1 AND id=$2",[seeded.alpha.workspaceId,unknown]);
    await runtime.query("UPDATE crm_ask_financial_receipts SET dispatch_state='unknown_acceptance' WHERE workspace_id=$1 AND id=$2",[seeded.alpha.workspaceId,unknown]);
    await expect(runtime.query("UPDATE crm_ask_financial_receipts SET dispatch_state='calling' WHERE workspace_id=$1 AND id=$2",[seeded.alpha.workspaceId,unknown])).rejects.toMatchObject({code:'23514',constraint:'crm_ask_financial_immutable'});
    const settled=await seedAskFinancialReceipt(f);
    await runtime.query("UPDATE crm_ask_financial_receipts SET dispatch_state='calling' WHERE workspace_id=$1 AND id=$2",[seeded.alpha.workspaceId,settled]);
    await expect(runtime.query("UPDATE crm_ask_financial_receipts SET dispatch_state='reserved' WHERE workspace_id=$1 AND id=$2",[seeded.alpha.workspaceId,settled])).rejects.toMatchObject({code:'23514',constraint:'crm_ask_financial_immutable'});
    await runtime.query("UPDATE crm_ask_financial_receipts SET dispatch_state='settled' WHERE workspace_id=$1 AND id=$2",[seeded.alpha.workspaceId,settled]);
    await expect(runtime.query("UPDATE crm_ask_financial_receipts SET dispatch_state='released' WHERE workspace_id=$1 AND id=$2",[seeded.alpha.workspaceId,settled])).rejects.toMatchObject({code:'23514',constraint:'crm_ask_financial_immutable'});
    await expect(runtime.query('UPDATE crm_ask_financial_receipts SET input_price_micros=2 WHERE workspace_id=$1 AND id=$2',[seeded.alpha.workspaceId,settled])).rejects.toMatchObject({code:'23514',constraint:'crm_ask_financial_immutable'});
    const released=await seedAskFinancialReceipt(f);
    await runtime.query("UPDATE crm_ask_financial_receipts SET dispatch_state='released' WHERE workspace_id=$1 AND id=$2",[seeded.alpha.workspaceId,released]);
    await expect(runtime.query("UPDATE crm_ask_financial_receipts SET dispatch_state='calling' WHERE workspace_id=$1 AND id=$2",[seeded.alpha.workspaceId,released])).rejects.toMatchObject({code:'23514',constraint:'crm_ask_financial_immutable'});
    expect((await runtime.query<{dispatch_state:string}>('SELECT dispatch_state FROM crm_ask_financial_receipts WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY dispatch_state',[seeded.alpha.workspaceId,[unknown,settled,released]])).rows).toEqual([{dispatch_state:'released'},{dispatch_state:'settled'},{dispatch_state:'unknown_acceptance'}]);
  });

  it('runs as app_runtime, not as the owner', async () => {
    const { rows } = await runtime.query<{ current_user: string }>('SELECT current_user');
    expect(rows[0]?.current_user).toBe('app_runtime');
  });

  it('lets app_runtime read and insert audit events', async () => {
    await runtime.query(
      "INSERT INTO audit_events (workspace_id, actor_kind, action, subject_kind) VALUES ($1, 'system', 'today.built', 'workspace')",
      [seeded.alpha.workspaceId],
    );
    const { rows } = await runtime.query<{ count: string }>(
      'SELECT count(*) AS count FROM audit_events WHERE workspace_id = $1',
      [seeded.alpha.workspaceId],
    );
    expect(Number(rows[0]?.count)).toBe(2);
  });

  it('refuses UPDATE on suppression_events as app_runtime', async () => {
    await expect(
      runtime.query("UPDATE suppression_events SET source = 'import' WHERE event_id = 'event-1'"),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses DELETE on audit_events as app_runtime', async () => {
    await expect(runtime.query('DELETE FROM audit_events')).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses DELETE on suppression_events and UPDATE on audit_events as app_runtime', async () => {
    await expect(runtime.query('DELETE FROM suppression_events')).rejects.toMatchObject({ code: '42501' });
    await expect(runtime.query("UPDATE audit_events SET action = 'tampered'")).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses TRUNCATE on both append-only tables as app_runtime', async () => {
    await expect(runtime.query('TRUNCATE audit_events')).rejects.toMatchObject({ code: '42501' });
    await expect(runtime.query('TRUNCATE suppression_events')).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses the same writes for the migration role', async () => {
    const migration = await database.appRuntimeSession();
    await migration.query('SET ROLE migration');
    await expect(migration.query('DELETE FROM audit_events')).rejects.toMatchObject({ code: '42501' });
    await expect(
      migration.query("UPDATE suppression_events SET scope = 'firm'"),
    ).rejects.toMatchObject({ code: '42501' });
  });

  /**
   * The funnel (migration 0022). Its grant is `SELECT, INSERT` plus `UPDATE
   * (detail)` and nothing else, so "append-only but for the redaction" is a
   * privilege rather than a promise: `app_runtime` can clear a fact's `detail` and
   * cannot touch what the fact says happened.
   */
  it('lets app_runtime clear a funnel fact’s detail and nothing else about it', async () => {
    await database.session.query(
      `INSERT INTO funnel_facts (workspace_id, kind, dedupe_key, source, actor_kind, detail)
       VALUES ($1, 'demo.started', 'privilege-case-1', 'demo', 'system', '{"step": "one"}'::jsonb)`,
      [seeded.alpha.workspaceId],
    );

    await runtime.query("UPDATE funnel_facts SET detail = '{}'::jsonb WHERE dedupe_key = 'privilege-case-1'");
    const { rows } = await runtime.query<{ detail: unknown }>(
      "SELECT detail FROM funnel_facts WHERE dedupe_key = 'privilege-case-1'",
    );
    expect(rows[0]?.detail).toEqual({});

    // What the fact says happened is not the application's to rewrite.
    for (const statement of [
      "UPDATE funnel_facts SET kind = 'demo.completed' WHERE dedupe_key = 'privilege-case-1'",
      "UPDATE funnel_facts SET firm_id = NULL WHERE dedupe_key = 'privilege-case-1'",
      "UPDATE funnel_facts SET dedupe_key = 'rewritten' WHERE dedupe_key = 'privilege-case-1'",
      "UPDATE funnel_facts SET occurred_at = now() WHERE dedupe_key = 'privilege-case-1'",
    ]) {
      await expect(runtime.query(statement), statement).rejects.toMatchObject({ code: '42501' });
    }

    await expect(runtime.query('DELETE FROM funnel_facts')).rejects.toMatchObject({ code: '42501' });
    await expect(runtime.query('TRUNCATE funnel_facts')).rejects.toMatchObject({ code: '42501' });
  });

  it('gives the migration role the same funnel matrix and no more', async () => {
    // The same grant went to both roles, so the same matrix is asserted of both: a
    // migration that could rewrite a fact would be a migration that could rewrite
    // history, and `migration` is the role a release runs as.
    const migration = await database.appRuntimeSession();
    await migration.query('SET ROLE migration');

    await migration.query(
      `INSERT INTO funnel_facts (workspace_id, kind, dedupe_key, source, actor_kind, detail)
       VALUES ($1, 'demo.started', 'privilege-case-2', 'demo', 'system', '{"step": "one"}'::jsonb)`,
      [seeded.alpha.workspaceId],
    );
    await migration.query("UPDATE funnel_facts SET detail = '{}'::jsonb WHERE dedupe_key = 'privilege-case-2'");
    const { rows } = await migration.query<{ detail: unknown }>(
      "SELECT detail FROM funnel_facts WHERE dedupe_key = 'privilege-case-2'",
    );
    expect(rows[0]?.detail).toEqual({});

    for (const statement of [
      "UPDATE funnel_facts SET kind = 'demo.completed' WHERE dedupe_key = 'privilege-case-2'",
      "UPDATE funnel_facts SET firm_id = NULL WHERE dedupe_key = 'privilege-case-2'",
      "UPDATE funnel_facts SET dedupe_key = 'rewritten' WHERE dedupe_key = 'privilege-case-2'",
      "UPDATE funnel_facts SET occurred_at = now() WHERE dedupe_key = 'privilege-case-2'",
    ]) {
      await expect(migration.query(statement), statement).rejects.toMatchObject({ code: '42501' });
    }
    await expect(migration.query('DELETE FROM funnel_facts')).rejects.toMatchObject({ code: '42501' });
    await expect(migration.query('TRUNCATE funnel_facts')).rejects.toMatchObject({ code: '42501' });
  });

  /**
   * Lane M1 (0039): a wrong fact is withdrawn, never removed. UPDATE is granted on exactly
   * three columns — 0022's `detail`, and `withdrawn_at` and `withdrawn_reason` — to both roles,
   * and DELETE stays revoked; the matrices above still hold for every other column.
   */
  it('grants UPDATE on funnel_facts for detail and the withdrawal marker only, to both roles', async () => {
    const { rows } = await database.session.query<{ grantee: string; column_name: string }>(
      `SELECT grantee, column_name FROM information_schema.column_privileges
        WHERE table_name = 'funnel_facts' AND privilege_type = 'UPDATE' AND grantee IN ('app_runtime', 'migration')
        ORDER BY grantee, column_name`,
    );
    expect(rows).toEqual([
      { grantee: 'app_runtime', column_name: 'detail' },
      { grantee: 'app_runtime', column_name: 'withdrawn_at' },
      { grantee: 'app_runtime', column_name: 'withdrawn_reason' },
      { grantee: 'migration', column_name: 'detail' },
      { grantee: 'migration', column_name: 'withdrawn_at' },
      { grantee: 'migration', column_name: 'withdrawn_reason' },
    ]);

    await database.session.query(
      `INSERT INTO funnel_facts (workspace_id, kind, dedupe_key, source, actor_kind)
       VALUES ($1, 'meeting.held', 'privilege-case-0039', 'calendar', 'system')`,
      [seeded.alpha.workspaceId],
    );
    await runtime.query(
      "UPDATE funnel_facts SET withdrawn_at = now(), withdrawn_reason = 'attendance_unconfirmed' WHERE dedupe_key = 'privilege-case-0039'",
    );
    await runtime.query("UPDATE funnel_facts SET withdrawn_at = NULL, withdrawn_reason = NULL WHERE dedupe_key = 'privilege-case-0039'");
    await expect(runtime.query("DELETE FROM funnel_facts WHERE dedupe_key = 'privilege-case-0039'")).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses writes to the hold reason-code reference table as app_runtime', async () => {
    await expect(
      runtime.query("INSERT INTO hold_reason_codes (code, description, recoverable) VALUES ('invented', 'x', true)"),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('holds the privilege after a failed transaction, not just on the first statement', async () => {
    await runtime.query('BEGIN');
    await expect(runtime.query('DELETE FROM audit_events')).rejects.toMatchObject({ code: '42501' });
    await runtime.query('ROLLBACK');
    await expect(runtime.query('DELETE FROM audit_events')).rejects.toMatchObject({ code: '42501' });
  });
});
