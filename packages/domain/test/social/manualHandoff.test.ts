import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {withTransaction} from '../../db/queryable.ts';
import {saveSocialConnection} from '../../social/accounts.ts';
import {saveSocialPost,readSocialWorkspace,approveSocialPost} from '../../social/posts.ts';
import {claimSocialDelivery,beginSocialSubmission} from '../../social/delivery.ts';
import {registerSocialAsset,completeSocialAsset,deleteSocialAsset} from '../../social/assets.ts';
import {previewSocialManualHandoff,confirmSocialManualHandoff,readSocialManualHandoff} from '../../social/manualHandoff.ts';
let db:TestDatabase,seed:TwoWorkspaces;
const ctx=(beta=false)=>{const s=beta?seed.beta:seed.alpha;return repositoryContext(workspaceScope(s.workspaceId,{kind:'user',userId:s.admin.userId,role:'admin'}),db.session);};
const tx=<T>(fn:()=>Promise<T>)=>withTransaction(db.session,fn);
beforeAll(async()=>{db=await createTestDatabase();await db.session.query(await readFile(new URL('./support/manualHandoff.sql',import.meta.url),'utf8'));seed=await seedTwoWorkspaces(db.session);});
afterAll(async()=>db.drop());
async function draft(platform:'facebook'|'x'='x',text='Useful maintenance observation.'){
 const accountId=randomUUID();await tx(()=>saveSocialConnection(ctx(),{accountId,platform,externalId:`fixture-${accountId}`,displayName:'Founder',accountKind:platform==='facebook'?'page':'profile'}));
 const saved=await tx(()=>saveSocialPost(ctx(),{accountId,text,images:[],publishAt:new Date(Date.now()+86400000).toISOString(),zone:'America/New_York'}));if(!saved.ok)throw new Error(saved.reason);return saved.value;
}
it('reviews exact manual text and preserves an unsupported destination without claiming scheduling',async()=>{
 const post=await draft();const input={postId:post.postId,expectedRevision:post.revision};
 const preview=await tx(()=>previewSocialManualHandoff(ctx(),input));if(!preview.ok)throw new Error(preview.reason);
 expect(preview.value).toMatchObject({state:'review_required',approvalId:null,snapshot:{text:post.text,account:{platform:'x',accountKind:'profile'}}});
 const confirmed=await tx(()=>confirmSocialManualHandoff(ctx(),{...input,fingerprint:preview.value.fingerprint,reviewedDestination:true}));if(!confirmed.ok)throw new Error(confirmed.reason);
 expect(await tx(()=>readSocialManualHandoff(ctx(),input))).toMatchObject({ok:true,value:{state:'manual_needed',approvalId:confirmed.value.approvalId,snapshot:{text:post.text}}});
 const workspace=await readSocialWorkspace(ctx());expect(workspace.accounts.find(a=>a.id===post.accountId)?.state).toBe('unsupported');expect(workspace.posts.find(p=>p.postId===post.postId)?.state).toBe('draft');
});

it('requires explicit destination review and rejects another workspace or changed revision',async()=>{
 const post=await draft('facebook');const input={postId:post.postId,expectedRevision:1};
 const preview=await tx(()=>previewSocialManualHandoff(ctx(),input));if(!preview.ok)throw new Error(preview.reason);
 expect(await tx(()=>confirmSocialManualHandoff(ctx(),{...input,fingerprint:preview.value.fingerprint,reviewedDestination:false}))).toEqual({ok:false,reason:'destination_review_required'});
 expect(await tx(()=>previewSocialManualHandoff(ctx(true),input))).toEqual({ok:false,reason:'not_found'});
 await tx(()=>saveSocialPost(ctx(),{postId:post.postId,accountId:post.accountId,text:'Changed content',images:post.images,publishAt:post.publishAt,zone:post.zone,expectedRevision:1}));
 expect(await tx(()=>confirmSocialManualHandoff(ctx(),{...input,fingerprint:preview.value.fingerprint,reviewedDestination:true}))).toEqual({ok:false,reason:'stale_revision'});
});

it('invalidates account changes without changing its unsupported state and repeats the same exact approval',async()=>{
 const post=await draft();const input={postId:post.postId,expectedRevision:1};const preview=await tx(()=>previewSocialManualHandoff(ctx(),input));if(!preview.ok)throw new Error(preview.reason);
 const confirmation={...input,fingerprint:preview.value.fingerprint,reviewedDestination:true};
 const first=await tx(()=>confirmSocialManualHandoff(ctx(),confirmation));expect(await tx(()=>confirmSocialManualHandoff(ctx(),confirmation))).toEqual(first);
 await tx(()=>saveSocialConnection(ctx(),{accountId:post.accountId,platform:'x',externalId:preview.value.snapshot.account.externalId,displayName:'Changed label',accountKind:'profile'}));
 expect(await tx(()=>confirmSocialManualHandoff(ctx(),confirmation))).toEqual({ok:false,reason:'approval_changed'});
 expect(await tx(()=>readSocialManualHandoff(ctx(),input))).toMatchObject({ok:true,value:{state:'review_required',approvalId:null}});
});

