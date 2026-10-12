import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createTestDatabase } from '../../db/testing/testDatabase.ts';
import { applyMigrations } from '../../db/migrationRunner.ts';
import { seedTwoWorkspaces } from './support/fixtures.ts';
import { seedAskRequest } from './support/askAnswerCases.ts';

const progress = { exactResults: [{ toolCallId: 'tasks', operation: 'tasks', valueHash: 'a'.repeat(64), value: { records: [{ label: 'Private routing follow-up' }], count: '1' } }] };

it('erases the copied question before stale task consumers discard their lineage', async () => {
  const db = await createTestDatabase();
  try {
    const seeded = await seedTwoWorkspaces(db.session), f = { session: db.session, seeded };
    const workspace = seeded.alpha.workspaceId, owner = seeded.alpha.salesperson.userId;
    const personId = randomUUID();
    await db.session.query("INSERT INTO crm_people(workspace_id,id,owner_user_id,full_name) VALUES($1,$2,$3,'Task erasure context')", [workspace, personId, owner]);
    const original = await seedAskRequest(f, { initial_contexts: JSON.stringify([{ personId, firmIds: [], relationships: [], review: 'current' }]), initial_access_closure: JSON.stringify({ firmIds: [], personIds: [personId] }) });
    const proof = (await db.session.query<{ scope: { sources: Record<string, unknown>[] }; initial_contexts: unknown; initial_access_closure: unknown }>('SELECT scope,initial_contexts,initial_access_closure FROM crm_ask_requests WHERE workspace_id=$1 AND id=$2', [workspace, original])).rows[0]!;
    const actionId = randomUUID();
    await db.session.query(`INSERT INTO crm_ask_actions(workspace_id,id,owner_user_id,source_request_id,source_request_version,kind,status,human_text,input_scope,initial_contexts,original_access_closure,support_refs,target_person_id) VALUES($1,$2,$3,$4,1,'task','open','Private routing follow-up',$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9)`, [workspace, actionId, owner, original, JSON.stringify(proof.scope), JSON.stringify(proof.initial_contexts), JSON.stringify(proof.initial_access_closure), JSON.stringify([{ ...proof.scope.sources[0], locator: 'text:0:4' }]), personId]);
    const consumer = await seedAskRequest(f, { execution_version: 'agent_v1', original_agent_scope: JSON.stringify({ kind: 'business' }), scope: '{"sources":[]}', initial_contexts: '[]', question: 'Which private routing follow-up is open?', validated_progress: JSON.stringify(progress) });
    await db.session.query('INSERT INTO crm_ask_task_dependencies(workspace_id,request_id,request_version,request_epoch,action_id,task_version) VALUES($1,$2,1,1,$3,1)', [workspace, consumer, actionId]);
    // The registered worker uses this transition after a completion changes its exact observation.
    await db.session.query("UPDATE crm_ask_requests SET state='stale',reason='source_changed',result=NULL,result_at=NULL WHERE workspace_id=$1 AND id=$2", [workspace, consumer]);
    expect((await db.session.query('SELECT question,result,validated_progress FROM crm_ask_requests WHERE workspace_id=$1 AND id=$2', [workspace, consumer])).rows).toEqual([{ question: null, result: null, validated_progress: null }]);
    expect((await db.session.query('SELECT request_id FROM crm_ask_task_dependencies WHERE workspace_id=$1 AND request_id=$2', [workspace, consumer])).rows).toEqual([]);
  } finally { await db.drop(); }
});

it('erases legacy task copies when upgrading schema104 without inventing lineage', async () => {
  const db = await createTestDatabase({ throughVersion: 104 });
  try {
    const seeded = await seedTwoWorkspaces(db.session), f = { session: db.session, seeded };
    const requestId = await seedAskRequest(f, { execution_version: 'agent_v1', original_agent_scope: JSON.stringify({ kind: 'business' }), scope: '{"sources":[]}', initial_contexts: '[]', validated_progress: JSON.stringify(progress) });
    await applyMigrations(db.session, { throughVersion: 105 });
    expect((await db.session.query('SELECT state,question,result,validated_progress FROM crm_ask_requests WHERE workspace_id=$1 AND id=$2', [seeded.alpha.workspaceId, requestId])).rows).toEqual([{ state: 'stale', question: null, result: null, validated_progress: null }]);
    expect((await db.session.query('SELECT request_id FROM crm_ask_task_dependencies')).rows).toEqual([]);
  } finally { await db.drop(); }
});
