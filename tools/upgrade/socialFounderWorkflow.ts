import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import type {RepositoryContext} from '@fss/domain/db/workspaceScope.ts';
import {saveSocialFounderInput,readSocialFounderInput} from '@fss/domain/social/founderInputs.ts';
import {requestSocialDrafts} from '@fss/domain/social/drafts.ts';
import {readSocialStandingPlan,readSocialStandingActivity,saveSocialStandingPlan} from '@fss/domain/social/standingPlan.ts';
import type {SocialDraftRequest} from '@fss/contracts';
export const SOCIAL_FOUNDER_UPGRADE_WORKFLOW='social.founder current inputs, erasure and no implicit standing authority (0163–0167, runtime role)';
/** Controlled post-upgrade domain reads/writes as app_runtime; no provider is called. */
export async function runSocialFounderUpgradeWorkflow(owner:RepositoryContext,otherOwner:RepositoryContext):Promise<string>{
 const db=owner.db,w=owner.scope.workspaceId,actor=owner.scope.actor;
 await db.query('SET ROLE app_runtime');
 try{
 assert.equal((await db.query<{role:string}>('SELECT current_user AS role')).rows[0]?.role,'app_runtime');
 assert((await db.query<{name:string}>('SELECT current_database() AS name')).rows[0]?.name.startsWith('fss_upgrade_'),'founder workflow requires its disposable upgrade database');
 assert(actor.kind==='user');const settings=(await db.query('SELECT * FROM workspace_settings WHERE workspace_id=$1 ORDER BY setting_key,version',[w])).rows;
 assert.equal(await withTransaction(db,()=>readSocialStandingPlan(owner)),null,'legacy guide/settings/account markers grant no new plan');
 const source={bullets:'I built a small local test fixture and learned how to explain it plainly.',context:'Fictional owned upgrade fixture, not a product or customer claim.',experienceDate:null};
 const saved=await withTransaction(db,()=>saveSocialFounderInput(owner,{operation:'create',...source,publicSafe:false},async()=>true));assert(saved.ok);const inputId=saved.value.inputId;
 const initial=await withTransaction(db,()=>readSocialFounderInput(owner,inputId,async()=>true));assert(initial?.state==='available');assert.equal(initial.publicSafe,false);
 assert.equal(await withTransaction(db,()=>readSocialFounderInput(otherOwner,inputId,async()=>true)),null,'another current owner cannot read the private note');
 const selection:SocialDraftRequest={mode:'linkedin_founder',sourceRefs:[],factBlocks:[],founderInputRefs:[{inputId,revision:1}],founderFormat:'story',founderInputProcessingScope:'bedrock_haiku_founder_inputs_v1'};
 assert.deepEqual(await withTransaction(db,()=>requestSocialDrafts(owner,selection,async()=>true)),{ok:false,reason:'source_changed_or_unavailable'},'private save is not public-use eligibility');
 const eligible=await withTransaction(db,()=>saveSocialFounderInput(owner,{operation:'update',inputId,expectedRevision:1,...source,publicSafe:true},async()=>true));assert(eligible.ok);assert.equal(eligible.value.revision,2);
 assert.deepEqual(await withTransaction(db,()=>saveSocialFounderInput(owner,{operation:'update',inputId,expectedRevision:1,...source,publicSafe:true},async()=>true)),{ok:false,reason:'stale_revision'});
 const current=await withTransaction(db,()=>readSocialFounderInput(owner,inputId,async()=>true));assert(current?.state==='available');assert.equal(current.expiresAt,initial.expiresAt,'edits never renew the source lifetime');
 const requested=await withTransaction(db,()=>requestSocialDrafts(owner,{...selection,founderInputRefs:[{inputId,revision:2}]},async()=>true));assert(requested.ok);
 // Only the paid model output is a controlled fixture. The real request owner,
 // source selection/hash, current-use consent and erasure triggers remain in use.
 await db.query("UPDATE social_draft_requests SET state='ready',concepts=$3::jsonb WHERE workspace_id=$1 AND id=$2",[w,requested.value.requestId,JSON.stringify([{theme:'build',factRefs:[],variants:[{platform:'linkedin',text:source.bullets}]}])]);
 const refused=await withTransaction(db,()=>saveSocialStandingPlan(owner,{expectedRevision:0,binding:{adapter:'buffer-linkedin-v1',workspaceId:w,ownerUserId:actor.userId,accountId:randomUUID(),accountRevision:1,credentialId:randomUUID(),credentialRevision:1,organizationId:'a'.repeat(24),channelId:'b'.repeat(24),externalId:'fictional-upgrade-native-id'},guideRef:null,calibrationId:randomUUID(),inputIds:[inputId],mediaScope:'none',timezone:'America/New_York',cadence:[{weekday:1,time:'10:00'},{weekday:3,time:'10:00'},{weekday:5,time:'10:00'}],scheduledGenerationGrant:'bedrock_haiku_founder_scheduled_v1',publicationGrant:'linkedin_personal_standing_v1',cancelRemoteOnPause:true}));
 assert.deepEqual(refused,{ok:false,reason:'standing_plan_scope_unavailable'},'even explicit grants cannot bypass real account/credential/calibration prerequisites');
 assert.equal(await withTransaction(db,()=>readSocialStandingPlan(owner)),null);assert.deepEqual((await withTransaction(db,()=>readSocialStandingActivity(owner))).items,[]);
 const removed=await withTransaction(db,()=>saveSocialFounderInput(owner,{operation:'remove',inputId,expectedRevision:2},async()=>true));assert(removed.ok);
 assert.deepEqual((await db.query('SELECT bullets,context,experience_date,public_safe,reason,revision FROM social_founder_inputs WHERE workspace_id=$1 AND id=$2',[w,inputId])).rows,[{bullets:null,context:null,experience_date:null,public_safe:false,reason:'removed',revision:3}]);
 assert.deepEqual((await db.query('SELECT concepts,state FROM social_draft_requests WHERE workspace_id=$1 AND id=$2',[w,requested.value.requestId])).rows,[{concepts:null,state:'review'}]);
 assert.equal(await withTransaction(db,()=>readSocialStandingPlan(owner)),null);assert.deepEqual((await db.query('SELECT * FROM workspace_settings WHERE workspace_id=$1 ORDER BY setting_key,version',[w])).rows,settings,'founder work must not alter existing controls or ceilings');
 return 'app_runtime saved private note, refused public processing until exact public-use revision, enforced cross-owner privacy/current CAS/fixed expiry, created one governed request with controlled model output, physically erased note and derived prose on removal, refused standing activation without current real account/credential/calibration, left plans/activity absent and existing settings unchanged; zero external calls';
 }finally{await db.query('RESET ROLE');}
}
