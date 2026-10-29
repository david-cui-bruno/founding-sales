import {expect,it} from 'vitest';
import type {SessionQueryable,QueryResultRowLike} from '@fss/domain/db/queryable.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {eraseSocialPublicThreadByIdentity} from '@fss/domain/social/publicThreadRetention.ts';
import {socialPublicThreadReadSchema} from '@fss/contracts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {publicThreadApiFixture} from './support/publicThreadFixture.ts';

// Actual signed/app_runtime cases are authored only; Root allocates the PG lease.
it('signed reads expose metadata then exact owner revision, reject mixed scope/writers, and leave channel/model/job state unchanged',async()=>{
 const a=await publicThreadApiFixture();try{
 const input=await a.capture(),tables=['social_posts','social_deliveries','social_draft_requests','provider_reservations','outbound_messages','jobs'];
 const counts=async()=>Promise.all(tables.map(async table=>(await a.runtime.query(`SELECT count(*)::int n FROM ${table}`)).rows[0]?.['n']));const before=await counts();
 const list=await a.call('/social/threads/list',{});expect(list.status).toBe(200);expect(JSON.stringify(list.body)).not.toContain(input.snapshot.messages[0]!.text);expect(JSON.stringify(list.body)).not.toContain(input.snapshot.url);
 expect(await a.call('/social/threads/read',{threadId:input.threadId,expectedRevision:1})).toMatchObject({status:200,body:{thread:{availability:'available',snapshot:input.snapshot}}});
 expect(await a.call('/social/threads/read',{threadId:input.threadId,expectedRevision:2})).toMatchObject({status:200,body:{thread:{availability:'unavailable',reason:'revision_changed'}}});
 expect(await a.call('/social/threads/read',{threadId:input.threadId,expectedRevision:1,accountId:input.threadId})).toMatchObject({status:400});
 expect(await a.call('/social/threads/capture',input)).toMatchObject({status:404});
 const other=await issueSessionFor(a.f,a.f.beta,a.f.beta.admin);
 expect(await a.call('/social/threads/read',{threadId:input.threadId,expectedRevision:1},a.runtime,other.accessToken)).toMatchObject({status:404});
 const salesperson=await issueSessionFor(a.f,a.f.alpha,a.f.alpha.salesperson);
 expect(await a.call('/social/threads/read',{threadId:input.threadId,expectedRevision:1},a.runtime,salesperson.accessToken)).toMatchObject({status:404});expect(await counts()).toEqual(before);
 }finally{await a.close();}
});
it('performs no post-COMMIT auth/source wait that could export original bytes after exact source erasure',async()=>{
 const a=await publicThreadApiFixture();try{
 const input=await a.capture();let committed=false,afterCommitQueries=0;
 const cleanup=repositoryContext(workspaceScope(a.f.alpha.workspaceId,{kind:'system',component:'worker'}),a.f.db);
 const observing:SessionQueryable={query:async<Row extends QueryResultRowLike=QueryResultRowLike>(sql:string,values?:readonly unknown[])=>{
  if(committed){afterCommitQueries++;await eraseSocialPublicThreadByIdentity(cleanup,{ownerUserId:a.f.alpha.admin.userId,url:input.snapshot.url});}
  const answer=await a.runtime.query<Row>(sql,values);if(sql==='COMMIT')committed=true;return answer;
 }};
 const answer=await a.call('/social/threads/read',{threadId:input.threadId,expectedRevision:1},observing);
 expect(afterCommitQueries).toBe(0);expect(answer.status).toBe(200);expect(socialPublicThreadReadSchema.parse(answer.body).thread.availability).toBe('available');
 // With the former post-commit auth await, interception above actually erases
 // this original before auth returns; that old path fails the zero-wait assertion.
 }finally{await a.close();}
});
it.each(['final_auth','commit'] as const)('withholds source prose when source expiry crosses %s while the original principal remains valid',async pause=>{
 const a=await publicThreadApiFixture();try{
 const input=await a.capture(new Date(Date.now()+5*60*1000).toISOString());let originalRead=false,advanced=false;
 const observing:SessionQueryable={query:async<Row extends QueryResultRowLike=QueryResultRowLike>(sql:string,values?:readonly unknown[])=>{
  if(sql.startsWith('SELECT * FROM social_public_threads'))originalRead=true;
  const answer=await a.runtime.query<Row>(sql,values);
  if(!advanced&&((pause==='commit'&&sql==='COMMIT')||(pause==='final_auth'&&originalRead&&sql.includes('FROM sessions')&&sql.includes('FOR SHARE')))){advanced=true;a.f.advance(6*60*1000);}
  return answer;
 }};
 const answer=await a.call('/social/threads/read',{threadId:input.threadId,expectedRevision:1},observing);
 expect(advanced).toBe(true);expect(answer).toMatchObject({status:200,body:{thread:{availability:'unavailable',reason:'expired'}}});expect(JSON.stringify(answer.body)).not.toContain(input.snapshot.messages[0]!.text);
 }finally{await a.close();}
});
it('refuses the original principal deadline crossing COMMIT without another auth query',async()=>{
 const a=await publicThreadApiFixture();try{
 const input=await a.capture();let committed=false,afterCommitQueries=0;
 const observing:SessionQueryable={query:async<Row extends QueryResultRowLike=QueryResultRowLike>(sql:string,values?:readonly unknown[])=>{
  if(committed)afterCommitQueries++;const answer=await a.runtime.query<Row>(sql,values);if(sql==='COMMIT'){committed=true;a.f.advance(61*60*1000);}return answer;
 }};
 expect(await a.call('/social/threads/read',{threadId:input.threadId,expectedRevision:1},observing)).toMatchObject({status:401});expect(afterCommitQueries).toBe(0);
 }finally{await a.close();}
});
it('reauthenticates the real device after a controlled thread-row wait and returns no original after revocation',async()=>{
 const a=await publicThreadApiFixture();try{
 const input=await a.capture(),blocker=await a.f.database.appRuntimeSession(),pid=Number((await a.runtime.query('SELECT pg_backend_pid() pid')).rows[0]?.['pid']);
 await blocker.query('BEGIN');await blocker.query('SELECT id FROM social_public_threads WHERE id=$1 FOR UPDATE',[input.threadId]);
 const reading=a.call('/social/threads/read',{threadId:input.threadId,expectedRevision:1});
 try{
  let waiting=false;for(let i=0;i<100;i++){if((await a.f.db.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'",[pid])).rows.length){waiting=true;break;}await a.f.db.query('SELECT pg_sleep(0.01)');}
  expect(waiting).toBe(true);await a.f.db.query("UPDATE devices SET status='revoked',revoked_at=clock_timestamp() WHERE id=$1",[a.issued.deviceId]);
 }finally{await blocker.query('ROLLBACK');}
 const answer=await reading;expect(answer.status).toBe(401);expect(JSON.stringify(answer.body)).not.toContain(input.snapshot.messages[0]!.text);
 }finally{await a.close();}
});
