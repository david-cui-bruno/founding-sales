import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {z} from 'zod';
import {SOCIAL_VOICE_GUIDE_PROCESSING_SCOPE,type SocialDraftRequest} from '@fss/contracts';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {requestSocialDrafts,readSocialDraftRequest} from '../../social/drafts.ts';
import {readSocialDraftSources} from '../../social/draftSources.ts';
import {socialDraftView} from '../../social/draftWorkspace.ts';
import {runSocialDraft} from '../../social/draftRun.ts';
import {saveSocialPrivateDraft,readSocialPrivateDraft} from '../../social/privateDrafts.ts';
import {saveSocialVoicePreferences} from '../../social/voicePreferences.ts';
import {updateResearchSettings} from '../../research/settings.ts';
import {voiceGenerationSelection,voiceEntries,voiceOrigin,voiceText} from './voiceGenerationFixtures.ts';
import type {AnthropicMessagesTransport} from '../../classification/anthropicClient.ts';
import type {ClassifierRequest} from '../../classification/prompt.ts';
import {socialDraftModel} from '../../../../apps/worker/src/social/draftModel.ts';

// NEW changed-path acceptance only. Root supplies the fresh ordinary PG16 lane;
// no historical grant/globalSetup, provider loader, browser or external account.
let db:TestDatabase,seed:TwoWorkspaces,runtime:SessionQueryable;
const authority=async()=>true;
const ctx=(session=runtime)=>repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'user',userId:seed.alpha.admin.userId,role:'admin'}),session);
const worker=()=>repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'system',component:'worker'}),runtime);
beforeEach(async()=>{
 db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);runtime=await db.appRuntimeSession();
 const enabled=await withTransaction(runtime,()=>updateResearchSettings(ctx(),{enabled:true,dailyCostCeilingCents:100,monthlyCostCeilingCents:1000}));expect(enabled.ok).toBe(true);
});
afterEach(async()=>db?.drop());
async function queued(scoped=true){return withTransaction(runtime,async()=>{
 const selected=await voiceGenerationSelection(ctx()),selection:SocialDraftRequest=scoped?{...selected,voiceGuideProcessingScope:SOCIAL_VOICE_GUIDE_PROCESSING_SCOPE}:selected;
 const saved=await requestSocialDrafts(ctx(),selection,authority);if(!saved.ok)throw Error(saved.reason);
 return {selection,requestId:saved.value.requestId};
});}
const promptSchema=z.object({approvedFacts:z.array(z.object({id:z.string(),version:z.number()})),untrustedStylePreferences:z.array(z.strictObject({dimension:z.string(),guidance:z.string()}))});
function model(){
 const create=vi.fn<AnthropicMessagesTransport['create']>().mockImplementation(async request=>{
  const input=promptSchema.parse(JSON.parse(request.messages[0]!.content));
  return {stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify({concepts:[{theme:'build',factRefs:input.approvedFacts.map(({id,version})=>({id,version})),variants:[{platform:'linkedin',text:voiceText}]}]})}],usage:{input_tokens:100,output_tokens:40}};
 }),countTokens=vi.fn<AnthropicMessagesTransport['countTokens']>().mockResolvedValue(100);
 return {create,countTokens,port:socialDraftModel({kind:'bedrock',create,countTokens})};
}
async function noPublicationEffects(){
 for(const table of ['social_posts','social_post_revisions','social_post_approvals','social_deliveries','social_accounts','jobs','outbound_messages'])expect((await runtime.query(`SELECT count(*)::int n FROM ${table}`)).rows[0]?.['n']).toBe(0);
 expect((await runtime.query("SELECT 1 FROM workspace_settings WHERE workspace_id=$1 AND setting_key='sending_enabled' AND value->>'enabled'='true'",[seed.alpha.workspaceId])).rows).toEqual([]);
}
async function requestRow(requestId:string){return (await runtime.query('SELECT state,source_selection,source_hash,paid_attempts,concepts,reason FROM social_draft_requests WHERE workspace_id=$1 AND id=$2',[seed.alpha.workspaceId,requestId])).rows[0];}
async function reservations(requestId:string,session=runtime){return (await session.query('SELECT state,cents,settled_cents,model_name,max_input_tokens,max_output_tokens FROM provider_reservations WHERE workspace_id=$1 AND subject_kind=\'social_draft\' AND subject_id=$2 ORDER BY attempt',[seed.alpha.workspaceId,requestId])).rows;}

