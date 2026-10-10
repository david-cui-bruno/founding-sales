import {randomUUID} from 'node:crypto';import {beforeAll,afterAll,it,expect} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';import {withTransaction} from '../../db/queryable.ts';
import {saveSocialPost,approveSocialPost,requestSocialCancellation,readSocialPost} from '../../social/posts.ts';
import {holdSocialDelivery} from '../../social/deliveryRecovery.ts';
import {claimSocialDelivery,beginSocialSubmission,recordSocialObservation} from '../../social/delivery.ts';
let db:TestDatabase,seed:TwoWorkspaces,accountId:string,device:string,otherDevice:string;
const ctx=()=>repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'user',userId:seed.alpha.admin.userId,role:'admin'}),db.session);const tx=<T>(fn:()=>Promise<T>)=>withTransaction(db.session,fn);
async function ready(){const p=await tx(()=>saveSocialPost(ctx(),{accountId,text:'Fixture post',images:[],publishAt:new Date(Date.now()+3600_000).toISOString(),zone:'America/New_York'}));if(!p.ok)throw new Error(p.reason);const a=await tx(()=>approveSocialPost(ctx(),{postId:p.value.postId,expectedRevision:1}));if(!a.ok)throw new Error(a.reason);return {postId:p.value.postId,...a.value};}
beforeAll(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);accountId=randomUUID();device=randomUUID();otherDevice=randomUUID();await db.session.query("INSERT INTO social_accounts(workspace_id,id,owner_user_id,platform,external_id,display_name,account_kind,state,adapter_version,verified_at,max_schedule_days) VALUES($1,$2,$3,'linkedin','fixture','David','profile','connected','fixture-v1',now(),30)",[seed.alpha.workspaceId,accountId,seed.alpha.admin.userId]);for(const id of [device,otherDevice])await db.session.query("INSERT INTO devices(workspace_id,id,user_id,device_label,secret_hash) VALUES($1,$2,$3,'Fixture',$4)",[seed.alpha.workspaceId,id,seed.alpha.admin.userId,'a'.repeat(64)]);});afterAll(async()=>db.drop());
it('only one device can prepare, and an expired preparation can be reclaimed but a committed submission cannot',async()=>{
 const p=await ready();const c=await tx(()=>claimSocialDelivery(ctx(),{deviceId:device,postId:p.postId,expectedRevision:1}));if(!c.ok)throw new Error(c.reason);
 expect(await tx(()=>claimSocialDelivery(ctx(),{deviceId:otherDevice,postId:p.postId,expectedRevision:1}))).toEqual({ok:false,reason:'delivery_busy'});
 await db.session.query("UPDATE social_deliveries SET claim_expires_at=now()-interval '1 second' WHERE workspace_id=$1 AND post_id=$2",[seed.alpha.workspaceId,p.postId]);
 const c2=await tx(()=>claimSocialDelivery(ctx(),{deviceId:otherDevice,postId:p.postId,expectedRevision:1}));if(!c2.ok)throw new Error(c2.reason);
 expect(await tx(()=>beginSocialSubmission(ctx(),{deviceId:device,...c.value}))).toEqual({ok:false,reason:'claim_invalid'});
 const begun=await tx(()=>beginSocialSubmission(ctx(),{deviceId:otherDevice,...c2.value}));expect(begun.ok).toBe(true);
 expect(await tx(()=>beginSocialSubmission(ctx(),{deviceId:otherDevice,...c2.value}))).toEqual({ok:false,reason:'claim_invalid'});
 expect(await tx(()=>claimSocialDelivery(ctx(),{deviceId:device,postId:p.postId,expectedRevision:1}))).toEqual({ok:false,reason:'inspect_existing_submission'});
});
it('cancelling during staging prevents submission; ambiguous inspection never permits repost',async()=>{
 const p=await ready();const c=await tx(()=>claimSocialDelivery(ctx(),{deviceId:device,postId:p.postId,expectedRevision:1}));if(!c.ok)throw new Error(c.reason);
 await tx(()=>requestSocialCancellation(ctx(),{postId:p.postId,expectedRevision:1}));expect(await tx(()=>beginSocialSubmission(ctx(),{deviceId:device,...c.value}))).toEqual({ok:false,reason:'claim_invalid'});
 const p2=await ready();const c2=await tx(()=>claimSocialDelivery(ctx(),{deviceId:device,postId:p2.postId,expectedRevision:1}));if(!c2.ok)throw new Error(c2.reason);const b=await tx(()=>beginSocialSubmission(ctx(),{deviceId:device,...c2.value}));if(!b.ok)throw new Error(b.reason);
 const observation={state:'absent' as const,receiptId:null,permalink:null,observedAt:new Date().toISOString(),accountExternalId:'fixture',observedFingerprint:p2.fingerprint,complete:false};
 expect(await tx(()=>recordSocialObservation(ctx(),{deviceId:device,submissionId:b.value.submissionId,observation}))).toMatchObject({ok:true,value:{state:'unknown'}});
 expect(await tx(()=>claimSocialDelivery(ctx(),{deviceId:device,postId:p2.postId,expectedRevision:1}))).toEqual({ok:false,reason:'inspect_existing_submission'});
 await tx(()=>requestSocialCancellation(ctx(),{postId:p2.postId,expectedRevision:1}));
 expect(await tx(()=>recordSocialObservation(ctx(),{deviceId:device,submissionId:b.value.submissionId,observation:{...observation,state:'published',receiptId:'native-1',permalink:'https://www.linkedin.com/feed/update/native-1',complete:true}}))).toMatchObject({ok:true,value:{state:'published'}});
 expect((await readSocialPost(ctx(),p2.postId))?.state).toBe('published');
});
it('keeps a confirmed future native schedule eligible for readback at publication time, even beyond 24 hours',async()=>{
 const p=await tx(()=>saveSocialPost(ctx(),{accountId,text:'Future fixture',images:[],publishAt:new Date(Date.now()+7*86400_000).toISOString(),zone:'America/New_York'}));if(!p.ok)throw new Error(p.reason);
 const a=await tx(()=>approveSocialPost(ctx(),{postId:p.value.postId,expectedRevision:1}));if(!a.ok)throw new Error(a.reason);
 const c=await tx(()=>claimSocialDelivery(ctx(),{deviceId:device,postId:p.value.postId,expectedRevision:1}));if(!c.ok)throw new Error(c.reason);const b=await tx(()=>beginSocialSubmission(ctx(),{deviceId:device,...c.value}));if(!b.ok)throw new Error(b.reason);
 await tx(()=>recordSocialObservation(ctx(),{deviceId:device,submissionId:b.value.submissionId,observation:{state:'scheduled',receiptId:'future-native',permalink:null,observedAt:new Date().toISOString(),accountExternalId:'fixture',observedFingerprint:a.value.fingerprint,complete:true}}));
 const r=(await db.session.query<{next_inspection_at:Date;inspection_deadline:Date}>('SELECT next_inspection_at,inspection_deadline FROM social_deliveries WHERE workspace_id=$1 AND post_id=$2',[seed.alpha.workspaceId,p.value.postId])).rows[0]!;
 expect(r.next_inspection_at.getTime()).toBeGreaterThan(Date.now()+6*86400_000);expect(r.inspection_deadline.getTime()).toBeGreaterThan(Date.now()+7*86400_000);
});
it('queues only owned pending work and binds restart inspection to its submitting device',async()=>{
 const {readSocialDeliveryQueue}=await import('../../social/deliveryQueue.ts');const p=await ready();
 const initial=await readSocialDeliveryQueue(ctx(),device);expect(initial.items.find(x=>x.postId===p.postId)).toMatchObject({action:'submit',fingerprint:p.fingerprint,snapshot:{text:'Fixture post'}});
 const c=await tx(()=>claimSocialDelivery(ctx(),{deviceId:device,postId:p.postId,expectedRevision:1}));if(!c.ok)throw new Error(c.reason);
 expect((await readSocialDeliveryQueue(ctx(),device)).items.some(x=>x.postId===p.postId)).toBe(false);
 const b=await tx(()=>beginSocialSubmission(ctx(),{deviceId:device,...c.value}));if(!b.ok)throw new Error(b.reason);
 expect((await readSocialDeliveryQueue(ctx(),device)).items.find(x=>x.postId===p.postId)).toMatchObject({action:'inspect',submissionId:b.value.submissionId});
 expect((await readSocialDeliveryQueue(ctx(),otherDevice)).items.some(x=>x.postId===p.postId)).toBe(false);
 const other=repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'user',userId:seed.alpha.salesperson.userId,role:'salesperson'}),db.session);
 expect(await readSocialDeliveryQueue(other,device)).toEqual({items:[]});
 const foreign=repositoryContext(workspaceScope(seed.beta.workspaceId,{kind:'user',userId:seed.beta.admin.userId,role:'admin'}),db.session);
 expect(await readSocialDeliveryQueue(foreign,device)).toEqual({items:[]});
});
it('makes a future scheduled cancellation immediately due without refreshing its deadline on repeat requests',async()=>{
 const {readSocialDeliveryQueue}=await import('../../social/deliveryQueue.ts');const p=await ready();const c=await tx(()=>claimSocialDelivery(ctx(),{deviceId:device,postId:p.postId,expectedRevision:1}));if(!c.ok)throw new Error(c.reason);const b=await tx(()=>beginSocialSubmission(ctx(),{deviceId:device,...c.value}));if(!b.ok)throw new Error(b.reason);
 await tx(()=>recordSocialObservation(ctx(),{deviceId:device,submissionId:b.value.submissionId,observation:{state:'scheduled',receiptId:'cancel-fixture',permalink:null,observedAt:new Date().toISOString(),accountExternalId:'fixture',observedFingerprint:p.fingerprint,complete:true}}));
 expect((await readSocialDeliveryQueue(ctx(),device)).items.some(x=>x.postId===p.postId)).toBe(false);
 await tx(()=>requestSocialCancellation(ctx(),{postId:p.postId,expectedRevision:1}));
 expect((await readSocialDeliveryQueue(ctx(),device)).items.find(x=>x.postId===p.postId)).toMatchObject({action:'cancel',receiptId:'cancel-fixture'});
 const deadline=async()=>(await db.session.query('SELECT inspection_deadline FROM social_deliveries WHERE workspace_id=$1 AND post_id=$2',[seed.alpha.workspaceId,p.postId])).rows[0]?.['inspection_deadline'];const first=await deadline();await tx(()=>requestSocialCancellation(ctx(),{postId:p.postId,expectedRevision:1}));expect(await deadline()).toEqual(first);
 await db.session.query("UPDATE social_deliveries SET inspection_deadline=now()-interval '1 second' WHERE workspace_id=$1 AND post_id=$2",[seed.alpha.workspaceId,p.postId]);expect((await readSocialDeliveryQueue(ctx(),device)).items.some(x=>x.postId===p.postId)).toBe(false);
});