it('conserves one immutable approval under two concurrent runtime confirmations',async()=>{
 const post=await draft();const input={postId:post.postId,expectedRevision:1};const preview=await tx(()=>previewSocialManualHandoff(ctx(),input));if(!preview.ok)throw new Error(preview.reason);
 const left=await db.appRuntimeSession(),right=await db.appRuntimeSession();
 const confirmation={...input,fingerprint:preview.value.fingerprint,reviewedDestination:true};
 const results=await Promise.all([withTransaction(left,()=>confirmSocialManualHandoff(repositoryContext(ctx().scope,left),confirmation)),withTransaction(right,()=>confirmSocialManualHandoff(repositoryContext(ctx().scope,right),confirmation))]);
 expect(results[0]).toEqual(results[1]);expect(results[0]).toMatchObject({ok:true});
});

it('refuses overweight X text and elapsed time instead of offering late publication',async()=>{
 const post=await draft('x','界'.repeat(141));
 expect(await tx(()=>previewSocialManualHandoff(ctx(),{postId:post.postId,expectedRevision:1}))).toEqual({ok:false,reason:'content_needs_edit'});
 await tx(()=>saveSocialPost(ctx(),{postId:post.postId,accountId:post.accountId,text:'Valid',images:[],publishAt:new Date(Date.now()-60000).toISOString(),zone:post.zone,expectedRevision:1}));
 expect(await tx(()=>readSocialManualHandoff(ctx(),{postId:post.postId,expectedRevision:2}))).toEqual({ok:false,reason:'schedule_in_past'});
});

it('binds derivative digest and alt text and fences a concurrent deletion until review commits',async()=>{
 const original={sha256:'a'.repeat(64),bytes:100,mime:'image/png' as const,origin:{kind:'screenshot' as const,sourceUrl:null,usageNote:null}};
 const asset=await tx(()=>registerSocialAsset(ctx(),original));if(!asset.ok)throw new Error(asset.reason);await tx(()=>completeSocialAsset(ctx(),{...asset.value,verified:original}));
 const derivative=await tx(()=>registerSocialAsset(ctx(),{...original,assetId:asset.value.assetId,expectedVersion:1,width:10,height:10}));if(!derivative.ok)throw new Error(derivative.reason);await tx(()=>completeSocialAsset(ctx(),{...derivative.value,verified:original}));
 const post=await draft();await tx(()=>saveSocialPost(ctx(),{postId:post.postId,accountId:post.accountId,text:post.text,images:[{assetId:asset.value.assetId,version:2,altText:'Reviewed image'}],publishAt:post.publishAt,zone:post.zone,expectedRevision:1}));
 const input={postId:post.postId,expectedRevision:2};const preview=await tx(()=>previewSocialManualHandoff(ctx(),input));if(!preview.ok)throw new Error(preview.reason);
 expect(preview.value.snapshot.images).toMatchObject([{version:2,sha256:original.sha256,altText:'Reviewed image'}]);
 const second=await db.appRuntimeSession();const other=repositoryContext(ctx().scope,second);let deleted:Promise<unknown>|undefined;
 await tx(async()=>{const result=await confirmSocialManualHandoff(ctx(),{...input,fingerprint:preview.value.fingerprint,reviewedDestination:true});expect(result.ok).toBe(true);deleted=withTransaction(second,()=>deleteSocialAsset(other,asset.value.assetId));});
 await deleted;
 expect(await tx(()=>readSocialManualHandoff(ctx(),input))).toEqual({ok:false,reason:'image_unavailable'});
});

it('refuses replacement when any earlier revision has an ambiguous submission marker',async()=>{
 const accountId=randomUUID();await tx(()=>saveSocialConnection(ctx(),{accountId,platform:'linkedin',externalId:`native-${accountId}`,displayName:'Founder',accountKind:'profile'}));
 const saved=await tx(()=>saveSocialPost(ctx(),{accountId,text:'Original native post',images:[],publishAt:new Date(Date.now()+86400000).toISOString(),zone:'America/New_York'}));if(!saved.ok)throw new Error(saved.reason);
 const post=saved.value,deviceId=randomUUID();await db.session.query('INSERT INTO devices(workspace_id,id,user_id,device_label,secret_hash) VALUES($1,$2,$3,$4,$5)',[seed.alpha.workspaceId,deviceId,seed.alpha.admin.userId,'Fixture','a'.repeat(64)]);
 await tx(()=>approveSocialPost(ctx(),{postId:post.postId,expectedRevision:1}));
 const claim=await tx(()=>claimSocialDelivery(ctx(),{deviceId,postId:post.postId,expectedRevision:1}));if(!claim.ok)throw new Error(claim.reason);
 const begun=await tx(()=>beginSocialSubmission(ctx(),{deviceId,claimId:claim.value.claimId,approvalId:claim.value.approvalId,fingerprint:claim.value.fingerprint}));expect(begun.ok).toBe(true);
 // Historical inconsistent current revision fixture: original ambiguity must still fence handoff.
 await db.session.query('INSERT INTO social_post_revisions(workspace_id,post_id,revision,account_id,text,publish_at,zone) VALUES($1,$2,2,$3,$4,$5,$6)',[seed.alpha.workspaceId,post.postId,accountId,'Replacement',post.publishAt,post.zone]);
 await db.session.query('UPDATE social_posts SET current_revision=2 WHERE workspace_id=$1 AND id=$2',[seed.alpha.workspaceId,post.postId]);
 expect(await tx(()=>previewSocialManualHandoff(ctx(),{postId:post.postId,expectedRevision:2}))).toEqual({ok:false,reason:'inspect_existing_submission'});
});
