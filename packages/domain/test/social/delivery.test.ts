import {randomUUID} from 'node:crypto';import {beforeAll,afterAll,it,expect} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';import {withTransaction} from '../../db/queryable.ts';
import {saveSocialPost,approveSocialPost,requestSocialCancellation,readSocialPost} from '../../social/posts.ts';
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
