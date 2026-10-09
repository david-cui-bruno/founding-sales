import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import type {SessionQueryable} from '../../db/queryable.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from './support/fixtures.ts';
let database:TestDatabase,seeded:TwoWorkspaces;
const hash='a'.repeat(64),context={personId:null,firmIds:[],relationships:[],review:'current'},closure={firmIds:[],personIds:[]};
beforeAll(async()=>{database=await createTestDatabase();seeded=await seedTwoWorkspaces(database.session);});
afterAll(async()=>{await database.drop();});
async function fixture(){const requestId=randomUUID(),sourceId=randomUUID();await database.session.query(`INSERT INTO crm_ask_requests(workspace_id,id,owner_user_id,question,scope,initial_contexts,initial_access_closure,state) VALUES($1,$2,$3,'What was promised?',$4::jsonb,$5::jsonb,$6::jsonb,'pending')`,[seeded.alpha.workspaceId,requestId,seeded.alpha.salesperson.userId,JSON.stringify({sources:[{workspaceId:seeded.alpha.workspaceId,sourceId,kind:'selected_note',revision:1,contentHash:hash,locator:null}]}),JSON.stringify([context]),JSON.stringify(closure)]);return {requestId,sourceId};}
async function insertWindow(f:{requestId:string;sourceId:string},version=1,epoch=1,session:SessionQueryable=database.session){return session.query(`INSERT INTO crm_ask_request_windows(workspace_id,request_id,request_version,request_epoch,ordinal,source_kind,source_id,source_revision,source_hash,locator,context_hash,text_hash,group_hash,context_snapshot,original_access_closure) VALUES($1,$2,$3,$4,1,'selected_note',$5,1,$6,'text:0:4',$6,$6,$6,$7::jsonb,$8::jsonb)`,[seeded.alpha.workspaceId,f.requestId,version,epoch,f.sourceId,hash,JSON.stringify(context),JSON.stringify(closure)]);}
it('admits an exact pending window and refuses duplicate ordinal proof',async()=>{const f=await fixture();await expect(insertWindow(f)).resolves.toMatchObject({rowCount:1});await expect(insertWindow(f)).rejects.toMatchObject({code:'23505',constraint:'crm_ask_request_windows_workspace_id_request_id_request_ver_key'});});
it.each(['stale','deleted'] as const)('refuses late private window proof after parent becomes %s',async state=>{const f=await fixture();if(state==='deleted')await database.session.query("UPDATE crm_ask_requests SET state='deleted',question=NULL,scope=NULL,initial_contexts=NULL,initial_access_closure=NULL,version=version+1,epoch=epoch+1 WHERE workspace_id=$1 AND id=$2",[seeded.alpha.workspaceId,f.requestId]);else await database.session.query("UPDATE crm_ask_requests SET state='stale',question=NULL,version=version+1,epoch=epoch+1 WHERE workspace_id=$1 AND id=$2",[seeded.alpha.workspaceId,f.requestId]);await expect(insertWindow(f)).rejects.toMatchObject({code:'23514',constraint:'crm_ask_window_current_request'});});
it.each(['version','epoch','source'] as const)('refuses a valid but mismatched window %s',async mismatch=>{const f=await fixture();await expect(insertWindow(mismatch==='source'?{...f,sourceId:randomUUID()}:f,mismatch==='version'?2:1,mismatch==='epoch'?2:1)).rejects.toMatchObject({code:'23514',constraint:'crm_ask_window_current_request'});});

it('waits on the parent and refuses private proof when erasure commits first',async()=>{
 const f=await fixture(),writer=await database.appRuntimeSession();
 const pid=(await writer.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
 await database.session.query('BEGIN');
 let insertion:Promise<{accepted:boolean;constraint:string|null}>|undefined;
 try{
  await database.session.query("UPDATE crm_ask_requests SET state='deleted',question=NULL,scope=NULL,initial_contexts=NULL,initial_access_closure=NULL,version=version+1,epoch=epoch+1 WHERE workspace_id=$1 AND id=$2",[seeded.alpha.workspaceId,f.requestId]);
  insertion=insertWindow(f,1,1,writer).then(()=>({accepted:true,constraint:null}),error=>({accepted:false,constraint:typeof error==='object'&&error!==null&&'constraint' in error?String(error.constraint):null}));
  let blocked=false;
  for(let attempt=0;attempt<100;attempt++){
   blocked=(await database.session.query<{blocked:boolean}>('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',[pid])).rows[0]!.blocked;
   if(blocked)break;
   await new Promise(resolve=>setTimeout(resolve,5));
  }
  expect(blocked).toBe(true);
  await database.session.query('COMMIT');
  expect(await insertion).toEqual({accepted:false,constraint:'crm_ask_window_current_request'});
  expect((await writer.query<{count:string}>('SELECT count(*) AS count FROM crm_ask_request_windows WHERE workspace_id=$1 AND request_id=$2',[seeded.alpha.workspaceId,f.requestId])).rows[0]!.count).toBe('0');
 }finally{await database.session.query('ROLLBACK');await insertion;}
});
it('removes all existing private window proofs when a request tombstone is saved',async()=>{
 const f=await fixture();await insertWindow(f);
 await database.session.query("UPDATE crm_ask_requests SET state='deleted',question=NULL,scope=NULL,initial_contexts=NULL,initial_access_closure=NULL,version=version+1,epoch=epoch+1 WHERE workspace_id=$1 AND id=$2",[seeded.alpha.workspaceId,f.requestId]);
 expect((await database.session.query<{count:string}>('SELECT count(*) AS count FROM crm_ask_request_windows WHERE workspace_id=$1 AND request_id=$2',[seeded.alpha.workspaceId,f.requestId])).rows[0]!.count).toBe('0');
});
