import {z} from 'zod';
import {socialDeliveryHoldReasonSchema} from '@fss/contracts';
import {claimSocialDelivery,beginSocialSubmission,recordSocialObservation} from '../../social/delivery.ts';
import {socialInspectionSchema} from '@fss/contracts';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {withTransaction} from '../../db/queryable.ts';
import {saveSocialPost,approveSocialPost,readSocialWorkspace,readSocialPost} from '../../social/posts.ts';
import {holdSocialDelivery} from '../../social/deliveryRecovery.ts';
import {readSocialDeliveryQueue} from '../../social/deliveryQueue.ts';
import {createSocialDeliveryRunner} from '../../../../apps/desktop/src/main/social/deliveryRunner.ts';
import {createSocialRuntime,type SocialWindow} from '../../../../apps/desktop/src/main/social/runtime.ts';
import type {AuthedClient} from '../../../../apps/desktop/src/main/authedClient.ts';
import type {SocialAdapter} from '../../../../apps/desktop/src/main/social/adapters.ts';
let db:TestDatabase,seed:TwoWorkspaces,accountId:string,deviceId:string,root:string;
const ctx=()=>repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'user',userId:seed.alpha.admin.userId,role:'admin'}),db.session);
const tx=<T>(run:()=>Promise<T>)=>withTransaction(db.session,run);
beforeAll(async()=>{
 db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);root=await mkdtemp(join(tmpdir(),'native-recovery-'));accountId=randomUUID();deviceId=randomUUID();
 await db.session.query("INSERT INTO social_accounts(workspace_id,id,owner_user_id,platform,external_id,display_name,account_kind,state,adapter_version,verified_at,max_schedule_days) VALUES($1,$2,$3,'linkedin','fixture','David','profile','connected','fixture-v1',now(),30)",[seed.alpha.workspaceId,accountId,seed.alpha.admin.userId]);
 await db.session.query("INSERT INTO devices(workspace_id,id,user_id,device_label,secret_hash) VALUES($1,$2,$3,'Fixture',$4)",[seed.alpha.workspaceId,deviceId,seed.alpha.admin.userId,'a'.repeat(64)]);
});
afterAll(async()=>{await db.drop();await rm(root,{recursive:true,force:true});});
async function ready(){
 const saved=await tx(()=>saveSocialPost(ctx(),{accountId,text:'Fixture post',images:[],publishAt:new Date(Date.now()+3600_000).toISOString(),zone:'America/New_York'}));if(!saved.ok)throw new Error(saved.reason);
 const approved=await tx(()=>approveSocialPost(ctx(),{postId:saved.value.postId,expectedRevision:1}));if(!approved.ok)throw new Error(approved.reason);
 const item=(await readSocialDeliveryQueue(ctx(),deviceId)).items.find(row=>row.postId===saved.value.postId);if(!item)throw new Error('queue_missing');return item;
}
function browserWindow(load:()=>Promise<void>):SocialWindow{
 let destroyed=false;
 return {webContents:{getURL:()=>'',executeJavaScriptInIsolatedWorld:async()=>{throw new Error('unused');},on:()=>{},setWindowOpenHandler:()=>{},session:{setPermissionRequestHandler:()=>{},setPermissionCheckHandler:()=>{},on:()=>{},clearStorageData:async()=>{}}},on:()=>{},loadURL:load,destroy:()=>{destroyed=true;},isDestroyed:()=>destroyed,hide:()=>{},show:()=>{}};
}
function fixture(load:()=>Promise<void>=async()=>{throw new Error('load_failed');},afterRun:()=>Promise<void>=async()=>{}){
 let submissions=0;
 const adapter:SocialAdapter={inspectAccount:async()=>({platform:'linkedin',externalId:'fixture',displayName:'David'}),stage:async()=>({ready:true}),submit:async()=>{submissions++;return {kind:'unknown'};},inspect:async()=>{throw new Error('unused');},cancel:async()=>{throw new Error('unused');}};
 // Transport boundary delegates state to the real domain; no in-memory copy of persistence.
 const api={
  read:async(path:string,parse:(value:unknown)=>unknown)=>({ok:true,value:parse(path==='/social'?await readSocialWorkspace(ctx()):await readSocialDeliveryQueue(ctx(),deviceId))}),
  command:async(path:string,input:unknown,parse:(value:unknown)=>unknown)=>{
   const run=async():Promise<{ok:true;value:unknown}|{ok:false;reason:string}>=>{
    if(path==='/social/delivery/hold')return holdSocialDelivery(ctx(),{...z.object({postId:z.string(),expectedRevision:z.number(),reason:socialDeliveryHoldReasonSchema}).parse(input),deviceId});
    if(path==='/social/delivery/claim')return claimSocialDelivery(ctx(),{...z.object({postId:z.string(),expectedRevision:z.number()}).parse(input),deviceId});
    if(path==='/social/delivery/begin')return beginSocialSubmission(ctx(),{...z.object({claimId:z.string(),approvalId:z.string(),fingerprint:z.string()}).parse(input),deviceId});
    if(path==='/social/delivery/observe')return recordSocialObservation(ctx(),{...z.object({submissionId:z.string(),observation:socialInspectionSchema}).parse(input),deviceId});
    throw new Error('unexpected_command');
   };
   const result=await tx(run);return result.ok?{ok:true,value:parse(result.value)}:result;
  }
 } as unknown as AuthedClient;
 const runtime=createSocialRuntime(()=>browserWindow(load));
 const runner=createSocialDeliveryRunner({api,root,identity:async()=>({workspaceId:seed.alpha.workspaceId,userId:seed.alpha.admin.userId}),now:Date.now,adapters:{linkedin:{version:'fixture-v1',open:(scope,run)=>runtime.withAccount(scope,async({isCurrent})=>{await run(adapter,isCurrent);await afterRun();})}}});
 return {runner,runtime,adapter,submissions:()=>submissions};
}
it('makes a failed browser preparation visible and durable without submitting or requeuing the approval',async()=>{
 const item=await ready(),h=fixture();await h.runner.run(item,()=>true);
 expect(await readSocialPost(ctx(),item.postId)).toMatchObject({state:'failed',reason:'preparation_unavailable',revision:1,text:'Fixture post'});
 expect((await h.runner.read()).items.some(row=>row.postId===item.postId)).toBe(false);
 const session=await db.appRuntimeSession();
 expect(await readSocialPost(repositoryContext(ctx().scope,session),item.postId)).toMatchObject({state:'failed',reason:'preparation_unavailable'});
 expect(h.submissions()).toBe(0);
});

