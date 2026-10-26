import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {applyMigrations,readAppliedSchemaVersion} from '../../db/migrationRunner.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from './support/fixtures.ts';
import {manualActivityRow,insertManualActivity} from './support/manualProspectActivityCases.ts';
import type {SessionQueryable} from '../../db/queryable.ts';
let db:TestDatabase,seeded:TwoWorkspaces;
const content={subject:'Synthetic promised subject',body:'Synthetic independently edited body'};
beforeAll(async()=>{db=await createTestDatabase({throughVersion:137});seeded=await seedTwoWorkspaces(db.session);expect(await readAppliedSchemaVersion(db.session)).toBe(137);await applyMigrations(db.session,{throughVersion:138});expect(await readAppliedSchemaVersion(db.session)).toBe(138);});
afterAll(async()=>db?.drop());
async function parent(session:SessionQueryable){const attempt=await manualActivityRow({session,seeded});await insertManualActivity({session,seeded},attempt);return attempt;}
async function insert(session:SessionQueryable,source:Awaited<ReturnType<typeof parent>>,patch:Record<string,unknown>={}){const row={workspace_id:source.workspace_id,id:randomUUID(),creator_user_id:seeded.alpha.admin.userId,creator_ref:seeded.alpha.admin.userId,source_kind:'candidate',candidate_id:source.candidate_id,candidate_revision:1,attempt_id:source.id,attempt_ref:source.id,content:JSON.stringify(content),...patch},keys=Object.keys(row);await session.query(`INSERT INTO calling_follow_up_drafts(${keys.join(',')}) VALUES(${keys.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(row));return row.id;}
it.each([null,{},[],{subject:null,body:'body'},{subject:'ok',body:null},{subject:'ok',body:'body',note:'private'}, {subject:' ',body:'body'},{subject:'ok',body:'\n\t '},{subject:'😀'.repeat(81),body:'body'},{subject:'ok',body:'x'.repeat(4001)}])('SQL rejects malformed content %# on actual app_runtime INSERT and UPDATE',async value=>{
 const runtime=await db.appRuntimeSession();for(const operation of ['insert','update']){await runtime.query('BEGIN');try{const source=await parent(runtime);if(operation==='insert')await expect(insert(runtime,source,{content:JSON.stringify(value)})).rejects.toMatchObject({code:'23514'});else{const id=await insert(runtime,source);await expect(runtime.query('UPDATE calling_follow_up_drafts SET content=$2::jsonb,revision=revision+1 WHERE id=$1',[id,JSON.stringify(value)])).rejects.toMatchObject({code:'23514'});}}finally{await runtime.query('ROLLBACK');}}
});
it('exact source branches, same-workspace witnesses and immutable terminal binding survive source deletion',async()=>{
 const runtime=await db.appRuntimeSession(),source=await parent(runtime),id=await insert(runtime,source);
 for(const patch of [{firm_id:randomUUID()},{candidate_revision:2},{workspace_id:seeded.beta.workspaceId},{creator_ref:seeded.beta.admin.userId},{attempt_ref:randomUUID()}]){await runtime.query('BEGIN');try{await expect(insert(runtime,await parent(runtime),patch)).rejects.toMatchObject({code:expect.stringMatching(/^235/u)});}finally{await runtime.query('ROLLBACK');}}
 for(const update of ['revision=revision+2','candidate_revision=2,revision=revision+1','creator_user_id=gen_random_uuid(),revision=revision+1']){await runtime.query('BEGIN');try{await expect(runtime.query(`UPDATE calling_follow_up_drafts SET ${update} WHERE id=$1`,[id])).rejects.toMatchObject({code:'23514'});}finally{await runtime.query('ROLLBACK');}}
 await runtime.query("UPDATE calling_follow_up_drafts SET content=NULL,reason='withdrawn',revision=revision+1 WHERE id=$1",[id]);
 await runtime.query('BEGIN');try{await expect(runtime.query('UPDATE calling_follow_up_drafts SET content=$2::jsonb,reason=NULL,revision=revision+1 WHERE id=$1',[id,JSON.stringify(content)])).rejects.toMatchObject({code:'23514'});}finally{await runtime.query('ROLLBACK');}
 await runtime.query('BEGIN');try{await expect(insert(runtime,source)).rejects.toMatchObject({code:'23505'});}finally{await runtime.query('ROLLBACK');}
 await runtime.query('DELETE FROM sourcing_manual_prospect_attempts WHERE id=$1',[source.id]);expect((await runtime.query('SELECT content,reason,attempt_id,attempt_ref FROM calling_follow_up_drafts WHERE id=$1',[id])).rows[0]).toEqual({content:null,reason:'withdrawn',attempt_id:source.id,attempt_ref:null});
 await runtime.query('BEGIN');try{await expect(runtime.query('DELETE FROM calling_follow_up_drafts WHERE id=$1',[id])).rejects.toMatchObject({code:'42501'});}finally{await runtime.query('ROLLBACK');}
});
it.each(['withdraw','delete','candidate_revision','candidate_source'])('existing manual source lifecycle %s physically clears promised prose',async operation=>{
 const runtime=await db.appRuntimeSession(),source=await parent(runtime),id=await insert(runtime,source);
 if(operation==='withdraw')await runtime.query("UPDATE sourcing_manual_prospect_attempts SET content=NULL,reason='withdrawn',revision=revision+1 WHERE id=$1",[source.id]);
 else if(operation==='delete')await runtime.query('DELETE FROM sourcing_manual_prospect_attempts WHERE id=$1',[source.id]);
 else if(operation==='candidate_revision')await runtime.query('UPDATE sourcing_candidates SET revision=revision+1 WHERE id=$1',[source.candidate_id]);
 else await runtime.query(`UPDATE sourcing_candidates SET source_check='{"state":"unavailable","reason":"source_not_permitted"}'::jsonb WHERE id=$1`,[source.candidate_id]);
 expect((await runtime.query('SELECT content,reason,revision FROM calling_follow_up_drafts WHERE id=$1',[id])).rows[0]).toMatchObject({content:null,reason:expect.any(String),revision:expect.any(Number)});
});
it('canonical log correction/deletion and creator loss clear content without deleting opaque draft identity',async()=>{
 const runtime=await db.appRuntimeSession(),workspace=seeded.alpha.workspaceId,user=seeded.alpha.salesperson.userId;
 const firm=(await runtime.query<{id:string}>('INSERT INTO firms(workspace_id,name,assigned_user_id) VALUES($1,$2,$3) RETURNING id',[workspace,'Synthetic canonical draft parent',user])).rows[0]!.id;
 for(const change of ['note','delete','creator']){
  const call=(await runtime.query<{id:string}>(`INSERT INTO call_logs(workspace_id,firm_id,outcome,step_effect,occurred_at,actor_user_id) VALUES($1,$2,'not_interested','none',clock_timestamp()-interval '1 second',$3) RETURNING id`,[workspace,firm,user])).rows[0]!.id,id=randomUUID();
  await runtime.query(`INSERT INTO calling_follow_up_drafts(workspace_id,id,creator_user_id,creator_ref,source_kind,firm_id,call_log_id,call_log_ref,content) VALUES($1,$2,$3,$3,'firm',$4,$5,$5,$6::jsonb)`,[workspace,id,user,firm,call,JSON.stringify(content)]);
  if(change==='note')await runtime.query("UPDATE call_logs SET note='Synthetic corrected private note' WHERE id=$1",[call]);else if(change==='delete')await runtime.query('DELETE FROM call_logs WHERE id=$1',[call]);else await runtime.query("UPDATE workspace_memberships SET status='inactive' WHERE workspace_id=$1 AND user_id=$2",[workspace,user]);
  expect((await runtime.query('SELECT content,reason FROM calling_follow_up_drafts WHERE id=$1',[id])).rows[0]).toMatchObject({content:null,reason:expect.any(String)});
 }
});
