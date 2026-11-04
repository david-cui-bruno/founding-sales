import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {it,expect} from 'vitest';
import {socialFounderInputSavedSchema,socialGuidedRequestSavedSchema,SOCIAL_FOUNDER_INPUT_PROCESSING_SCOPE} from '@fss/contracts';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {dispatch} from '../src/server.ts';
import {payloadHashOf} from '../src/auth/tokens.ts';
const note={operation:'create',bullets:'Fictional public-safe college prototype observations.',context:'An explicitly supplied owner opinion.',experienceDate:null,publicSafe:true};
it('signed app_runtime current-only input commands expose opaque exact receipts, cross-owner reads refuse and stale CAS cannot resurrect removal',async()=>{
 const f=await createAuthFixture();try{
  const runtime=await f.database.appRuntimeSession(),auth={...f.deps,db:runtime};let token=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;
  const call=(path:string,body:unknown)=>dispatch({method:'POST',path,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`},body},{session:runtime,auth,supportedClientVersions:auth.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://fixture.invalid/update'});
  const command={...note,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION},saved=await call('/social/inputs/save',command);
  expect(saved).toMatchObject({status:200,body:{status:'accepted',replayed:false,result:{revision:1}}});
  const result=z.object({result:socialFounderInputSavedSchema}).parse(saved.body).result;
  expect(await call('/social/inputs/save',command)).toMatchObject({status:200,body:{status:'accepted',replayed:true,result}});
  const receipt={kind:'input',commandId:command.commandId,payloadSHA256:payloadHashOf(note)};
  expect(await call('/social/founder/receipt',receipt)).toMatchObject({status:200,body:{state:'accepted',result}});
  expect(await call('/social/founder/receipt',{...receipt,kind:'calibration'})).toMatchObject({status:200,body:{state:'unknown'}});
  expect(await call('/social/inputs/read',{inputId:result.inputId})).toMatchObject({status:200,body:{input:{state:'available',bullets:note.bullets,publicSafe:true}}});
  expect(await call('/social/inputs/save',{operation:'remove',inputId:result.inputId,expectedRevision:1,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION})).toMatchObject({status:200,body:{result:{revision:2}}});
  const stale={operation:'update',inputId:result.inputId,expectedRevision:1,bullets:note.bullets,context:note.context,experienceDate:null,publicSafe:true},staleCommand={...stale,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION};
  expect(await call('/social/inputs/save',staleCommand)).toMatchObject({status:409,body:{reason:'stale_revision'}});
  expect(await call('/social/founder/receipt',{kind:'input',commandId:staleCommand.commandId,payloadSHA256:payloadHashOf(stale)})).toMatchObject({status:200,body:{state:'refused',reason:'stale_revision'}});
  expect((await runtime.query('SELECT bullets,context FROM social_founder_inputs WHERE id=$1',[result.inputId])).rows[0]).toEqual({bullets:null,context:null});
  expect(JSON.stringify((await runtime.query('SELECT result FROM command_receipts WHERE command_id=$1',[command.commandId])).rows)).not.toContain(note.bullets);
  token=(await issueSessionFor(f,f.alpha,f.alpha.salesperson)).accessToken;
  expect(await call('/social/inputs/read',{inputId:result.inputId})).toMatchObject({status:404});expect(await call('/social/inputs/list',{})).toMatchObject({status:200,body:{inputs:[]}});expect(await call('/social/founder/receipt',receipt)).toMatchObject({status:200,body:{state:'unknown'}});
  token=(await issueSessionFor(f,f.beta,f.beta.admin)).accessToken;expect(await call('/social/inputs/read',{inputId:result.inputId})).toMatchObject({status:404});
 }finally{await f.stop();}
});
it('signed principal expiry across a real command-receipt wait rolls back note bytes and receipt',async()=>{
 const f=await createAuthFixture();try{
  const runtime=await f.database.appRuntimeSession(),writer=await f.database.appRuntimeSession(),auth={...f.deps,db:runtime},issued=await issueSessionFor(f,f.alpha,f.alpha.admin),commandId=randomUUID();
  await writer.query('BEGIN');await writer.query('LOCK TABLE command_receipts IN SHARE MODE');const pid=(await runtime.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
  const saving=dispatch({method:'POST',path:'/social/inputs/save',query:new URLSearchParams(),headers:{authorization:`Bearer ${issued.accessToken}`},body:{...note,commandId,clientVersion:CURRENT_CLIENT_VERSION}},{session:runtime,auth,supportedClientVersions:auth.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://fixture.invalid/update'});
  try{await expect.poll(async()=>Boolean((await f.db.query('SELECT cardinality(pg_blocking_pids($1))>0 waiting',[pid])).rows[0]?.['waiting'])).toBe(true);f.advance(61*60*1000);}finally{await writer.query('COMMIT');}
  expect((await saving).status).toBe(401);expect((await f.db.query('SELECT count(*)::int n FROM social_founder_inputs')).rows[0]?.['n']).toBe(0);expect((await f.db.query('SELECT count(*)::int n FROM command_receipts WHERE command_id=$1',[commandId])).rows[0]?.['n']).toBe(0);
 }finally{await f.stop();}
});
it('signed public-safe founder note requests without any guide retain current authority and admit ordinary private generation',async()=>{
 const f=await createAuthFixture();try{
  const runtime=await f.database.appRuntimeSession(),auth={...f.deps,db:runtime};let token=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;
  const call=(path:string,body:unknown)=>dispatch({method:'POST',path,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`},body},{session:runtime,auth,supportedClientVersions:auth.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://fixture.invalid/update'});
  const saved=await call('/social/inputs/save',{...note,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION}),ref=z.object({result:socialFounderInputSavedSchema}).parse(saved.body).result;
  const selection={mode:'linkedin_founder',sourceRefs:[],factBlocks:[],founderInputRefs:[ref],founderFormat:'opinion',founderInputProcessingScope:SOCIAL_FOUNDER_INPUT_PROCESSING_SCOPE},command={...selection,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION};
  const requested=await call('/social/drafts/request',command);expect(requested).toMatchObject({status:200,body:{status:'accepted',replayed:false}});
  const result=z.object({result:socialGuidedRequestSavedSchema}).parse(requested.body).result;
  expect(await call('/social/drafts/request',command)).toMatchObject({status:200,body:{status:'accepted',replayed:true,result}});
  expect(await call('/social/drafts/request/receipt',{commandId:command.commandId,payloadSHA256:payloadHashOf(selection)})).toMatchObject({status:200,body:{state:'accepted',result}});
  expect(await call('/social/drafts/read',result)).toMatchObject({status:200,body:{request:{state:'queued',mode:'linkedin_founder',founderInputRefs:[ref]}}});
  expect((await runtime.query('SELECT id FROM social_voice_preferences')).rows).toEqual([]);expect((await runtime.query('SELECT id FROM provider_reservations')).rows).toEqual([]);
  expect(JSON.stringify((await runtime.query("SELECT source_selection FROM social_draft_requests WHERE id=$1",[result.requestId])).rows)).not.toContain(note.bullets);
  token=(await issueSessionFor(f,f.alpha,f.alpha.salesperson)).accessToken;
  expect(await call('/social/drafts/request',{...command,commandId:randomUUID()})).toMatchObject({status:409});expect(await call('/social/drafts/read',result)).toMatchObject({status:404});
 }finally{await f.stop();}
});
it.each(['device','session','expiry'] as const)('guide-free founder admission refuses %s loss across an actual input-row wait without new request or receipt',async loss=>{
 const f=await createAuthFixture();try{
  const runtime=await f.database.appRuntimeSession(),writer=await f.database.appRuntimeSession(),observer=await f.database.appRuntimeSession(),auth={...f.deps,db:runtime},issued=await issueSessionFor(f,f.alpha,f.alpha.admin);
  const call=(path:string,body:unknown)=>dispatch({method:'POST',path,query:new URLSearchParams(),headers:{authorization:`Bearer ${issued.accessToken}`},body},{session:runtime,auth,supportedClientVersions:auth.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://fixture.invalid/update'});
  const saved=await call('/social/inputs/save',{...note,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION}),ref=z.object({result:socialFounderInputSavedSchema}).parse(saved.body).result;
  const sessionId=(await observer.query<{id:string}>('SELECT id FROM sessions WHERE device_id=$1 AND user_id=$2',[issued.deviceId,f.alpha.admin.userId])).rows[0]!.id;
  const commandId=randomUUID(),pid=(await runtime.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
  await writer.query('BEGIN');await writer.query('SELECT id FROM social_founder_inputs WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[f.alpha.workspaceId,ref.inputId]);
  const requesting=call('/social/drafts/request',{mode:'linkedin_founder',sourceRefs:[],factBlocks:[],founderInputRefs:[ref],founderFormat:'opinion',founderInputProcessingScope:SOCIAL_FOUNDER_INPUT_PROCESSING_SCOPE,commandId,clientVersion:CURRENT_CLIENT_VERSION});
  try{
   await expect.poll(async()=>Boolean((await observer.query('SELECT cardinality(pg_blocking_pids($1))>0 waiting',[pid])).rows[0]?.['waiting'])).toBe(true);
   if(loss==='device')await observer.query("UPDATE devices SET status='revoked',revoked_at=clock_timestamp() WHERE id=$1",[issued.deviceId]);
   if(loss==='session')await observer.query("UPDATE sessions SET status='ended',ended_at=clock_timestamp(),end_reason='signed_out' WHERE id=$1",[sessionId]);
   if(loss==='expiry')f.advance(61*60*1000);
  }finally{await writer.query('COMMIT');}
  expect(await requesting).toMatchObject({status:401});
  expect((await observer.query('SELECT id FROM social_draft_requests')).rows).toEqual([]);expect((await observer.query('SELECT command_id FROM command_receipts WHERE command_id=$1',[commandId])).rows).toEqual([]);
  expect((await observer.query('SELECT bullets FROM social_founder_inputs WHERE id=$1',[ref.inputId])).rows[0]?.['bullets']).toBe(note.bullets);
  expect((await observer.query('SELECT id FROM provider_reservations')).rows).toEqual([]);
 }finally{await f.stop();}
});
it.each(['before_commit','receipt_replay'] as const)('guide-free founder %s path rechecks the retained principal after a command-receipt wait',async phase=>{
 const f=await createAuthFixture();try{
  const runtime=await f.database.appRuntimeSession(),writer=await f.database.appRuntimeSession(),observer=await f.database.appRuntimeSession(),auth={...f.deps,db:runtime},issued=await issueSessionFor(f,f.alpha,f.alpha.admin);
  const call=(path:string,body:unknown)=>dispatch({method:'POST',path,query:new URLSearchParams(),headers:{authorization:`Bearer ${issued.accessToken}`},body},{session:runtime,auth,supportedClientVersions:auth.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://fixture.invalid/update'});
  const saved=await call('/social/inputs/save',{...note,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION}),ref=z.object({result:socialFounderInputSavedSchema}).parse(saved.body).result;
  const command={mode:'linkedin_founder',sourceRefs:[],factBlocks:[],founderInputRefs:[ref],founderFormat:'opinion',founderInputProcessingScope:SOCIAL_FOUNDER_INPUT_PROCESSING_SCOPE,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION};
  if(phase==='receipt_replay')expect(await call('/social/drafts/request',command)).toMatchObject({status:200,body:{status:'accepted'}});
  const before=(await observer.query('SELECT * FROM social_draft_requests')).rows,pid=(await runtime.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
  await writer.query('BEGIN');await writer.query(phase==='receipt_replay'?'LOCK TABLE command_receipts IN ACCESS EXCLUSIVE MODE':'LOCK TABLE command_receipts IN SHARE MODE');
  const requesting=call('/social/drafts/request',command);
  try{await expect.poll(async()=>Boolean((await observer.query('SELECT cardinality(pg_blocking_pids($1))>0 waiting',[pid])).rows[0]?.['waiting'])).toBe(true);f.advance(61*60*1000);}finally{await writer.query('COMMIT');}
  expect(await requesting).toMatchObject({status:401});expect((await observer.query('SELECT * FROM social_draft_requests')).rows).toEqual(before);
  expect((await observer.query('SELECT command_id FROM command_receipts WHERE command_id=$1',[command.commandId])).rows).toHaveLength(phase==='receipt_replay'?1:0);expect((await observer.query('SELECT id FROM provider_reservations')).rows).toEqual([]);
 }finally{await f.stop();}
});
