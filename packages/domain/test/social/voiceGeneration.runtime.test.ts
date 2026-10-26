import {randomUUID} from 'node:crypto';
import {beforeAll,beforeEach,afterAll,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {readSocialDraftSources,readSocialDraftSourcesForWorker} from '../../social/draftSources.ts';
import {requestSocialDrafts,readSocialDraftRequest,expireSocialDraftRequests} from '../../social/drafts.ts';
import {runSocialDraft} from '../../social/draftRun.ts';
import {saveSocialPrivateDraft,readSocialPrivateDraft,PrivateDraftAuthorityChanged} from '../../social/privateDrafts.ts';
import {saveSocialVoicePreferences} from '../../social/voicePreferences.ts';
import {retireAnswerBlock} from '../../outreach/facts.ts';
import {updateResearchSettings} from '../../research/settings.ts';
import {reserveAttempt,markCalling} from '../../research/reservations.ts';
import {openHold} from '../../policy/holds.ts';
import {queueVoiceGeneration,voiceEntries,fakeVoicePort,voiceOrigin,voiceText} from './voiceGenerationFixtures.ts';
import {registerVoiceDatabase} from './voiceGenerationPgRuntime.ts';
let db:TestDatabase,seed:TwoWorkspaces,runtime:SessionQueryable;
let stop:()=>Promise<void>;
const ctx=(session=runtime,userId=seed.alpha.admin.userId,workspaceId=seed.alpha.workspaceId)=>repositoryContext(workspaceScope(workspaceId,{kind:'user',userId,role:'admin'}),session);
const worker=(session=runtime)=>repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'system',component:'worker'}),session);
const authority=async()=>true;
const queued=()=>withTransaction(runtime,()=>queueVoiceGeneration(ctx()));
const manual={operation:'create' as const,kind:'post' as const,text:'Independent owner-authored neutral private text.',origin:{kind:'manual' as const}};
beforeAll(async()=>{db=await createTestDatabase();stop=await registerVoiceDatabase(db);seed=await seedTwoWorkspaces(db.session);runtime=await db.appRuntimeSession();});
beforeEach(async()=>{for(const table of ['social_private_drafts','social_draft_requests','social_voice_preferences','provider_reservations'])await runtime.query(`DELETE FROM ${table}`);await withTransaction(runtime,()=>updateResearchSettings(ctx(),{enabled:true,dailyCostCeilingCents:100,monthlyCostCeilingCents:1000}));});
afterAll(async()=>stop?.());
async function adopted(){
 const q=await queued();await runSocialDraft(worker(),q.requestId,fakeVoicePort());
 const origin=await withTransaction(runtime,()=>voiceOrigin(ctx(),q.requestId));
 const saved=await withTransaction(runtime,()=>saveSocialPrivateDraft(ctx(),{...manual,text:voiceText,origin},authority));if(!saved.ok)throw Error(saved.reason);
 return {...q,...saved.value,origin};
}
it('app_runtime exact guide -> existing grounded fake port -> selected private persistence/reopen/refinement, with no publishing writes',async()=>{
 expect((await runtime.query('SELECT current_user')).rows[0]?.['current_user']).toBe('app_runtime');
 const q=await adopted();expect(await withTransaction(runtime,()=>readSocialPrivateDraft(ctx(),q.draftId,authority))).toMatchObject({availability:'available',text:voiceText,origin:q.origin});
 await runtime.query("UPDATE social_draft_requests SET created_at=now()-interval '31 minutes',deadline_at=now()-interval '1 minute' WHERE id=$1",[q.requestId]);
 expect(await withTransaction(runtime,()=>saveSocialPrivateDraft(ctx(),{operation:'update',draftId:q.draftId,expectedRevision:1,kind:'comment',text:'Refined owner-private text with retained original source lineage.'},authority))).toMatchObject({ok:true,value:{revision:2}});
 const fresh=await db.appRuntimeSession();expect(await withTransaction(fresh,()=>readSocialPrivateDraft(ctx(fresh),q.draftId,authority))).toMatchObject({availability:'available',kind:'comment',origin:q.origin,revision:2});
 const stored=(await runtime.query('SELECT source_selection,dependencies FROM social_private_drafts WHERE id=$1',[q.draftId])).rows[0];expect(stored).toMatchObject({source_selection:{voiceGuideRef:q.selection.voiceGuideRef},dependencies:{social_voice_preferences:[q.selection.voiceGuideRef!.guideId]}});expect(JSON.stringify(stored)).not.toContain('Prefer neutral precise');
 const audit=(await runtime.query("SELECT detail FROM audit_events WHERE action LIKE 'social.%'")).rows;expect(JSON.stringify(audit)).not.toContain('Prefer neutral precise');
 for(const table of ['social_posts','social_post_revisions','social_accounts','jobs','outbound_messages'])expect((await runtime.query(`SELECT count(*)::int n FROM ${table}`)).rows[0]?.['n']).toBe(0);
});
it('an unmarked model port refuses guided work before either counting or generating, with no reservation',async()=>{
 const q=await queued();let calls=0;await runSocialDraft(worker(),q.requestId,{providerKey:'aws_bedrock.social_draft',countInputTokens:async()=>{calls++;return 100;},generate:async()=>{calls++;throw Error('Must never call');}});
 expect(calls).toBe(0);expect(await withTransaction(runtime,()=>readSocialDraftRequest(ctx(),q.requestId))).toMatchObject({state:'review',reason:'voice_guide_port_unavailable'});expect((await runtime.query('SELECT * FROM provider_reservations')).rows).toHaveLength(0);
});
it.each(['foreign_owner','foreign_workspace','changed','missing'] as const)('current exact guide refuses %s without fallback or counting',async kind=>{
 const q=await queued();
 const selection={...q.selection,voiceGuideRef:kind==='missing'?{guideId:randomUUID(),revision:1}:kind==='changed'?{...q.selection.voiceGuideRef!,revision:2}:q.selection.voiceGuideRef!};
 const other=kind==='foreign_owner'?ctx(runtime,seed.alpha.salesperson.userId):kind==='foreign_workspace'?ctx(runtime,seed.beta.admin.userId,seed.beta.workspaceId):ctx();
 expect(await withTransaction(runtime,()=>readSocialDraftSources(other,selection))).toMatchObject({ok:false});
 expect(await withTransaction(runtime,()=>readSocialDraftSourcesForWorker(ctx(),seed.alpha.admin.userId,selection))).toEqual({ok:false,reason:'worker_required'});
});
it('fingerprint includes exact current guide identity, revision and bounded content, never an implicit newer revision',async()=>{
 const q=await queued(),before=await withTransaction(runtime,()=>readSocialDraftSources(ctx(),q.selection));if(!before.ok)throw Error(before.reason);
 const ref=q.selection.voiceGuideRef!;await withTransaction(runtime,()=>saveSocialVoicePreferences(ctx(),{operation:'update',guideId:ref.guideId,expectedRevision:ref.revision,entries:voiceEntries()},authority));
 expect(await withTransaction(runtime,()=>readSocialDraftSources(ctx(),q.selection))).toMatchObject({ok:false});
 const after=await withTransaction(runtime,()=>readSocialDraftSources(ctx(),{...q.selection,voiceGuideRef:{...ref,revision:2}}));if(!after.ok)throw Error(after.reason);expect(after.value.hash).not.toBe(before.value.hash);
 expect(await withTransaction(runtime,()=>readSocialDraftRequest(ctx(),q.requestId))).toMatchObject({state:'review',concepts:null});
});
it.each(['update','remove'] as const)('guide %s while token counting invalidates queued work and prevents generation',async operation=>{
 const q=await queued();let generations=0;
 await runSocialDraft(worker(),q.requestId,fakeVoicePort({count:async()=>{const ref=q.selection.voiceGuideRef!;await withTransaction(runtime,()=>saveSocialVoicePreferences(ctx(),operation==='remove'?{operation,guideId:ref.guideId,expectedRevision:1}:{operation,guideId:ref.guideId,expectedRevision:1,entries:voiceEntries()},authority));},generate:async()=>{generations++;}}));
 expect(generations).toBe(0);expect((await runtime.query('SELECT state,concepts,paid_attempts FROM social_draft_requests WHERE id=$1',[q.requestId])).rows[0]).toMatchObject({state:'review',concepts:null,paid_attempts:0});
});
it('guide update during fake generation erases late result without losing the incurred reservation',async()=>{
 const q=await queued();await runSocialDraft(worker(),q.requestId,fakeVoicePort({generate:async input=>{expect(worker().scope.actor).toEqual({kind:'system',component:'worker'});expect(input.privateVoiceGuide?.guideId).toBe(q.selection.voiceGuideRef!.guideId);await withTransaction(runtime,()=>saveSocialVoicePreferences(ctx(),{operation:'update',guideId:q.selection.voiceGuideRef!.guideId,expectedRevision:1,entries:voiceEntries()},authority));}}));
 expect((await runtime.query('SELECT state,concepts,paid_attempts FROM social_draft_requests WHERE id=$1',[q.requestId])).rows[0]).toEqual({state:'review',concepts:null,paid_attempts:1});
 expect((await runtime.query('SELECT state FROM provider_reservations WHERE subject_id=$1',[q.requestId])).rows).toEqual([{state:'settled'}]);
});
it.each(['update','remove','restart'] as const)('guide %s synchronously erases saved and ready derived bytes while preserving manual text',async operation=>{
 const q=await adopted(),manualSaved=await withTransaction(runtime,()=>saveSocialPrivateDraft(ctx(),manual,authority));if(!manualSaved.ok)throw Error(manualSaved.reason);
 const guideId=q.selection.voiceGuideRef!.guideId;
 if(operation==='restart')expect(await withTransaction(runtime,()=>saveSocialVoicePreferences(ctx(),{operation:'remove',guideId,expectedRevision:1},authority))).toMatchObject({ok:true});
 expect(await withTransaction(runtime,()=>saveSocialVoicePreferences(ctx(),operation==='remove'?{operation,guideId,expectedRevision:1}:{operation,guideId,expectedRevision:operation==='restart'?2:1,entries:voiceEntries()},authority))).toMatchObject({ok:true});
 expect((await runtime.query('SELECT text,origin,source_selection,dependencies,reason FROM social_private_drafts WHERE id=$1',[q.draftId])).rows[0]).toEqual({text:null,origin:null,source_selection:null,dependencies:{},reason:'source_changed_or_unavailable'});
 expect((await runtime.query('SELECT concepts,state FROM social_draft_requests WHERE id=$1',[q.requestId])).rows[0]).toEqual({concepts:null,state:'review'});
 expect(await withTransaction(runtime,()=>readSocialPrivateDraft(ctx(),manualSaved.value.draftId,authority))).toMatchObject({text:manual.text});
 expect(await withTransaction(runtime,()=>saveSocialPrivateDraft(ctx(),{operation:'update',draftId:q.draftId,expectedRevision:1,kind:'post',text:'Stale derived text'},authority))).toMatchObject({ok:false});
 expect(await withTransaction(runtime,()=>saveSocialPrivateDraft(ctx(),{...manual,origin:q.origin},authority))).toMatchObject({ok:false});
});
it.each(['direct_update','direct_delete','owner_loss','role_loss'] as const)('normal persisted lifecycle %s erases without a read or API-only invalidator (requires migration0141)',async change=>{
 const q=await adopted();await runtime.query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES($1,$2,'admin','active') ON CONFLICT DO NOTHING",[seed.alpha.workspaceId,seed.beta.admin.userId]);
 try{
  if(change==='direct_update')await runtime.query('UPDATE social_voice_preferences SET revision=revision+1 WHERE id=$1',[q.selection.voiceGuideRef!.guideId]);
  if(change==='direct_delete')await runtime.query('DELETE FROM social_voice_preferences WHERE id=$1',[q.selection.voiceGuideRef!.guideId]);
  if(change==='owner_loss')await runtime.query("UPDATE workspace_memberships SET status='inactive',deactivated_at=now() WHERE workspace_id=$1 AND user_id=$2",[seed.alpha.workspaceId,seed.alpha.admin.userId]);
  if(change==='role_loss')await runtime.query("UPDATE workspace_memberships SET role='salesperson' WHERE workspace_id=$1 AND user_id=$2",[seed.alpha.workspaceId,seed.alpha.admin.userId]);
  expect((await runtime.query('SELECT concepts,state FROM social_draft_requests WHERE id=$1',[q.requestId])).rows[0]).toEqual({concepts:null,state:'review'});
  expect((await runtime.query('SELECT text FROM social_private_drafts WHERE id=$1',[q.draftId])).rows[0]?.['text']).toBeNull();
 }finally{await runtime.query("UPDATE workspace_memberships SET status='active',deactivated_at=NULL,role='admin' WHERE workspace_id=$1 AND user_id=$2",[seed.alpha.workspaceId,seed.alpha.admin.userId]);}
});
it('guide removal and first selected save serialize a real lock wait without stale resurrection',async()=>{
 const q=await queued();await runSocialDraft(worker(),q.requestId,fakeVoicePort());const origin=await withTransaction(runtime,()=>voiceOrigin(ctx(),q.requestId));
 const writer=await db.appRuntimeSession(),reader=await db.appRuntimeSession();await writer.query('BEGIN');await saveSocialVoicePreferences(ctx(writer),{operation:'remove',guideId:q.selection.voiceGuideRef!.guideId,expectedRevision:1},authority);
 const pid=(await reader.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
 const saving=withTransaction(reader,()=>saveSocialPrivateDraft(ctx(reader),{...manual,origin},authority));
 try{await expect.poll(async()=>Boolean((await runtime.query('SELECT cardinality(pg_blocking_pids($1))>0 waiting',[pid])).rows[0]?.['waiting'])).toBe(true);}finally{await writer.query('COMMIT');}
 expect(await saving).toMatchObject({ok:false});expect((await runtime.query('SELECT * FROM social_private_drafts')).rows).toHaveLength(0);
});
it('current private authority is rechecked after a guide lock wait without erasing legitimate saved text',async()=>{
 const q=await adopted(),writer=await db.appRuntimeSession(),reader=await db.appRuntimeSession();await writer.query('BEGIN');await writer.query('SELECT id FROM social_voice_preferences WHERE id=$1 FOR UPDATE',[q.selection.voiceGuideRef!.guideId]);
 const pid=(await reader.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;let allowed=true;
 const reading=withTransaction(reader,()=>readSocialPrivateDraft(ctx(reader),q.draftId,async()=>allowed)),rejected=expect(reading).rejects.toBeInstanceOf(PrivateDraftAuthorityChanged);
 try{await expect.poll(async()=>Boolean((await runtime.query('SELECT cardinality(pg_blocking_pids($1))>0 waiting',[pid])).rows[0]?.['waiting'])).toBe(true);allowed=false;}finally{await writer.query('COMMIT');}await rejected;
 expect((await runtime.query('SELECT text FROM social_private_drafts WHERE id=$1',[q.draftId])).rows[0]?.['text']).toBe(voiceText);
});
it('UNKNOWN guided model result estimates once and never replays paid generation',async()=>{
 const q=await queued();let calls=0;const port=fakeVoicePort({unknown:true,generate:async()=>{calls++;}});
 await runSocialDraft(worker(),q.requestId,port);await runSocialDraft(worker(),q.requestId,port);expect(calls).toBe(1);
 expect((await runtime.query('SELECT state,paid_attempts,concepts FROM social_draft_requests WHERE id=$1',[q.requestId])).rows[0]).toEqual({state:'review',paid_attempts:1,concepts:null});expect((await runtime.query('SELECT state FROM provider_reservations WHERE subject_id=$1',[q.requestId])).rows).toEqual([{state:'estimated'}]);
});
it('invalidating a crashed calling request preserves uncertainty and the existing deadline sweep estimates it',async()=>{
 const q=await queued();await withTransaction(runtime,async()=>{const reservation=await reserveAttempt(worker(),{subjectKind:'social_draft',subjectId:q.requestId,attempt:1,providerKey:'aws_bedrock.social_draft',at:new Date().toISOString(),businessTimeZone:'America/New_York',cents:3,modelName:'claude-haiku-4-5',maxInputTokens:100,maxOutputTokens:4096});await markCalling(worker(),reservation.id);await runtime.query("UPDATE social_draft_requests SET state='calling',paid_attempts=1 WHERE id=$1",[q.requestId]);});
 await withTransaction(runtime,()=>saveSocialVoicePreferences(ctx(),{operation:'remove',guideId:q.selection.voiceGuideRef!.guideId,expectedRevision:1},authority));
 expect((await runtime.query('SELECT state FROM provider_reservations WHERE subject_id=$1',[q.requestId])).rows).toEqual([{state:'calling'}]);
 await runtime.query("UPDATE social_draft_requests SET created_at=now()-interval '31 minutes',deadline_at=now()-interval '1 minute' WHERE id=$1",[q.requestId]);await withTransaction(runtime,()=>expireSocialDraftRequests(worker()));
 expect((await runtime.query('SELECT state,settled_cents FROM provider_reservations WHERE subject_id=$1',[q.requestId])).rows).toEqual([{state:'estimated',settled_cents:3}]);
 expect((await runtime.query('SELECT state,concepts FROM social_draft_requests WHERE id=$1',[q.requestId])).rows[0]).toEqual({state:'review',concepts:null});
});
it('current source retirement refuses saved refinement independently of the guide',async()=>{
 const q=await adopted();await withTransaction(runtime,()=>retireAnswerBlock(ctx(),q.selection.factBlocks[0]!));
 expect(await withTransaction(runtime,()=>saveSocialPrivateDraft(ctx(),{operation:'update',draftId:q.draftId,expectedRevision:1,kind:'post',text:'Refined stale-source text'},authority))).toMatchObject({ok:false});
 expect((await runtime.query('SELECT entries FROM social_voice_preferences WHERE id=$1',[q.selection.voiceGuideRef!.guideId])).rows[0]?.['entries']).not.toBeNull();
});
it('existing budget disablement blocks a capable port before generation and preserves the guide',async()=>{
 const q=await queued();await withTransaction(runtime,()=>updateResearchSettings(ctx(),{enabled:false}));let calls=0;await runSocialDraft(worker(),q.requestId,fakeVoicePort({generate:async()=>{calls++;}}));expect(calls).toBe(0);expect((await runtime.query('SELECT entries FROM social_voice_preferences WHERE id=$1',[q.selection.voiceGuideRef!.guideId])).rows[0]?.['entries']).not.toBeNull();
});
it('exact adoption fingerprint including guide identity cannot be replaced by a stale selection hash',async()=>{
 const q=await queued();await runSocialDraft(worker(),q.requestId,fakeVoicePort());const origin=await withTransaction(runtime,()=>voiceOrigin(ctx(),q.requestId));
 expect(await withTransaction(runtime,()=>saveSocialPrivateDraft(ctx(),{...manual,origin:{...origin,selectionSHA256:'f'.repeat(64)}},authority))).toMatchObject({ok:false,reason:'suggestion_changed_or_expired'});
 expect(await withTransaction(runtime,()=>requestSocialDrafts(ctx(),{...q.selection,voiceGuideRef:{...q.selection.voiceGuideRef!,revision:2}},authority))).toMatchObject({ok:false});
});
it('content-only guide changes also alter the source fingerprint without silently renewing the selected revision',async()=>{
 const q=await queued(),before=await withTransaction(runtime,()=>readSocialDraftSources(ctx(),q.selection));if(!before.ok)throw Error(before.reason);
 await runtime.query('UPDATE social_voice_preferences SET entries=$2::jsonb WHERE id=$1',[q.selection.voiceGuideRef!.guideId,JSON.stringify(voiceEntries())]);
 const after=await withTransaction(runtime,()=>readSocialDraftSources(ctx(),q.selection));if(!after.ok)throw Error(after.reason);expect(after.value.hash).not.toBe(before.value.hash);
 let calls=0;await runSocialDraft(worker(),q.requestId,fakeVoicePort({count:async()=>{calls++;},generate:async()=>{calls++;}}));expect(calls).toBe(0);
});
it('an applicable current research hold blocks guided fake generation without erasing the guide',async()=>{
 const q=await queued();await withTransaction(runtime,()=>openHold(ctx(),{scopeKind:'workspace',reasonCode:'scoped_pause',blockedActionKinds:['research'],sourceEventKind:'controlled_voice_fixture'}));
 try{let calls=0;await runSocialDraft(worker(),q.requestId,fakeVoicePort({generate:async()=>{calls++;}}));expect(calls).toBe(0);expect(await withTransaction(runtime,()=>readSocialDraftRequest(ctx(),q.requestId))).toMatchObject({state:'review',reason:'drafting_held'});}
 finally{await runtime.query("DELETE FROM active_holds WHERE source_event_kind='controlled_voice_fixture'");}
});
