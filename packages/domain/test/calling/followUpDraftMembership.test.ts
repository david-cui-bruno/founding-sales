import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable,type QueryResultRowLike} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {readCallingDraft,saveCallingDraft} from '../../calling/followUpDrafts.ts';
import {CallingAuthorityChanged} from '../../calling/followUpDraftAccess.ts';
let db:TestDatabase,seed:TwoWorkspaces;
const authority=async()=>true;
function latch(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
beforeAll(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);console.info('Calling correction membership DB',{database:db.name,template:process.env['FSS_TEST_TEMPLATE_DATABASE'],port:new URL(process.env['FSS_TEST_CLUSTER_URL']!).port});});
afterAll(async()=>db?.drop());
const cases=(['read','update'] as const).flatMap(operation=>(['deactivation','role'] as const).flatMap(change=>(['membership','operation'] as const).map(winner=>({operation,change,winner}))));
it.each(cases)('$operation versus $change, $winner obtains membership first, serializes and erases without deadlock',async({operation,change,winner})=>{
 const workspace=seed.alpha.workspaceId,user=seed.alpha.admin.userId;
 await db.session.query("UPDATE workspace_memberships SET role='admin',status='active',deactivated_at=NULL WHERE workspace_id=$1 AND user_id=$2",[workspace,user]);
 const firm=(await db.session.query<{id:string}>('INSERT INTO firms(workspace_id,name,assigned_user_id) VALUES($1,$2,$3) RETURNING id',[workspace,'Synthetic lock-order correction Firm',user])).rows[0]!.id;
 const log=(await db.session.query<{id:string}>("INSERT INTO call_logs(workspace_id,firm_id,outcome,step_effect,occurred_at,actor_user_id) VALUES($1,$2,'not_interested','none',now(),$3) RETURNING id",[workspace,firm,user])).rows[0]!.id;
 const draft=randomUUID();await db.session.query(`INSERT INTO calling_follow_up_drafts(workspace_id,id,creator_user_id,creator_ref,source_kind,firm_id,call_log_id,call_log_ref,content) VALUES($1,$2,$3,$3,'firm',$4,$5,$5,$6::jsonb)`,[workspace,draft,user,firm,log,JSON.stringify({subject:'Synthetic independent promise',body:'Synthetic independently authored body'})]);
 const worker=await db.appRuntimeSession(),updater=await db.appRuntimeSession();await updater.query('RESET ROLE');
 const workerPid=(await worker.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid,updatePid=(await updater.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
 await worker.query("SET statement_timeout='6s'");await updater.query("SET statement_timeout='6s'");
 const paused=latch(),resume=latch(),order:string[]=[];let intercepted=false;
 const instrumented:SessionQueryable={async query<Row extends QueryResultRowLike>(text:string,values?:readonly unknown[]){
  const membership=text.startsWith('SELECT user_id FROM workspace_memberships')&&text.endsWith('FOR SHARE');
  if(membership&&!intercepted&&winner==='membership'){intercepted=true;paused.release();await resume.promise;}
  const result=await worker.query<Row>(text,values);order.push(text);
  if(membership&&!intercepted&&winner==='operation'){intercepted=true;paused.release();await resume.promise;}
  return result;
 }};
 const context=repositoryContext(workspaceScope(workspace,{kind:'user',userId:user,role:'admin'}),instrumented),input={draftId:draft,expectedRevision:1};
 const running=withTransaction<unknown>(instrumented,()=>operation==='read'?readCallingDraft(context,input,authority):saveCallingDraft(context,{operation:'update',...input,subject:'Edited synthetic promise',body:'Edited independently'},authority)).then(value=>({value,error:null}),error=>({value:null,error: error as unknown}));
 let updateDone=false;
 expect(await Promise.race([paused.promise.then(()=>true),running.then(()=>false)])).toBe(true);
 const changing=withTransaction(updater,async()=>{await updater.query(change==='role'?"UPDATE workspace_memberships SET role='salesperson' WHERE workspace_id=$1 AND user_id=$2":"UPDATE workspace_memberships SET status='inactive',deactivated_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2",[workspace,user]);}).then(()=>({error:null}),error=>({error:error as unknown})).finally(()=>{updateDone=true;});
 try{
  await expect.poll(async()=>updateDone||(await db.session.query<{waiting:boolean}>("SELECT cardinality(pg_blocking_pids($1))>0 waiting",[updatePid])).rows[0]!.waiting,{timeout:3000}).toBe(true);
  if(winner==='operation')expect(updateDone).toBe(false);
 }finally{resume.release();}
 const [finished,changed]=await Promise.all([running,changing]);expect(changed.error).toBeNull();
 if(winner==='membership')expect(finished.error).toBeInstanceOf(CallingAuthorityChanged);
 else{expect(finished.error).toBeNull();expect(finished.value).toMatchObject(operation==='read'?{availability:'available'}:{ok:true,value:{revision:2}});}
 expect((await db.session.query('SELECT content,reason FROM calling_follow_up_drafts WHERE workspace_id=$1 AND id=$2',[workspace,draft])).rows).toEqual([{content:null,reason:'removed'}]);
 const memberIndex=order.findIndex(sql=>sql.startsWith('SELECT user_id FROM workspace_memberships')),draftIndex=order.findIndex(sql=>sql.includes('FROM calling_follow_up_drafts')&&sql.endsWith('FOR UPDATE'));
 if(draftIndex>=0)expect(memberIndex).toBeLessThan(draftIndex);
 const fresh=repositoryContext(workspaceScope(workspace,{kind:'user',userId:user,role:'admin'}),worker);await expect(withTransaction(worker,()=>readCallingDraft(fresh,{draftId:draft,expectedRevision:operation==='update'&&winner==='operation'?3:2},authority))).rejects.toBeInstanceOf(CallingAuthorityChanged);
 console.info('Calling membership interleaving',{operation,change,winner,workerPid,updatePid,membershipBeforeDraft:draftIndex<0||memberIndex<draftIndex});
});
