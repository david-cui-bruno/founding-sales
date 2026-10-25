import assert from 'node:assert/strict';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {saveAnswerBlock,approveAnswerBlock} from '@fss/domain/outreach/facts.ts';
import {readSocialDraftSources} from '@fss/domain/social/draftSources.ts';
import {SOCIAL_DRAFT_MODEL,socialDraftPromptVersion} from '@fss/domain/social/draftPolicy.ts';
import type {SocialDraftRequest} from '@fss/contracts';
import type {ManualProspectApp} from './manualProspectApp.ts';
export const socialFixtureFact='I am planning a bounded maintenance intake worker.';
export const socialFixtureText=socialFixtureFact+'\n\nThis is controlled retained suggestion prose, not live model output.\n\nA plan is not shipped behavior.';
/** Retained records only. No worker, generation, provider, acquisition or paid port. */
export async function seedSocialReview(app:ManualProspectApp){
 const f=app.fixture,runtime=await f.database.appRuntimeSession();
 // A second retained admin permits real last-admin-safe revocation fixtures.
 await runtime.query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES($1,$2,'admin','active') ON CONFLICT DO NOTHING",[f.alpha.workspaceId,f.beta.admin.userId]);
 const ctx=repositoryContext(workspaceScope(f.alpha.workspaceId,{kind:'user',userId:f.alpha.admin.userId,role:'admin'}),runtime);
 const saved=await withTransaction(runtime,()=>saveAnswerBlock(ctx,{kind:'product',text:socialFixtureFact,socialInput:{topic:'build',status:'planned',sanitized:true}}));assert(saved.ok);
 const ref={id:saved.value.id,version:saved.value.version};assert((await withTransaction(runtime,()=>approveAnswerBlock(ctx,ref))).ok);
 const selection:SocialDraftRequest={mode:'linkedin_grounded',sourceRefs:[],factBlocks:[ref]};
 const prepared=await withTransaction(runtime,()=>readSocialDraftSources(ctx,selection));assert(prepared.ok);
 const concepts=[{theme:'build',factRefs:[ref],variants:[{platform:'linkedin',text:socialFixtureText}]}];
 const row=(await runtime.query<{id:string}>(`INSERT INTO social_draft_requests(workspace_id,owner_user_id,source_selection,source_hash,prompt_version,model_name,state,concepts) VALUES($1,$2,$3::jsonb,$4,$5,$6,'ready',$7::jsonb) RETURNING id`,[f.alpha.workspaceId,f.alpha.admin.userId,JSON.stringify(selection),prepared.value.hash,socialDraftPromptVersion(selection.mode),SOCIAL_DRAFT_MODEL,JSON.stringify(concepts)])).rows[0]!;
 return {requestId:row.id,ref,concepts};
}
export async function socialProductSnapshot(app:ManualProspectApp){
 const value:Record<string,unknown[]>={};
 const tables=['social_posts','social_post_revisions','social_post_approvals','social_deliveries','social_accounts','social_assets','jobs','provider_reservations','contacts','phone_routes','email_addresses','sequence_enrollments','outbound_messages','command_receipts','audit_events'];
 for(const table of tables){
  const exists=(await app.fixture.db.query('SELECT to_regclass($1) AS name',[table])).rows[0]?.['name'];assert(exists,`Expected table ${table}`);
  value[table]=(await app.fixture.db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ${table==='audit_events'?"WHERE action NOT LIKE 'auth.%'":''} ORDER BY to_jsonb(t)::text`)).rows;
 }
 return value;
}
