import {randomUUID} from 'node:crypto';
import {beforeAll,beforeEach,afterAll,expect,it} from 'vitest';
import {SOCIAL_FOUNDER_INPUT_PROCESSING_SCOPE,type SocialDraftRequest} from '@fss/contracts';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {saveSocialFounderInput,readSocialFounderInput,readSocialFounderInputsForOwner,sweepSocialFounderInputs} from '../../social/founderInputs.ts';
import {finishSocialCalibration,readSocialCalibration} from '../../social/calibration.ts';
import {readSocialDraftSources,readSocialDraftSourcesForWorker} from '../../social/draftSources.ts';
import {requestSocialDrafts,readSocialDraftRequest} from '../../social/drafts.ts';
import {runSocialDraft,type SocialDraftPort} from '../../social/draftRun.ts';
import {saveSocialPrivateDraft,readSocialPrivateDraft,PrivateDraftAuthorityChanged} from '../../social/privateDrafts.ts';
import {saveSocialVoicePreferences} from '../../social/voicePreferences.ts';
import {updateResearchSettings} from '../../research/settings.ts';
import {voiceOrigin,voiceEntries} from './voiceGenerationFixtures.ts';
import {PRIVATE_VOICE_GUIDE_VERSION} from '../../social/voiceGeneration.ts';
let db:TestDatabase,seed:TwoWorkspaces,runtime:SessionQueryable;
const ctx=(session=runtime,userId=seed.alpha.admin.userId)=>repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'user',userId,role:'admin'}),session);
const worker=(session=runtime)=>repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'system',component:'worker'}),session);
const authority=async()=>true;
const note={bullets:'I spent my college afternoon debugging a local prototype. I think tiny feedback loops beat ambitious demos.',context:'An actual owner-supplied experience and opinion, not a product claim.',experienceDate:null,publicSafe:true};
const text='I spent my college afternoon debugging a local prototype.\n\nI think tiny feedback loops beat ambitious demos. Keeping the experiment small helped me notice what I was actually learning.';
const port:SocialDraftPort={providerKey:'aws_bedrock.social_draft',founderInputProcessingScope:SOCIAL_FOUNDER_INPUT_PROCESSING_SCOPE,privateVoiceGuideVersion:PRIVATE_VOICE_GUIDE_VERSION,countInputTokens:async()=>100,generate:async()=>({raw:JSON.stringify({concepts:[{theme:'founder',factRefs:[],variants:[{platform:'linkedin',text}]}]}),costCents:1,costEstimated:false})};
beforeAll(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);runtime=await db.appRuntimeSession();});
beforeEach(async()=>{for(const table of ['social_founder_calibrations','social_private_drafts','social_draft_requests','social_founder_inputs','social_voice_preferences','provider_reservations'])await runtime.query(`DELETE FROM ${table}`);await withTransaction(runtime,()=>updateResearchSettings(ctx(),{enabled:true,dailyCostCeilingCents:100,monthlyCostCeilingCents:1000}));});
afterAll(async()=>db.drop());
async function input(){const saved=await withTransaction(runtime,()=>saveSocialFounderInput(ctx(),{operation:'create',...note},authority));if(!saved.ok)throw Error(saved.reason);return saved.value;}
async function adopted(ref: {inputId:string;revision:number},format:'story'|'opinion'|'technical',guide?:{guideId:string;revision:number}){
 const selection:SocialDraftRequest={mode:'linkedin_founder',sourceRefs:[],factBlocks:[],founderInputRefs:[ref],founderFormat:format,founderInputProcessingScope:SOCIAL_FOUNDER_INPUT_PROCESSING_SCOPE,...(guide?{voiceGuideRef:guide}:{})};
 const q=await withTransaction(runtime,()=>requestSocialDrafts(ctx(),selection,authority));if(!q.ok)throw Error(q.reason);
 await runSocialDraft(worker(),q.value.requestId,port);
 const origin=await withTransaction(runtime,()=>voiceOrigin(ctx(),q.value.requestId));const saved=await withTransaction(runtime,()=>saveSocialPrivateDraft(ctx(),{operation:'create',kind:'post',text,origin},authority));if(!saved.ok)throw Error(saved.reason);
 return {...saved.value,requestId:q.value.requestId,selection};
}
it('actual private notes feed existing controlled generation without shared outreach facts, private adoption preserves exact lineage and deadline',async()=>{
 const ref=await input(),saved=await adopted(ref,'story');
 expect(await withTransaction(runtime,()=>readSocialPrivateDraft(ctx(),saved.draftId,authority))).toMatchObject({availability:'available',text});
 const row=(await runtime.query('SELECT source_selection,dependencies,expires_at FROM social_private_drafts WHERE id=$1',[saved.draftId])).rows[0]!;
 expect(row['source_selection']).toMatchObject({founderInputRefs:[ref]});expect(row['dependencies']).toEqual({social_founder_inputs:[ref.inputId]});
 expect(row['expires_at']).toEqual((await runtime.query('SELECT expires_at FROM social_founder_inputs WHERE id=$1',[ref.inputId])).rows[0]?.['expires_at']);
 expect((await runtime.query('SELECT count(*)::int n FROM outreach_answer_blocks')).rows[0]?.['n']).toBe(0);
 expect(JSON.stringify((await runtime.query("SELECT detail FROM audit_events WHERE action LIKE 'social.%'")).rows)).not.toContain(note.bullets);
});
it('public-safe opt in is explicit, foreign owner reads and worker foreign binding cannot expose notes',async()=>{
 const ref=await input();await runtime.query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES($1,$2,'admin','active') ON CONFLICT DO NOTHING",[seed.alpha.workspaceId,seed.beta.admin.userId]);
 expect(await withTransaction(runtime,()=>readSocialFounderInput(ctx(runtime,seed.beta.admin.userId),ref.inputId,authority))).toBeNull();
 expect(await withTransaction(runtime,()=>readSocialFounderInputsForOwner(worker(),seed.beta.admin.userId,[ref]))).toMatchObject({ok:false});
 const privateNote=await withTransaction(runtime,()=>saveSocialFounderInput(ctx(),{operation:'create',...note,publicSafe:false},authority));if(!privateNote.ok)throw Error(privateNote.reason);
 expect(await withTransaction(runtime,()=>readSocialFounderInputsForOwner(worker(),seed.alpha.admin.userId,[privateNote.value]))).toMatchObject({ok:false});
});
it('CAS edits do not renew lifetime; source mutation physically erases ready suggestions and adopted prose; tombstones refuse stale resurrection',async()=>{
 const ref=await input(),saved=await adopted(ref,'story'),before=await withTransaction(runtime,()=>readSocialFounderInput(ctx(),ref.inputId,authority));
 const changed=await withTransaction(runtime,()=>saveSocialFounderInput(ctx(),{operation:'update',inputId:ref.inputId,expectedRevision:ref.revision,...note,bullets:'A different actual college experience.'},authority));expect(changed).toMatchObject({ok:true,value:{revision:2}});
 expect(await withTransaction(runtime,()=>readSocialFounderInput(ctx(),ref.inputId,authority))).toMatchObject({expiresAt:before!.expiresAt});
 expect((await runtime.query('SELECT text,source_selection FROM social_private_drafts WHERE id=$1',[saved.draftId])).rows[0]).toEqual({text:null,source_selection:null});
 expect(await withTransaction(runtime,()=>readSocialDraftRequest(ctx(),saved.requestId))).toMatchObject({state:'review',concepts:null});
 expect(await withTransaction(runtime,()=>saveSocialFounderInput(ctx(),{operation:'update',inputId:ref.inputId,expectedRevision:1,...note},authority))).toMatchObject({ok:false,reason:'stale_revision'});
 expect(await withTransaction(runtime,()=>saveSocialFounderInput(ctx(),{operation:'remove',inputId:ref.inputId,expectedRevision:2},authority))).toMatchObject({ok:true,value:{revision:3}});
 expect(await withTransaction(runtime,()=>saveSocialFounderInput(ctx(),{operation:'update',inputId:ref.inputId,expectedRevision:3,...note},authority))).toMatchObject({ok:false,reason:'removed'});
 expect((await runtime.query('SELECT bullets,context FROM social_founder_inputs WHERE id=$1',[ref.inputId])).rows[0]).toEqual({bullets:null,context:null});
});
it('three distinct exact ordinary private drafts accept without cosmetic changes; optional final guide mutation erases examples atomically, completion stays historical',async()=>{
 const ref=await input(),guide=await withTransaction(runtime,()=>saveSocialVoicePreferences(ctx(),{operation:'create',entries:voiceEntries()},authority));if(!guide.ok)throw Error(guide.reason);
 const examples:{draftId:string;revision:number}[]=[];for(const format of ['story','opinion','technical'] as const)examples.push(await adopted(ref,format,guide.value));
 const finished=await withTransaction(runtime,()=>finishSocialCalibration(ctx(),{examples:examples.map(({draftId,revision})=>({draftId,revision})),expectedGuide:guide.value,finalGuide:{operation:'update',guideId:guide.value.guideId,expectedRevision:1,entries:voiceEntries()}},authority));
 expect(finished).toMatchObject({ok:true,value:{guideRef:{...guide.value,revision:2}}});
 expect((await runtime.query('SELECT text FROM social_private_drafts')).rows.every(r=>r['text']===null)).toBe(true);
 await withTransaction(runtime,()=>saveSocialFounderInput(ctx(),{operation:'remove',inputId:ref.inputId,expectedRevision:1},authority));
 expect(await withTransaction(runtime,()=>readSocialCalibration(ctx(),authority))).toMatchObject({completion:{guideRef:{...guide.value,revision:2}}});
 const stored=(await runtime.query('SELECT examples,guide_ref FROM social_founder_calibrations')).rows;expect(JSON.stringify(stored)).not.toContain(text);expect(JSON.stringify(stored)).not.toContain(note.bullets);
});
it('calibration refuses stale correction or raced guide and never partially mutates guide or completion',async()=>{
 const ref=await input(),examples:{draftId:string;revision:number}[]=[];for(const format of ['story','opinion','technical'] as const)examples.push(await adopted(ref,format));
 await withTransaction(runtime,()=>saveSocialPrivateDraft(ctx(),{operation:'update',draftId:examples[0]!.draftId,expectedRevision:1,kind:'post',text:'A genuine correction of my private draft.'},authority));
 const result=await withTransaction(runtime,()=>finishSocialCalibration(ctx(),{examples:examples.map(({draftId,revision})=>({draftId,revision})),expectedGuide:null,finalGuide:{operation:'create',entries:voiceEntries()}},authority));
 expect(result).toMatchObject({ok:false,reason:'examples_changed_or_unavailable'});expect((await runtime.query('SELECT * FROM social_voice_preferences')).rows).toHaveLength(0);expect((await runtime.query('SELECT * FROM social_founder_calibrations')).rows).toHaveLength(0);
});
it('retention physically clears expired notes without a read, preserving an opaque terminal fence',async()=>{
 const id=randomUUID();await runtime.query("INSERT INTO social_founder_inputs(workspace_id,owner_user_id,id,bullets,context,public_safe,created_at,expires_at) SELECT $1,$2,$3,$4,'',true,t-interval '91 days',t-interval '1 day' FROM (SELECT clock_timestamp() t) clock",[seed.alpha.workspaceId,seed.alpha.admin.userId,id,note.bullets]);
 expect(await withTransaction(runtime,()=>sweepSocialFounderInputs(worker(),20))).toBe(1);expect((await runtime.query('SELECT bullets,context,reason,revision FROM social_founder_inputs WHERE id=$1',[id])).rows[0]).toEqual({bullets:null,context:null,reason:'expired',revision:2});
});
it('revoked current authority after owner lock wait rolls back write instead of committing private prose',async()=>{
 const writer=await db.appRuntimeSession(),reader=await db.appRuntimeSession();await writer.query('BEGIN');await writer.query('SELECT user_id FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE',[seed.alpha.workspaceId,seed.alpha.admin.userId]);let allowed=true;
 const pid=(await reader.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
 const pending=withTransaction(reader,()=>saveSocialFounderInput(ctx(reader),{operation:'create',...note},async()=>allowed));const rejected=expect(pending).rejects.toBeInstanceOf(PrivateDraftAuthorityChanged);
 try{await expect.poll(async()=>Boolean((await runtime.query('SELECT cardinality(pg_blocking_pids($1))>0 waiting',[pid])).rows[0]?.['waiting'])).toBe(true);allowed=false;}finally{await writer.query('COMMIT');}
 await rejected;expect((await runtime.query('SELECT * FROM social_founder_inputs')).rows).toHaveLength(0);
});
it('founder scope is required before token counting, worker keeps system identity, supplied standing refs cannot enter user admission',async()=>{
 const ref=await input(),selection:SocialDraftRequest={mode:'linkedin_founder',sourceRefs:[],factBlocks:[],founderInputRefs:[ref],founderFormat:'opinion',founderInputProcessingScope:SOCIAL_FOUNDER_INPUT_PROCESSING_SCOPE};
 expect(await withTransaction(runtime,()=>readSocialDraftSourcesForWorker(worker(),seed.alpha.admin.userId,selection))).toMatchObject({ok:true});expect(worker().scope.actor).toEqual({kind:'system',component:'worker'});
 const {founderInputProcessingScope:_scope,...unscoped}=selection;
 expect(await withTransaction(runtime,()=>readSocialDraftSources(ctx(),unscoped))).toMatchObject({ok:false});
 expect(await withTransaction(runtime,()=>requestSocialDrafts(ctx(),{...selection,standingPlanRef:{planId:randomUUID(),revision:1,slotId:randomUUID()}},authority))).toMatchObject({ok:false,reason:'standing_request_server_only'});
 const q=await withTransaction(runtime,()=>requestSocialDrafts(ctx(),selection,authority));if(!q.ok)throw Error(q.reason);let calls=0;await runSocialDraft(worker(),q.value.requestId,{providerKey:'aws_bedrock.social_draft',countInputTokens:async()=>{calls++;return 100;},generate:async()=>{calls++;throw Error('must not call');}});expect(calls).toBe(0);
});
it('a guide change winning a real membership wait refuses exact calibration without copying erased examples',async()=>{
 const ref=await input(),guide=await withTransaction(runtime,()=>saveSocialVoicePreferences(ctx(),{operation:'create',entries:voiceEntries()},authority));if(!guide.ok)throw Error(guide.reason);
 const examples:{draftId:string;revision:number}[]=[];for(const format of ['story','opinion','technical'] as const)examples.push(await adopted(ref,format,guide.value));
 const writer=await db.appRuntimeSession(),reader=await db.appRuntimeSession(),pid=(await reader.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
 await writer.query('BEGIN');await saveSocialVoicePreferences(ctx(writer),{operation:'update',guideId:guide.value.guideId,expectedRevision:1,entries:voiceEntries()},authority);
 const pending=withTransaction(reader,()=>finishSocialCalibration(ctx(reader),{examples:examples.map(({draftId,revision})=>({draftId,revision})),expectedGuide:guide.value},authority));
 try{await expect.poll(async()=>Boolean((await runtime.query('SELECT cardinality(pg_blocking_pids($1))>0 waiting',[pid])).rows[0]?.['waiting'])).toBe(true);}finally{await writer.query('COMMIT');}
 expect(await pending).toMatchObject({ok:false,reason:'guide_changed'});expect((await runtime.query('SELECT * FROM social_founder_calibrations')).rows).toHaveLength(0);expect((await runtime.query('SELECT text FROM social_private_drafts')).rows.every(r=>r['text']===null)).toBe(true);
});
it('authority loss after final guide curation rolls back erasure, guide change and completion together',async()=>{
 const ref=await input(),guide=await withTransaction(runtime,()=>saveSocialVoicePreferences(ctx(),{operation:'create',entries:voiceEntries()},authority));if(!guide.ok)throw Error(guide.reason);
 const examples:{draftId:string;revision:number}[]=[];for(const format of ['story','opinion','technical'] as const)examples.push(await adopted(ref,format,guide.value));
 const current=async()=>Number((await runtime.query('SELECT revision FROM social_voice_preferences WHERE id=$1',[guide.value.guideId])).rows[0]?.['revision'])===1;
 await expect(withTransaction(runtime,()=>finishSocialCalibration(ctx(),{examples:examples.map(({draftId,revision})=>({draftId,revision})),expectedGuide:guide.value,finalGuide:{operation:'update',guideId:guide.value.guideId,expectedRevision:1,entries:voiceEntries()}},current))).rejects.toBeInstanceOf(PrivateDraftAuthorityChanged);
 expect((await runtime.query('SELECT revision FROM social_voice_preferences')).rows[0]?.['revision']).toBe(1);expect((await runtime.query('SELECT * FROM social_founder_calibrations')).rows).toHaveLength(0);expect((await runtime.query('SELECT text FROM social_private_drafts')).rows.every(r=>r['text']===text)).toBe(true);
});
it('owner departure erases actual input and dependent output even without any private guide',async()=>{
 const ref=await input(),saved=await adopted(ref,'story');
 // Keep another active administrator so ordinary membership safeguards permit departure.
 await runtime.query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES($1,$2,'admin','active') ON CONFLICT DO NOTHING",[seed.alpha.workspaceId,seed.beta.admin.userId]);
 try{
  await runtime.query("UPDATE workspace_memberships SET status='inactive',deactivated_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2",[seed.alpha.workspaceId,seed.alpha.admin.userId]);
  expect((await runtime.query('SELECT bullets,context,reason FROM social_founder_inputs WHERE id=$1',[ref.inputId])).rows[0]).toEqual({bullets:null,context:null,reason:'owner_unavailable'});
  expect((await runtime.query('SELECT concepts FROM social_draft_requests WHERE id=$1',[saved.requestId])).rows[0]?.['concepts']).toBeNull();expect((await runtime.query('SELECT text FROM social_private_drafts WHERE id=$1',[saved.draftId])).rows[0]?.['text']).toBeNull();
 }finally{await runtime.query("UPDATE workspace_memberships SET status='active',deactivated_at=NULL WHERE workspace_id=$1 AND user_id=$2",[seed.alpha.workspaceId,seed.alpha.admin.userId]);}
});
it.each(['count','generate'] as const)('private input withdrawal across actual %s wait prevents stale output without refunding a possible paid call',async phase=>{
 const ref=await input(),selection:SocialDraftRequest={mode:'linkedin_founder',sourceRefs:[],factBlocks:[],founderInputRefs:[ref],founderFormat:'opinion',founderInputProcessingScope:SOCIAL_FOUNDER_INPUT_PROCESSING_SCOPE};
 const requested=await withTransaction(runtime,()=>requestSocialDrafts(ctx(),selection,authority));if(!requested.ok)throw Error(requested.reason);
 const withdraw=()=>withTransaction(runtime,()=>saveSocialFounderInput(ctx(),{operation:'update',inputId:ref.inputId,expectedRevision:1,...note,publicSafe:false},authority));
 let calls=0;
 await runSocialDraft(worker(),requested.value.requestId,{...port,countInputTokens:async()=>{if(phase==='count')expect(await withdraw()).toMatchObject({ok:true});return 100;},generate:async input=>{calls++;if(phase==='generate')expect(await withdraw()).toMatchObject({ok:true});return port.generate(input);}});
 expect(calls).toBe(phase==='count'?0:1);expect((await runtime.query('SELECT state,concepts FROM social_draft_requests WHERE id=$1',[requested.value.requestId])).rows[0]).toEqual({state:'review',concepts:null});
 const reservations=(await runtime.query('SELECT state FROM provider_reservations WHERE subject_id=$1',[requested.value.requestId])).rows;
 expect(reservations).toEqual(phase==='count'?[]:[{state:'settled'}]);
});
