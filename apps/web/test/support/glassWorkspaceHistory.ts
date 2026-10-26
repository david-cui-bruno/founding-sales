import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect } from 'playwright/test';
import { makeStepExecution } from '@fss/domain/db/testing/stepExecutions.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { createTemplateVersion } from '@fss/domain/templates/templates.ts';
import type { GlassWorkspaceApp } from './glassWorkspaceApp.ts';

/** Inert historical fictional rows only, not prepare/dispatch/provider operations.
 * Pending and held introductions are real retained sequence executions. */
export async function seedGlassIntroductions(app: GlassWorkspaceApp, firmId: string) {
  const f = app.fixture, db = f.db;
  const ctx = repositoryContext(workspaceScope(f.alpha.workspaceId, { kind: 'user', userId: f.alpha.admin.userId, role: 'admin' }), db);
  const template = await withTransaction(db, () => createTemplateVersion(ctx, { name: 'FICTIONAL glass783 inert history', subject: 'FICTIONAL retained introduction', body: 'FICTIONAL retained history only.\n\nSam Example\nCallie', footer: { signOff: 'Sam Example\nCallie' }, requiredVariables: [], approve: true }));
  assert(template.ok, template.ok ? '' : template.reason);
  const steps: Record<string, string> = {};
  let opportunityId = (await db.query<{ id: string }>("SELECT id FROM opportunities WHERE firm_id=$1 AND status='open' ORDER BY id LIMIT 1", [firmId])).rows[0]?.id;
  for (const state of ['pending', 'held', 'sent', 'dispatching']) {
    const id = await makeStepExecution(db, { workspaceId: f.alpha.workspaceId, firmId, userId: f.alpha.admin.userId, templateVersionId: template.value.id, originKind: 'cold_legacy', ...(opportunityId ? { opportunityId } : {}) });
    opportunityId ??= (await db.query<{ opportunity_id: string }>('SELECT opportunity_id FROM sequence_enrollments WHERE id=(SELECT enrollment_id FROM step_executions WHERE id=$1)', [id])).rows[0]!.opportunity_id;
    steps[state] = id;
    if (state === 'held') await db.query("UPDATE step_executions SET state='held',hold_reason_code=(SELECT code FROM hold_reason_codes ORDER BY code LIMIT 1) WHERE id=$1", [id]);
    if (state === 'sent') await db.query("UPDATE step_executions SET state='completed',completed_at=now(),completion_source='send',result='sent' WHERE id=$1", [id]);
    if (state === 'dispatching') await db.query("UPDATE step_executions SET state='dispatched' WHERE id=$1", [id]);
    if (state !== 'sent' && state !== 'dispatching') continue;
    const execution = (await db.query<{ enrollment_id: string; contact_id: string }>('SELECT enrollment_id,contact_id FROM step_executions WHERE id=$1', [id])).rows[0]!;
    await db.query(`INSERT INTO outbound_messages(workspace_id,id,mailbox_id,state,origin_kind,enrollment_id,step_execution_id,firm_id,contact_id,recipient_address,subject,body,rendered_hash,provider_message_id_header,send_at,source_zone,placement_rule_version,attempt_token,dispatch_started_at,sent_at,provider_message_id)
      VALUES($1,$2,$3,$4,'step_execution',$5,$6,$7,$8,'fictional-history@example.test','FICTIONAL inert history','FICTIONAL seeded historical record, not a transport operation.',$9,$10,now(),'America/New_York','fixture.1',$11,now(),CASE WHEN $4='sent' THEN now() ELSE NULL END,CASE WHEN $4='sent' THEN 'fictional-glass783-provider-id' ELSE NULL END)`,
    [f.alpha.workspaceId, randomUUID(), app.seed.mailboxId, state, execution.enrollment_id, id, firmId, execution.contact_id, 'c'.repeat(64), `<fictional-${randomUUID()}@example.test>`, randomUUID()]);
  }
  const outbound = (await db.query('SELECT to_jsonb(t) AS row FROM outbound_messages t ORDER BY id')).rows;
  const events = (await db.query('SELECT to_jsonb(t) AS row FROM outbound_message_events t ORDER BY to_jsonb(t)::text')).rows;
  return { steps, outbound, events, firmId, opportunityId };
}
export type GlassIntroductions = Awaited<ReturnType<typeof seedGlassIntroductions>>;
export async function assertGlassIntroductionsStopped(app: GlassWorkspaceApp, history: GlassIntroductions): Promise<void> {
  const states = (await app.fixture.db.query<{ id: string; state: string }>('SELECT id,state FROM step_executions WHERE firm_id=$1', [history.firmId])).rows;
  for (const key of ['pending', 'held']) expect(states.find(row => row.id === history.steps[key])?.state).toBe('cancelled');
  expect(states.find(row => row.id === history.steps['sent'])?.state).toBe('completed');
  expect(states.find(row => row.id === history.steps['dispatching'])?.state).toBe('dispatched');
  expect((await app.fixture.db.query("SELECT 1 FROM sequence_enrollments WHERE firm_id=$1 AND ended_at IS NULL", [history.firmId])).rowCount).toBe(0);
  await assertGlassHistoryUnchanged(app, history);
}
export async function assertGlassHistoryUnchanged(app: GlassWorkspaceApp, history: GlassIntroductions): Promise<void> {
  expect((await app.fixture.db.query('SELECT to_jsonb(t) AS row FROM outbound_messages t ORDER BY id')).rows).toEqual(history.outbound);
  expect((await app.fixture.db.query('SELECT to_jsonb(t) AS row FROM outbound_message_events t ORDER BY to_jsonb(t)::text')).rows).toEqual(history.events);
}
