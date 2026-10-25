import {randomUUID} from 'node:crypto';
import {it,expect} from 'vitest';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {dispatch} from '../src/server.ts';
import {payloadHashOf} from '../src/auth/tokens.ts';
const entries=()=>[{entryId:randomUUID(),dimension:'tone',guidance:'Use concise neutral language.'}];
it('signed app_runtime guide commands, CAS removal/restart, exact receipt binding and private projection',async()=>{
 const f=await createAuthFixture();try{
  const runtime=await f.database.appRuntimeSession(),auth={...f.deps,db:runtime};let token=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;
  const call=(path:string,body:unknown)=>dispatch({method:'POST',path,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`},body},{session:runtime,auth,supportedClientVersions:auth.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://fixture.invalid/update'});
  expect(await call('/social/voice-preferences/read',{})).toMatchObject({status:200,body:{guide:{state:'absent'}}});
  const payload={operation:'create',entries:entries()},command={...payload,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION};
  const saved=await call('/social/voice-preferences/save',command);expect(saved).toMatchObject({status:200,body:{status:'accepted',replayed:false,result:{revision:1}}});
  const result=(saved.body as {result:{guideId:string;revision:number}}).result;
  expect(await call('/social/voice-preferences/save',command)).toMatchObject({status:200,body:{status:'accepted',replayed:true,result}});
  expect(await call('/social/voice-preferences/save',{...command,entries:entries()})).toMatchObject({status:409,body:{reason:'command_payload_mismatch'}});
  const receipt={commandId:command.commandId,payloadSHA256:payloadHashOf(payload)};
  expect(await call('/social/voice-preferences/receipt',receipt)).toMatchObject({status:200,body:{state:'accepted',result}});
  for(const value of [{...receipt,payloadSHA256:'a'.repeat(64)},{...receipt,commandId:randomUUID()}])expect(await call('/social/voice-preferences/receipt',value)).toMatchObject({status:200,body:{state:'unknown'}});
  expect(await call('/social/voice-preferences/read',{})).toMatchObject({status:200,body:{guide:{state:'available',entries:payload.entries}}});
  for(const field of ['accountId','draftId','sourceId','facts','provider','publishAt'])expect(await call('/social/voice-preferences/save',{...command,commandId:randomUUID(),[field]:'forbidden'})).toMatchObject({status:400});
  const mutate=(operation:string,expectedRevision:number)=>call('/social/voice-preferences/save',{operation,guideId:result.guideId,expectedRevision,...(operation==='remove'?{}:{entries:entries()}),commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});
  expect(await mutate('update',1)).toMatchObject({status:200,body:{result:{revision:2}}});
  expect(await mutate('remove',2)).toMatchObject({status:200,body:{result:{revision:3}}});
  const stale={operation:'update',guideId:result.guideId,expectedRevision:2,entries:entries()},staleCommand={...stale,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION};
  expect(await call('/social/voice-preferences/save',staleCommand)).toMatchObject({status:409,body:{reason:'stale_revision'}});
  expect(await call('/social/voice-preferences/receipt',{commandId:staleCommand.commandId,payloadSHA256:payloadHashOf(stale)})).toMatchObject({status:200,body:{state:'refused',reason:'stale_revision'}});
  expect((await runtime.query('SELECT entries FROM social_voice_preferences')).rows[0]?.['entries']).toBeNull();
  expect(await mutate('restart',3)).toMatchObject({status:200,body:{result:{guideId:result.guideId,revision:4}}});
  const stored=(await runtime.query('SELECT result FROM command_receipts WHERE command_id=$1',[command.commandId])).rows[0]?.['result'];expect(stored).toEqual(result);expect(JSON.stringify(stored)).not.toContain(payload.entries[0]!.guidance);
  token=(await issueSessionFor(f,f.alpha,f.alpha.salesperson)).accessToken;expect(await call('/social/voice-preferences/read',{})).toMatchObject({status:200,body:{guide:{state:'absent'}}});expect(await call('/social/voice-preferences/receipt',receipt)).toMatchObject({status:200,body:{state:'unknown'}});expect(await mutate('remove',4)).toMatchObject({status:409,body:{reason:'not_found'}});
  token=(await issueSessionFor(f,f.beta,f.beta.admin)).accessToken;expect(await call('/social/voice-preferences/read',{})).toMatchObject({status:200,body:{guide:{state:'absent'}}});
 }finally{await f.stop();}
});
it('final retained principal after a real receipt insert wait rolls back expired command and receipt together',async()=>{
 const f=await createAuthFixture();try{
  const runtime=await f.database.appRuntimeSession(),writer=await f.database.appRuntimeSession(),auth={...f.deps,db:runtime},issued=await issueSessionFor(f,f.alpha,f.alpha.admin),commandId=randomUUID();
  await writer.query('BEGIN');await writer.query('LOCK TABLE command_receipts IN SHARE MODE');
  const pid=(await runtime.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
  const saving=dispatch({method:'POST',path:'/social/voice-preferences/save',query:new URLSearchParams(),headers:{authorization:`Bearer ${issued.accessToken}`},body:{operation:'create',entries:entries(),commandId,clientVersion:CURRENT_CLIENT_VERSION}},{session:runtime,auth,supportedClientVersions:auth.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://fixture.invalid/update'});
  try{await expect.poll(async()=>Boolean((await f.db.query('SELECT cardinality(pg_blocking_pids($1))>0 waiting',[pid])).rows[0]?.['waiting'])).toBe(true);f.advance(61*60*1000);}finally{await writer.query('COMMIT');}
  expect((await saving).status).toBe(401);expect((await f.db.query('SELECT count(*)::int n FROM social_voice_preferences')).rows[0]?.['n']).toBe(0);expect((await f.db.query('SELECT count(*)::int n FROM command_receipts WHERE command_id=$1',[commandId])).rows[0]?.['n']).toBe(0);expect((await f.db.query("SELECT count(*)::int n FROM audit_events WHERE action='social.voice_preferences_saved'")).rows[0]?.['n']).toBe(0);
 }finally{await f.stop();}
});
it.each(['device','session','membership','role'] as const)('real row wait rechecks current %s authority before command commit',async mode=>{
 const f=await createAuthFixture();try{
  const runtime=await f.database.appRuntimeSession(),writer=await f.database.appRuntimeSession(),auth={...f.deps,db:runtime},issued=await issueSessionFor(f,f.alpha,f.alpha.admin);
  const p=(await runtime.query<{device_id:string;id:string}>("SELECT id,device_id FROM sessions WHERE status='active' LIMIT 1")).rows[0]!;
  // Membership wait precedes guide access. Device/session waits occur at retained authority.
  await writer.query('BEGIN');
  if(mode==='device')await writer.query('SELECT id FROM devices WHERE id=$1 FOR UPDATE',[p.device_id]);
  else if(mode==='session')await writer.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE',[p.id]);
  else await writer.query('SELECT user_id FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE',[f.alpha.workspaceId,f.alpha.admin.userId]);
  const pid=(await runtime.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
  const commandId=randomUUID(),saving=dispatch({method:'POST',path:'/social/voice-preferences/save',query:new URLSearchParams(),headers:{authorization:`Bearer ${issued.accessToken}`},body:{operation:'create',entries:entries(),commandId,clientVersion:CURRENT_CLIENT_VERSION}},{session:runtime,auth,supportedClientVersions:auth.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://fixture.invalid/update'});
  try{
   await expect.poll(async()=>Boolean((await f.db.query('SELECT cardinality(pg_blocking_pids($1))>0 waiting',[pid])).rows[0]?.['waiting'])).toBe(true);
   if(mode==='device')await writer.query("UPDATE devices SET status='revoked',revoked_at=now() WHERE id=$1",[p.device_id]);
   else if(mode==='session')await writer.query("UPDATE sessions SET status='ended',ended_at=now(),end_reason='signed_out' WHERE id=$1",[p.id]);
   else{await writer.query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES($1,$2,'admin','active')",[f.alpha.workspaceId,f.beta.admin.userId]);await writer.query(mode==='role'?"UPDATE workspace_memberships SET role='salesperson' WHERE workspace_id=$1 AND user_id=$2":"UPDATE workspace_memberships SET status='inactive',deactivated_at=now() WHERE workspace_id=$1 AND user_id=$2",[f.alpha.workspaceId,f.alpha.admin.userId]);}
  }finally{await writer.query('COMMIT');}
  expect((await saving).status).toBe(401);expect((await f.db.query('SELECT count(*)::int n FROM social_voice_preferences')).rows[0]?.['n']).toBe(0);expect((await f.db.query('SELECT count(*)::int n FROM command_receipts WHERE command_id=$1',[commandId])).rows[0]?.['n']).toBe(0);
 }finally{await f.stop();}
});