it('persists image identity for restart, rejects conflicting bindings, and preserves it on uncertain reads',async()=>{
 const {readSocialDeliveryQueue}=await import('../../social/deliveryQueue.ts');
 const p=await ready(),c=await tx(()=>claimSocialDelivery(ctx(),{deviceId:device,postId:p.postId,expectedRevision:1}));if(!c.ok)throw new Error(c.reason);
 const b=await tx(()=>beginSocialSubmission(ctx(),{deviceId:device,...c.value}));if(!b.ok)throw new Error(b.reason);
 // Seed an image snapshot to isolate observation checks from upload setup.
 await db.session.query("UPDATE social_post_approvals SET snapshot=jsonb_set(snapshot,'{images}',$3::jsonb) WHERE workspace_id=$1 AND post_id=$2",[seed.alpha.workspaceId,p.postId,JSON.stringify([{assetId:randomUUID(),version:1,sha256:'b'.repeat(64),altText:'Image',mime:'image/png',width:100,height:100}])]);
 const mediaBinding={receiptId:'urn:li:share:123',fingerprint:p.fingerprint,images:[{sha256:'b'.repeat(64),platformId:'native-image'}]};
 const observation={state:'scheduled' as const,receiptId:mediaBinding.receiptId,permalink:null,observedAt:new Date().toISOString(),accountExternalId:'fixture',observedFingerprint:p.fingerprint,complete:true,mediaBinding};
 const save=(o:typeof observation)=>tx(()=>recordSocialObservation(ctx(),{deviceId:device,submissionId:b.value.submissionId,observation:o}));
 expect(await save({...observation,mediaBinding:{...mediaBinding,images:[{sha256:'c'.repeat(64),platformId:'native-image'}]}})).toMatchObject({ok:false,reason:'invalid_media_binding'});
 expect(await save({...observation,complete:false})).toMatchObject({ok:false,reason:'invalid_media_binding'});
 expect(await save({...observation,mediaBinding:{...mediaBinding,fingerprint:'c'.repeat(64)}})).toMatchObject({ok:false,reason:'invalid_media_binding'});
 expect(await save({...observation,mediaBinding:{...mediaBinding,images:[...mediaBinding.images,...mediaBinding.images]}})).toMatchObject({ok:false,reason:'invalid_media_binding'});
 expect(await tx(()=>recordSocialObservation(ctx(),{deviceId:otherDevice,submissionId:b.value.submissionId,observation}))).toMatchObject({ok:false,reason:'wrong_device'});
 const {mediaBinding:ignored,...missing}=observation;void ignored;
 expect(await tx(()=>recordSocialObservation(ctx(),{deviceId:device,submissionId:b.value.submissionId,observation:missing}))).toMatchObject({ok:true,value:{state:'scheduled'}});
 expect(await save(observation)).toMatchObject({ok:true,value:{state:'scheduled'}});
 expect(await save({...observation,mediaBinding:{...mediaBinding,images:[{sha256:'b'.repeat(64),platformId:'replacement'}]}})).toMatchObject({ok:false,reason:'media_binding_conflict'});
 expect(await save({...observation,receiptId:'urn:li:share:999'})).toMatchObject({ok:false});
 const {mediaBinding:unused,...withoutBinding}=observation;void unused;
 expect(await tx(()=>recordSocialObservation(ctx(),{deviceId:device,submissionId:b.value.submissionId,observation:{...withoutBinding,state:'unknown',complete:false}}))).toMatchObject({ok:true});
 await db.session.query('UPDATE social_deliveries SET next_inspection_at=now() WHERE workspace_id=$1 AND post_id=$2',[seed.alpha.workspaceId,p.postId]);
 expect((await readSocialDeliveryQueue(ctx(),device)).items.find(x=>x.postId===p.postId)).toMatchObject({receiptId:mediaBinding.receiptId,mediaBinding});
});