it('real adapter refuses an actual old unscoped guide request before token count, generation or reservation',async()=>{
 const q=await queued(false),m=model();await runSocialDraft(worker(),q.requestId,m.port);
 expect(m.countTokens).not.toHaveBeenCalled();expect(m.create).not.toHaveBeenCalled();expect(await reservations(q.requestId)).toEqual([]);
 expect(await requestRow(q.requestId)).toMatchObject({state:'review',paid_attempts:0,concepts:null,reason:'voice_guide_port_unavailable'});
 expect((await requestRow(q.requestId))?.['source_selection']).not.toHaveProperty('voiceGuideProcessingScope');await noPublicationEffects();
});

it('scoped request reaches the real adapter only after committed calling custody, then saves and reopens its exact private origin',async()=>{
 const q=await queued(),m=model(),observer=await db.appRuntimeSession(),buildAnswer=m.create.getMockImplementation()!;
 const scoped=await withTransaction(runtime,()=>readSocialDraftSources(ctx(),q.selection));if(!scoped.ok)throw Error(scoped.reason);
 const {voiceGuideProcessingScope:_scope,...old}=q.selection,unscoped=await withTransaction(runtime,()=>readSocialDraftSources(ctx(),old));if(!unscoped.ok)throw Error(unscoped.reason);
 expect(scoped.value.hash).not.toBe(unscoped.value.hash);expect(scoped.value.input.voiceGuideProcessingScope).toBe(SOCIAL_VOICE_GUIDE_PROCESSING_SCOPE);
 expect(await requestRow(q.requestId)).toMatchObject({source_selection:q.selection,source_hash:scoped.value.hash});
 expect((await runtime.query('SELECT current_user')).rows[0]?.['current_user']).toBe('app_runtime');
 expect((await observer.query('SELECT pg_backend_pid() AS pid')).rows[0]?.['pid']).not.toBe((await runtime.query('SELECT pg_backend_pid() AS pid')).rows[0]?.['pid']);
 m.create.mockImplementation(async(request:ClassifierRequest)=>{
  expect((await observer.query('SELECT state,paid_attempts,source_selection FROM social_draft_requests WHERE workspace_id=$1 AND id=$2',[seed.alpha.workspaceId,q.requestId])).rows).toMatchObject([{state:'calling',paid_attempts:1,source_selection:{voiceGuideProcessingScope:SOCIAL_VOICE_GUIDE_PROCESSING_SCOPE}}]);
  expect(await reservations(q.requestId,observer)).toEqual([{state:'calling',cents:3,settled_cents:0,model_name:'claude-haiku-4-5',max_input_tokens:100,max_output_tokens:4096}]);
  expect((await runtime.query('SELECT pg_current_xact_id_if_assigned()::text xid')).rows[0]?.['xid']).toBeNull();
  const input=promptSchema.parse(JSON.parse(request.messages[0]!.content));expect(input.untrustedStylePreferences).toEqual([{dimension:'tone',guidance:'Prefer neutral precise sentences, with meaningful paragraph spacing.'}]);
  expect(request.messages[0]!.content).not.toContain(q.selection.voiceGuideRef!.guideId);return buildAnswer(request);
 });
 await runSocialDraft(worker(),q.requestId,m.port);
 expect(m.countTokens).toHaveBeenCalledTimes(1);expect(m.create).toHaveBeenCalledTimes(1);expect(m.countTokens.mock.calls[0]?.[0]).toEqual(m.create.mock.calls[0]?.[0]);
 const ready=await withTransaction(runtime,()=>readSocialDraftRequest(ctx(),q.requestId));expect(ready).toMatchObject({state:'ready',paid_attempts:1,source_hash:scoped.value.hash});if(!ready)throw Error('Expected ready request');
 expect(socialDraftView(ready).voiceGuideProcessingScope).toBe(SOCIAL_VOICE_GUIDE_PROCESSING_SCOPE);
 const origin=await withTransaction(runtime,()=>voiceOrigin(ctx(),q.requestId));
 const saved=await withTransaction(runtime,()=>saveSocialPrivateDraft(ctx(),{operation:'create',kind:'post',text:voiceText,origin},authority));if(!saved.ok)throw Error(saved.reason);
 const fresh=await db.appRuntimeSession();expect(await withTransaction(fresh,()=>readSocialPrivateDraft(ctx(fresh),saved.value.draftId,authority))).toMatchObject({availability:'available',revision:1,text:voiceText,origin});
 const stored=(await fresh.query('SELECT source_selection,source_hash,origin,dependencies FROM social_private_drafts WHERE workspace_id=$1 AND id=$2',[seed.alpha.workspaceId,saved.value.draftId])).rows[0];
 expect(stored).toMatchObject({source_selection:q.selection,source_hash:scoped.value.hash,origin});expect(JSON.stringify(stored)).not.toContain('Prefer neutral precise');
 const audit=(await fresh.query("SELECT detail FROM audit_events WHERE workspace_id=$1 AND action LIKE 'social.%'",[seed.alpha.workspaceId])).rows;expect(JSON.stringify(audit)).not.toContain('Prefer neutral precise');
 expect(await reservations(q.requestId)).toEqual([{state:'settled',cents:3,settled_cents:1,model_name:'claude-haiku-4-5',max_input_tokens:100,max_output_tokens:4096}]);
 expect((await runtime.query("SELECT sum(cost_cents)::int cost FROM provider_ledger WHERE workspace_id=$1 AND provider_key='aws_bedrock.social_draft'",[seed.alpha.workspaceId])).rows).toEqual([{cost:1}]);
 await runSocialDraft(worker(),q.requestId,m.port);expect(m.countTokens).toHaveBeenCalledTimes(1);expect(m.create).toHaveBeenCalledTimes(1);expect(await reservations(q.requestId)).toHaveLength(1);await noPublicationEffects();
});

