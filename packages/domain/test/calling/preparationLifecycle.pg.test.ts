import {afterAll,beforeAll,expect,it} from 'vitest';
import {callingPreparationFixture} from './preparationFixture.ts';
import {changePreparedCallingMemberAuthority,sweepCallingPreparations} from '../../calling/preparationMaintenance.ts';
import {confirmCallingPreparation,readCallingPreparation} from '../../calling/preparation.ts';
import {recordManualProspectFeedback} from '../../sourcing/manualProspects.ts';
import {lockPreparationCleanup} from '../../calling/preparationLifecycle.ts';
let f:Awaited<ReturnType<typeof callingPreparationFixture>>;
beforeAll(async()=>{f=await callingPreparationFixture();await f.runtime.query("INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'admin')",[f.seed.alpha.workspaceId,f.seed.beta.admin.userId]);});
afterAll(async()=>f?.stop());
it('raw restrictive member SQL refuses without preheld custody; registered restriction erases exact source copies',async()=>{
 const p=await f.prepared(),w=f.seed.alpha.workspaceId,user=f.seed.alpha.admin.userId;
 await expect(f.tx(()=>f.runtime.query("UPDATE workspace_memberships SET role='salesperson' WHERE workspace_id=$1 AND user_id=$2",[w,user]))).rejects.toMatchObject({code:'40001'});
 expect((await f.runtime.query('SELECT state FROM calling_preparations WHERE id=$1',[p.preparationId])).rows).toEqual([{state:'live'}]);
 const operator={...f.ctx(),scope:{...f.ctx().scope,actor:{kind:'user' as const,userId:f.seed.beta.admin.userId,role:'admin' as const}}};
 expect(await f.tx(()=>changePreparedCallingMemberAuthority(operator,{userId:user,role:'salesperson'},async()=>true))).toEqual({ok:true});
 expect((await f.runtime.query('SELECT state FROM calling_preparations WHERE id=$1',[p.preparationId])).rows).toEqual([{state:'erased'}]);
 expect((await f.runtime.query('SELECT e164 FROM phone_routes WHERE id=$1',[p.routeId])).rows).toEqual([{e164:null}]);
 await f.runtime.query("UPDATE workspace_memberships SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[w,user]);
 expect(await f.tx(()=>confirmCallingPreparation(f.ctx(),p.input,async()=>true))).toMatchObject({ok:false,reason:'preparation_terminal'});
});
it('self-loss rolls back member restriction and physical erasure instead of accepting without current admin authority',async()=>{
 const p=await f.prepared();
 await expect(f.tx(()=>changePreparedCallingMemberAuthority(f.ctx(),{userId:f.seed.alpha.admin.userId,status:'inactive'},async()=>true))).rejects.toThrow('authority_changed');
 expect((await f.runtime.query('SELECT state FROM calling_preparations WHERE id=$1',[p.preparationId])).rows).toEqual([{state:'live'}]);
 expect(await f.tx(()=>readCallingPreparation(f.ctx(),p.input.selection,async()=>true))).toMatchObject({state:'available'});
});
it('no-live-preparation restriction cannot race a late confirmation into an inactive creator grant',async()=>{
 const source=await f.source(),w=f.seed.alpha.workspaceId,user=f.seed.alpha.admin.userId;
 // No preparation exists yet, so raw SQL is safe to restrict this member.
 // Existing preparations from earlier cases belong to the same creator; clean them first.
 await f.tx(async()=>{await lockPreparationCleanup(f.ctx());for(const row of(await f.runtime.query<{id:string}>("SELECT id FROM calling_preparations WHERE state='live' AND workspace_id=$1",[w])).rows)await f.runtime.query("SELECT erase_calling_preparation($1,$2,'source_deleted')",[w,row.id]);});
 await f.runtime.query("UPDATE workspace_memberships SET role='salesperson' WHERE workspace_id=$1 AND user_id=$2",[w,user]);
 try{expect(await f.tx(()=>confirmCallingPreparation(f.ctx(),source.input,async()=>true))).toEqual({ok:false,reason:'admin_only'});}
 finally{await f.runtime.query("UPDATE workspace_memberships SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[w,user]);}
 expect((await f.runtime.query('SELECT 1 FROM calling_preparations WHERE candidate_ref=$1',[source.input.selection.candidateId])).rows).toEqual([]);
});
it('clearing the exact kept choice atomically erases; restoring the selection cannot resurrect or rebind',async()=>{
 const p=await f.prepared(),candidateId=p.input.selection.candidateId;
 expect(await f.tx(()=>recordManualProspectFeedback(f.ctx(),{candidateId,expectedRevision:1,state:'kept',phoneChoice:null}))).toMatchObject({ok:true});
 expect((await f.runtime.query('SELECT state,choice,profile_hash,source_url_hashes FROM calling_preparations WHERE id=$1',[p.preparationId])).rows).toEqual([{state:'erased',choice:null,profile_hash:null,source_url_hashes:null}]);
 expect(await f.tx(()=>recordManualProspectFeedback(f.ctx(),{candidateId,expectedRevision:1,state:'kept',phoneChoice:p.input.selection.choice}))).toMatchObject({ok:true});
 expect(await f.tx(()=>confirmCallingPreparation(f.ctx(),p.input,async()=>true))).toMatchObject({ok:false,reason:'preparation_terminal'});
});
it('expiry denies current read without mutating, then existing maintenance physically erases the source-owned copies',async()=>{
 const p=await f.prepared();
 await f.tx(async()=>{await lockPreparationCleanup(f.ctx());await f.runtime.query("UPDATE sourcing_prospect_phone_discoveries SET expires_at=clock_timestamp()+interval '150 milliseconds' WHERE id=$1",[p.runId]);});
 await expect.poll(async()=>Number((await f.runtime.query('SELECT count(*)::int n FROM calling_preparations WHERE id=$1 AND source_expires_at<=clock_timestamp()',[p.preparationId])).rows[0]?.['n'])).toBe(1);
 expect(await f.tx(()=>readCallingPreparation(f.ctx(),p.input.selection,async()=>true))).toMatchObject({state:'withdrawn'});
 expect((await f.runtime.query('SELECT state FROM calling_preparations WHERE id=$1',[p.preparationId])).rows).toEqual([{state:'live'}]);
 expect(await f.tx(()=>sweepCallingPreparations(f.ctx(),{limit:100}))).toBe(1);
 expect((await f.runtime.query('SELECT e164 FROM phone_routes WHERE id=$1',[p.routeId])).rows).toEqual([{e164:null}]);
});
