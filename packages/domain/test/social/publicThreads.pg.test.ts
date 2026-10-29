import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable,type QueryResultRowLike} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces} from '../db/support/fixtures.ts';
import {databaseNow} from '../../policy/clock.ts';
import {retainSocialPublicThread,listSocialPublicThreads,readSocialPublicThread,PublicThreadAuthorityChanged} from '../../social/publicThreads.ts';
import {eraseSocialPublicThreadByIdentity,eraseSocialPublicThreadsForOwner} from '../../social/publicThreadRetention.ts';
import {runRetentionBatch} from '../../retention/runs.ts';
import {publicThreadFixture,publicThreadFixtureUrl} from './publicThreadFixture.ts';
let database:Awaited<ReturnType<typeof createTestDatabase>>,seed:Awaited<ReturnType<typeof seedTwoWorkspaces>>,runtime:SessionQueryable;
const authority={authority:async()=>true,publicationNow:(now:number)=>now};
const ctx=(beta=false,session=runtime)=>{const s=beta?seed.beta:seed.alpha;return repositoryContext(workspaceScope(s.workspaceId,{kind:'user',userId:s.admin.userId,role:'admin'}),session);};
const system=()=>repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'system',component:'worker'}),runtime);
const tx=<T>(work:()=>Promise<T>)=>withTransaction(runtime,work);
async function retain(sourceExpiresAt:string|null=null){
 const input=publicThreadFixture(await databaseNow(ctx()),undefined,sourceExpiresAt);
 expect(await tx(()=>retainSocialPublicThread(ctx(),input,authority))).toMatchObject({ok:true,value:{threadId:input.threadId,revision:1}});return input;
}
async function stored(id:string){return (await runtime.query('SELECT * FROM social_public_threads WHERE workspace_id=$1 AND id=$2',[seed.alpha.workspaceId,id])).rows[0];}
function erased(row:Record<string,unknown>|undefined){expect(row).toMatchObject({revision:2,source_url:null,payload:null,payload_sha256:null,coverage:null,message_count:null});}
async function locked(pid:number){for(let i=0;i<100;i++){
 if((await database.session.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'",[pid])).rows.length)return;
 await database.session.query('SELECT pg_sleep(0.01)');
 }throw Error('Controlled row wait not reached');}
beforeAll(async()=>{
 database=await createTestDatabase();seed=await seedTwoWorkspaces(database.session);runtime=await database.appRuntimeSession();
 // Keep the real last-active-admin guard while testing this owner's departure.
 await database.session.query("UPDATE workspace_memberships SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[seed.alpha.workspaceId,seed.alpha.salesperson.userId]);
});
afterAll(async()=>database?.drop());
it('normal internal owner retains exact bounded bytes, metadata list excludes all source content, and exact owner/revision gates the original',async()=>{
 const input=await retain(),list=await tx(()=>listSocialPublicThreads(ctx(),undefined,authority));
 expect(list.threads.find(row=>row.threadId===input.threadId)).toMatchObject({availability:'available',messageCount:2,coverage:'partial'});
 for(const value of [input.snapshot.url,input.snapshot.messages[0]!.text,'Fictional Author','textSHA256'])expect(JSON.stringify(list)).not.toContain(value);
 expect(await tx(()=>readSocialPublicThread(ctx(),{threadId:input.threadId,expectedRevision:1},authority))).toMatchObject({availability:'available',snapshot:input.snapshot});
 expect(await tx(()=>readSocialPublicThread(ctx(),{threadId:input.threadId,expectedRevision:2},authority))).toMatchObject({availability:'unavailable',reason:'revision_changed'});
 expect(await tx(()=>readSocialPublicThread(ctx(true),{threadId:input.threadId,expectedRevision:1},authority))).toBeNull();
 expect((await stored(input.threadId))?.['payload']).toBe(JSON.stringify(input.snapshot));
});
it('paginates metadata at20 without source excerpts or reinterpreting the cursor',async()=>{
 for(let i=0;i<21;i++)await retain();
 const first=await tx(()=>listSocialPublicThreads(ctx(),undefined,authority));expect(first.threads).toHaveLength(20);expect(first.nextAfterId).toBe(first.threads.at(-1)?.threadId);
 const second=await tx(()=>listSocialPublicThreads(ctx(),first.nextAfterId??undefined,authority));expect(second.threads.length).toBeGreaterThan(0);
 expect(second.threads.every(row=>row.threadId>first.nextAfterId!)).toBe(true);
});
it('preserves opaque identity after exact source erasure, refuses replacement or resurrection, and leaves a different source alone',async()=>{
 const input=await retain(),other=publicThreadFixture(await databaseNow(ctx()));other.snapshot.url=other.snapshot.url.replace('1234567890','9876543210');
 for(const message of other.snapshot.messages)message.locator.threadUrl=other.snapshot.url;
 expect(await tx(()=>retainSocialPublicThread(ctx(),other,authority))).toMatchObject({ok:true});
 expect(await tx(()=>eraseSocialPublicThreadByIdentity(system(),{ownerUserId:seed.alpha.admin.userId,url:publicThreadFixtureUrl}))).toBeGreaterThan(0);
 erased(await stored(input.threadId));expect((await stored(other.threadId))?.['reason']).toBeNull();
 const replacement=publicThreadFixture(await databaseNow(ctx()),input.threadId);
 expect(await tx(()=>retainSocialPublicThread(ctx(),replacement,authority))).toEqual({ok:false,reason:'identity_already_retained'});
 expect(await tx(()=>readSocialPublicThread(ctx(),{threadId:input.threadId,expectedRevision:1},authority))).toMatchObject({availability:'unavailable',reason:'revision_changed'});
 expect(await tx(()=>readSocialPublicThread(ctx(),{threadId:input.threadId,expectedRevision:2},authority))).toMatchObject({availability:'unavailable',reason:'removed'});
 erased(await stored(input.threadId));
});
it('raw app_runtime cannot delete the barrier, change identity/expiry/content or restore terminal bytes',async()=>{
 const now=await databaseNow(ctx()),input=await retain(new Date(Date.parse(now)+86400000).toISOString());
 await expect(tx(()=>runtime.query('DELETE FROM social_public_threads WHERE id=$1',[input.threadId]))).rejects.toMatchObject({code:'42501'});
 for(const sql of ["UPDATE social_public_threads SET expires_at=expires_at+interval '1 day' WHERE id=$1",
  'UPDATE social_public_threads SET owner_user_id=$2 WHERE id=$1',"UPDATE social_public_threads SET payload=payload||' ' WHERE id=$1"])
  await expect(tx(()=>runtime.query(sql,sql.includes('$2')?[input.threadId,randomUUID()]:[input.threadId]))).rejects.toMatchObject({code:'23514',constraint:'social_public_thread_immutable'});
 await tx(()=>eraseSocialPublicThreadsForOwner(system(),seed.alpha.admin.userId));
 await expect(tx(()=>runtime.query("UPDATE social_public_threads SET reason=NULL,revision=1,source_url=$2,payload=$3,payload_sha256=$4,coverage='partial',message_count=2 WHERE id=$1",
 [input.threadId,input.snapshot.url,JSON.stringify(input.snapshot),'a'.repeat(64)]))).rejects.toMatchObject({code:'23514',constraint:'social_public_thread_immutable'});
 erased(await stored(input.threadId));
});
it('normal registered research_evidence sweep erases an expired public original even when there are no expiring evidence_items',async()=>{
 const now=await databaseNow(ctx()),input=await retain(new Date(Date.parse(now)+250).toISOString());
 expect((await runtime.query('SELECT id FROM evidence_items WHERE workspace_id=$1',[seed.alpha.workspaceId])).rows).toEqual([]);
 await runtime.query('SELECT pg_sleep(0.3)');
 const report=await tx(()=>runRetentionBatch(system(),{dataKind:'research_evidence',period:new Date().toISOString().slice(0,10),limit:100}));
 expect(report).toMatchObject({outcome:'swept',detail:{social_public_threads:1}});erased(await stored(input.threadId));expect((await stored(input.threadId))?.['reason']).toBe('expired');
});
it('registered cleanup acquires public-thread rows only after the existing phone sweep and evidence-source branch',async()=>{
 const now=await databaseNow(ctx()),input=await retain(new Date(Date.parse(now)+250).toISOString());await runtime.query('SELECT pg_sleep(0.3)');
 let phone=false,evidence=false,thread=false;
 const observing:SessionQueryable={query:async<Row extends QueryResultRowLike=QueryResultRowLike>(sql:string,values?:readonly unknown[])=>{
  if(sql.includes('sweep_prospect_phone_discoveries('))phone=true;
  if(sql.includes('FROM evidence_items'))evidence=true;
  if(sql.includes('UPDATE social_public_threads')){expect(phone).toBe(true);expect(evidence).toBe(true);thread=true;}
  return runtime.query<Row>(sql,values);
 }};
 const context=repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'system',component:'worker'}),observing);
 await withTransaction(observing,()=>runRetentionBatch(context,{dataKind:'research_evidence',period:new Date(Date.now()+86400000).toISOString().slice(0,10),limit:100}));
 expect(thread).toBe(true);erased(await stored(input.threadId));
});
it('deadline crossing an actual thread-row wait clears physical bytes and returns no original',async()=>{
 const now=await databaseNow(ctx()),input=await retain(new Date(Date.parse(now)+500).toISOString()),blocker=await database.appRuntimeSession();
 const pid=Number((await runtime.query('SELECT pg_backend_pid() pid')).rows[0]?.['pid']);
 await blocker.query('BEGIN');await blocker.query('SELECT id FROM social_public_threads WHERE id=$1 FOR UPDATE',[input.threadId]);
 const reading=tx(()=>readSocialPublicThread(ctx(),{threadId:input.threadId,expectedRevision:1},authority));
 try{await locked(pid);await blocker.query('SELECT pg_sleep(0.55)');}finally{await blocker.query('COMMIT');}
 expect(await reading).toMatchObject({availability:'unavailable',reason:'expired'});erased(await stored(input.threadId));
});
it('authority lost during the row wait rejects instead of releasing retained text',async()=>{
 const input=await retain(),blocker=await database.appRuntimeSession();let current=true;
 const pid=Number((await runtime.query('SELECT pg_backend_pid() pid')).rows[0]?.['pid']);
 await blocker.query('BEGIN');await blocker.query('SELECT id FROM social_public_threads WHERE id=$1 FOR UPDATE',[input.threadId]);
 const reading=tx(()=>readSocialPublicThread(ctx(),{threadId:input.threadId,expectedRevision:1},{authority:async()=>current,publicationNow:now=>current?now:null}));
 const rejected=expect(reading).rejects.toBeInstanceOf(PublicThreadAuthorityChanged);
 try{await locked(pid);current=false;}finally{await blocker.query('ROLLBACK');}await rejected;
 expect((await stored(input.threadId))?.['payload']).toBe(JSON.stringify(input.snapshot));
});
it('a role loss committed during the retaining membership wait refuses insertion instead of retaining under stale admin scope',async()=>{
 const input=publicThreadFixture(await databaseNow(ctx())),blocker=await database.appRuntimeSession(),w=seed.alpha.workspaceId,u=seed.alpha.admin.userId;
 const pid=Number((await runtime.query('SELECT pg_backend_pid() pid')).rows[0]?.['pid']);
 await blocker.query('BEGIN');await blocker.query("UPDATE workspace_memberships SET role='salesperson' WHERE workspace_id=$1 AND user_id=$2",[w,u]);
 const retaining=tx(()=>retainSocialPublicThread(ctx(),input,authority));
 try{await locked(pid);}finally{await blocker.query('COMMIT');}
 try{expect(await retaining).toEqual({ok:false,reason:'owner_unavailable'});expect(await stored(input.threadId)).toBeUndefined();}
 finally{await database.session.query("UPDATE workspace_memberships SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[w,u]);}
});
it.each(['role','inactive','delete'] as const)('owner %s loss erases source bytes without deleting or reactivating the terminal barrier',async change=>{
 const input=await retain(),w=seed.alpha.workspaceId,u=seed.alpha.admin.userId;
 if(change==='delete'){
  // Fixture devices reference this membership; remove only this fictional owner's
  // devices, keeping other owners and the public-thread identity barrier intact.
  await database.session.query('DELETE FROM devices WHERE workspace_id=$1 AND user_id=$2',[w,u]);
  await database.session.query('DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2',[w,u]);
 }
 else await database.session.query(change==='role'?"UPDATE workspace_memberships SET role='salesperson' WHERE workspace_id=$1 AND user_id=$2":"UPDATE workspace_memberships SET status='inactive',deactivated_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2",[w,u]);
 erased(await stored(input.threadId));expect(await tx(()=>readSocialPublicThread(ctx(),{threadId:input.threadId,expectedRevision:1},authority))).toBeNull();
 if(change==='delete')await database.session.query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES($1,$2,'admin','active')",[w,u]);
 else await database.session.query("UPDATE workspace_memberships SET role='admin',status='active',deactivated_at=NULL WHERE workspace_id=$1 AND user_id=$2",[w,u]);
 erased(await stored(input.threadId));expect(await tx(()=>retainSocialPublicThread(ctx(),input,authority))).toEqual({ok:false,reason:'identity_already_retained'});
});