it('normal guide update on another connection during actual adapter token counting prevents generation and cost',async()=>{
 const q=await queued(),m=model(),writer=await db.appRuntimeSession();let enter!:()=>void,release!:()=>void;
 const entered=new Promise<void>(resolve=>{enter=resolve;}),hold=new Promise<void>(resolve=>{release=resolve;});
 m.countTokens.mockImplementation(async()=>{enter();await hold;return 100;});
 const running=runSocialDraft(worker(),q.requestId,m.port);await Promise.race([running,entered]);expect(m.countTokens).toHaveBeenCalledTimes(1);
 try{const ref=q.selection.voiceGuideRef!,changed=await withTransaction(writer,()=>saveSocialVoicePreferences(ctx(writer),{operation:'update',guideId:ref.guideId,expectedRevision:ref.revision,entries:voiceEntries()},authority));expect(changed.ok).toBe(true);}finally{release();}
 await running;expect(m.create).not.toHaveBeenCalled();expect(await reservations(q.requestId)).toEqual([]);
 expect(await requestRow(q.requestId)).toMatchObject({state:'review',concepts:null,paid_attempts:0,reason:'source_changed_or_unavailable'});
 expect((await runtime.query("SELECT 1 FROM provider_ledger WHERE workspace_id=$1 AND provider_key='aws_bedrock.social_draft'",[seed.alpha.workspaceId])).rows).toEqual([]);await noPublicationEffects();
});

it('ambiguous real-adapter transport result conserves one estimated attempt and exact-request replay never invokes again',async()=>{
 const q=await queued(),m=model();m.create.mockRejectedValue(Error('Controlled ambiguous fake transport response'));
 await runSocialDraft(worker(),q.requestId,m.port);
 expect(m.countTokens).toHaveBeenCalledTimes(1);expect(m.create).toHaveBeenCalledTimes(1);
 expect(await requestRow(q.requestId)).toMatchObject({state:'review',concepts:null,paid_attempts:1,reason:'generation_unavailable_or_invalid',source_selection:q.selection});
 expect(await reservations(q.requestId)).toEqual([{state:'estimated',cents:3,settled_cents:3,model_name:'claude-haiku-4-5',max_input_tokens:100,max_output_tokens:4096}]);
 expect((await runtime.query("SELECT sum(cost_cents)::int cost FROM provider_ledger WHERE workspace_id=$1 AND provider_key='aws_bedrock.social_draft'",[seed.alpha.workspaceId])).rows).toEqual([{cost:3}]);
 await runSocialDraft(worker(),q.requestId,m.port);expect(m.countTokens).toHaveBeenCalledTimes(1);expect(m.create).toHaveBeenCalledTimes(1);expect(await reservations(q.requestId)).toHaveLength(1);await noPublicationEffects();
});