it('shows composer staging failure distinctly before any submission marker',async()=>{
 const item=await ready(),h=fixture(async()=>{});h.adapter.stage=async()=>({ready:false,reason:'staging_unavailable'});
 await h.runner.run(item,()=>true);
 expect(await readSocialPost(ctx(),item.postId)).toMatchObject({state:'failed',reason:'staging_failed'});
 expect((await h.runner.read()).items.some(row=>row.postId===item.postId)).toBe(false);expect(h.submissions()).toBe(0);
});

it('leaves approval intact when its account browser is busy with another operation',async()=>{
 const item=await ready(),h=fixture(async()=>{});
 let entered:()=>void=()=>{},release:()=>void=()=>{};
 const started=new Promise<void>(resolve=>{entered=resolve;}),finished=new Promise<void>(resolve=>{release=resolve;});
 const occupied=h.runtime.withAccount({workspaceId:seed.alpha.workspaceId,userId:seed.alpha.admin.userId,accountId,platform:'linkedin'},async()=>{entered();await finished;});
 await started;
 try{await h.runner.run(item,()=>true);}finally{release();await occupied;}
 expect(await readSocialPost(ctx(),item.postId)).toMatchObject({state:'approved',reason:null});expect(h.submissions()).toBe(0);
});
it('does not persist a previous session failure after sign-out during browser load',async()=>{
 const item=await ready();let loaded:()=>void=()=>{},release:()=>void=()=>{},current=true;
 const started=new Promise<void>(resolve=>{loaded=resolve;}),finished=new Promise<void>(resolve=>{release=resolve;});
 const h=fixture(async()=>{loaded();await finished;throw new Error('load_failed');});
 const pending=h.runner.run(item,()=>current);await started;current=false;h.runtime.signOut();release();await pending;
 expect(await readSocialPost(ctx(),item.postId)).toMatchObject({state:'approved',reason:null});expect(h.submissions()).toBe(0);
});
it('preserves uncertain submission for inspection when the browser fails after delivery entered',async()=>{
 const item=await ready(),h=fixture(async()=>{},async()=>{throw new Error('browser_failed_after_run');});
 await h.runner.run(item,()=>true);
 expect(await readSocialPost(ctx(),item.postId)).toMatchObject({state:'unknown',reason:'inspection_incomplete'});
 // Make the normal bounded inspection deadline due; unknown observations have a backoff.
 await db.session.query('UPDATE social_deliveries SET next_inspection_at=now() WHERE workspace_id=$1 AND post_id=$2',[seed.alpha.workspaceId,item.postId]);
 expect((await h.runner.read()).items.find(row=>row.postId===item.postId)).toMatchObject({action:'inspect',submissionId:expect.any(String)});
 expect(await tx(()=>claimSocialDelivery(ctx(),{deviceId,postId:item.postId,expectedRevision:1}))).toEqual({ok:false,reason:'inspect_existing_submission'});
 expect(h.submissions()).toBe(1);
});