it('makes a missed approved schedule durable and requires a new revision and approval before delivery',async()=>{
 const p=await ready();
 expect(await tx(()=>holdSocialDelivery(ctx(),{deviceId:device,postId:p.postId,expectedRevision:1,reason:'schedule_missed'}))).toMatchObject({ok:true,value:{state:'failed',reason:'schedule_missed',revision:1}});
 expect(await readSocialPost(ctx(),p.postId)).toMatchObject({state:'failed',reason:'schedule_missed',text:'Fixture post'});
 expect(await tx(()=>claimSocialDelivery(ctx(),{deviceId:device,postId:p.postId,expectedRevision:1}))).toEqual({ok:false,reason:'delivery_not_pending'});
 const revised=await tx(()=>saveSocialPost(ctx(),{postId:p.postId,expectedRevision:1,accountId,text:'Fixture post',images:[],publishAt:new Date(Date.now()+7200_000).toISOString(),zone:'America/New_York'}));
 expect(revised).toMatchObject({ok:true,value:{revision:2,state:'draft'}});
 expect(await tx(()=>claimSocialDelivery(ctx(),{deviceId:device,postId:p.postId,expectedRevision:2}))).toEqual({ok:false,reason:'approval_required'});
});
it('keeps successful sibling platforms and unknown submissions intact when another platform is held',async()=>{
 const successful=await ready(),uncertain=await ready(),held=await ready();
 for(const p of [successful,uncertain]){
  const c=await tx(()=>claimSocialDelivery(ctx(),{deviceId:device,postId:p.postId,expectedRevision:1}));if(!c.ok)throw new Error(c.reason);
  const b=await tx(()=>beginSocialSubmission(ctx(),{deviceId:device,...c.value}));if(!b.ok)throw new Error(b.reason);
  const complete=p===successful;
  await tx(()=>recordSocialObservation(ctx(),{deviceId:device,submissionId:b.value.submissionId,observation:{state:complete?'scheduled':'unknown',receiptId:complete?'native-success':null,permalink:null,observedAt:new Date().toISOString(),accountExternalId:complete?'fixture':null,observedFingerprint:complete?p.fingerprint:null,complete}}));
 }
 expect(await tx(()=>holdSocialDelivery(ctx(),{deviceId:device,postId:held.postId,expectedRevision:1,reason:'account_identity_changed'}))).toMatchObject({ok:true,value:{state:'failed'}});
 expect(await tx(()=>holdSocialDelivery(ctx(),{deviceId:device,postId:uncertain.postId,expectedRevision:1,reason:'preparation_unavailable'}))).toEqual({ok:false,reason:'inspect_existing_submission'});
 expect(await readSocialPost(ctx(),successful.postId)).toMatchObject({state:'scheduled',reason:null});
 expect(await readSocialPost(ctx(),uncertain.postId)).toMatchObject({state:'unknown',reason:'inspection_incomplete'});
});
it('rejects stale recovery and persists recovery across a fresh runtime session without changing its approval',async()=>{
 const p=await ready();const input={deviceId:device,postId:p.postId,expectedRevision:1,reason:'adapter_unavailable' as const};
 expect(await tx(()=>holdSocialDelivery(ctx(),{...input,expectedRevision:2}))).toEqual({ok:false,reason:'stale_revision'});
 const first=await tx(()=>holdSocialDelivery(ctx(),input));expect(first).toMatchObject({ok:true,value:{state:'failed',text:'Fixture post'}});
 expect(await tx(()=>holdSocialDelivery(ctx(),input))).toEqual(first);
 const runtime=await db.appRuntimeSession(),restarted=repositoryContext(ctx().scope,runtime);
 expect(await readSocialPost(restarted,p.postId)).toMatchObject({state:'failed',reason:'adapter_unavailable',revision:1});
});
it('serializes recovery against the submission marker so uncertainty can never become editable',async()=>{
 const p=await ready(),c=await tx(()=>claimSocialDelivery(ctx(),{deviceId:device,postId:p.postId,expectedRevision:1}));if(!c.ok)throw new Error(c.reason);
 const session=await db.appRuntimeSession(),second=repositoryContext(ctx().scope,session);
 const [held,began]=await Promise.all([tx(()=>holdSocialDelivery(ctx(),{deviceId:device,postId:p.postId,expectedRevision:1,reason:'account_identity_changed'})),withTransaction(session,()=>beginSocialSubmission(second,{deviceId:device,...c.value}))]);
 if(began.ok){expect(held).toEqual({ok:false,reason:'inspect_existing_submission'});expect(await readSocialPost(ctx(),p.postId)).toMatchObject({state:'submitting'});}
 else{expect(began).toEqual({ok:false,reason:'claim_invalid'});expect(held).toMatchObject({ok:true,value:{state:'failed'}});}
});
