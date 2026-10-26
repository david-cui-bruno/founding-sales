import {randomUUID,createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {socialDraftViewSchema} from '@fss/contracts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {runSocialDraft} from '@fss/domain/social/draftRun.ts';
import {voiceGenerationSelection,fakeVoicePort,voiceText,voiceEntries} from '../../../packages/domain/test/social/voiceGenerationFixtures.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {payloadHashOf} from '../src/auth/tokens.ts';
import {dispatch} from '../src/server.ts';

/** Authored for Root's later database/network resource grant. This is the existing
 * API dispatch/command/app_runtime path, not hosted HTTPS or browser acceptance. */
it('existing signed request route retains opaque exact guide ref through fake generation, exact private adoption, reopen and refinement',async()=>{
 const f=await createAuthFixture();try{
  const runtime=await f.database.appRuntimeSession(),auth={...f.deps,db:runtime};
  let token=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;
  const call=(path:string,body:unknown)=>dispatch({method:'POST',path,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`},body},{session:runtime,auth,supportedClientVersions:auth.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://fixture.invalid/update'});
  const ctx=repositoryContext(workspaceScope(f.alpha.workspaceId,{kind:'user',userId:f.alpha.admin.userId,role:'admin'}),runtime);
  const selection=await withTransaction(runtime,()=>voiceGenerationSelection(ctx));
  const command={...selection,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION};
  expect(await call('/social/drafts/request',{...command,voiceGuideRef:{...selection.voiceGuideRef,entries:voiceEntries()}})).toMatchObject({status:400});
  const requested=await call('/social/drafts/request',command);expect(requested).toMatchObject({status:200,body:{status:'accepted',replayed:false}});
  const requestId=(requested.body as {result:{requestId:string}}).result.requestId;
  expect(await call('/social/drafts/request',command)).toMatchObject({status:200,body:{status:'accepted',replayed:true,result:{requestId}}});
  const worker=repositoryContext(workspaceScope(f.alpha.workspaceId,{kind:'system',component:'worker'}),runtime);await runSocialDraft(worker,requestId,fakeVoicePort());
  const ready=await call('/social/drafts/read',{requestId});expect(ready.status).toBe(200);
  const request=socialDraftViewSchema.parse((ready.body as {request:unknown}).request);expect(request).toMatchObject({state:'ready',voiceGuideRef:selection.voiceGuideRef});expect(JSON.stringify(request)).not.toContain('Prefer neutral precise');
  const origin={kind:'suggestion',requestId,conceptIndex:0,variantIndex:0,selectionSHA256:createHash('sha256').update(JSON.stringify({request,conceptIndex:0,variantIndex:0})).digest('hex')};
  const payload={operation:'create',kind:'post',text:voiceText,origin},save={...payload,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION};
  const saved=await call('/social/private-drafts/save',save);expect(saved).toMatchObject({status:200,body:{status:'accepted',replayed:false}});
  const result=(saved.body as {result:{draftId:string;revision:number}}).result;expect(JSON.stringify(saved.body)).not.toContain(voiceText);
  // Same UUID recovers a lost response. IDs/hash alone inspect the existing ledger,
  // never remint or replay a guessed payload. Absence remains UNKNOWN.
  expect(await call('/social/private-drafts/receipt',{commandId:save.commandId,payloadSHA256:payloadHashOf(payload)})).toMatchObject({status:200,body:{state:'accepted',result}});
  expect(await call('/social/private-drafts/receipt',{commandId:randomUUID(),payloadSHA256:payloadHashOf(payload)})).toMatchObject({status:200,body:{state:'unknown'}});
  expect(await call('/social/private-drafts/read',{draftId:result.draftId})).toMatchObject({status:200,body:{draft:{availability:'available',text:voiceText,origin}}});
  const refined=await call('/social/private-drafts/save',{operation:'update',draftId:result.draftId,expectedRevision:1,kind:'comment',text:'Private owner refinement, still bound to the exact source and guide.',commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});expect(refined).toMatchObject({status:200,body:{status:'accepted',result:{revision:2}}});
  expect(await call('/social/private-drafts/read',{draftId:result.draftId})).toMatchObject({status:200,body:{draft:{origin,revision:2,kind:'comment'}}});
  token=(await issueSessionFor(f,f.alpha,f.alpha.salesperson)).accessToken;expect(await call('/social/drafts/read',{requestId})).toMatchObject({status:404});expect(await call('/social/private-drafts/read',{draftId:result.draftId})).toMatchObject({status:404});
  token=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;
  expect(await call('/social/voice-preferences/save',{operation:'update',guideId:selection.voiceGuideRef!.guideId,expectedRevision:1,entries:voiceEntries(),commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION})).toMatchObject({status:200,body:{status:'accepted'}});
  expect((await runtime.query('SELECT text,origin,reason FROM social_private_drafts WHERE id=$1',[result.draftId])).rows[0]).toEqual({text:null,origin:null,reason:'source_changed_or_unavailable'});
  expect(await call('/social/drafts/read',{requestId})).toMatchObject({status:200,body:{request:{state:'review',concepts:null}}});
  const opaque=(await runtime.query("SELECT result FROM command_receipts WHERE command_kind='social_drafts_request'")).rows;expect(JSON.stringify(opaque)).not.toContain('Prefer neutral precise');
  for(const table of ['social_posts','social_post_revisions','social_accounts','jobs','outbound_messages'])expect((await runtime.query(`SELECT count(*)::int n FROM ${table}`)).rows[0]?.['n']).toBe(0);
 }finally{await f.stop();}
});
it('guide lock wait on current read cannot release derived suggestions after exact signed device revocation',async()=>{
 const f=await createAuthFixture();try{
  const runtime=await f.database.appRuntimeSession(),writer=await f.database.appRuntimeSession(),observer=await f.database.appRuntimeSession(),auth={...f.deps,db:runtime};
  const issued=await issueSessionFor(f,f.alpha,f.alpha.admin),token=issued.accessToken;
  const call=(path:string,body:unknown)=>dispatch({method:'POST',path,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`},body},{session:runtime,auth,supportedClientVersions:auth.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://fixture.invalid/update'});
  const ctx=repositoryContext(workspaceScope(f.alpha.workspaceId,{kind:'user',userId:f.alpha.admin.userId,role:'admin'}),runtime),selection=await withTransaction(runtime,()=>voiceGenerationSelection(ctx));
  const requested=await call('/social/drafts/request',{...selection,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});expect(requested.status).toBe(200);const requestId=(requested.body as {result:{requestId:string}}).result.requestId;
  await runSocialDraft(repositoryContext(workspaceScope(f.alpha.workspaceId,{kind:'system',component:'worker'}),runtime),requestId,fakeVoicePort());
  await writer.query('BEGIN');await writer.query('SELECT id FROM social_voice_preferences WHERE id=$1 FOR UPDATE',[selection.voiceGuideRef!.guideId]);
  const pid=(await runtime.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid,reading=call('/social/drafts/read',{requestId});
  try{
   await expect.poll(async()=>Boolean((await observer.query('SELECT cardinality(pg_blocking_pids($1))>0 waiting',[pid])).rows[0]?.['waiting'])).toBe(true);
   await observer.query("UPDATE devices SET status='revoked',revoked_at=now() WHERE id=$1",[issued.deviceId]);
  }finally{await writer.query('COMMIT');}
  const response=await reading;expect(response.status).toBe(401);expect(JSON.stringify(response.body)).not.toContain(voiceText);expect(JSON.stringify(response.body)).not.toContain('Prefer neutral precise');
 }finally{await f.stop();}
});
