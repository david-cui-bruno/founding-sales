import {createHash} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import type {ManualPhoneChoice} from '@fss/contracts';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {saveCandidate} from '../../sourcing/candidates.ts';
import {requestProspectPhoneDiscovery,runProspectPhoneDiscovery} from '../../sourcing/prospectPhoneDiscovery.ts';
import {listManualProspects,recordManualProspectFeedback,currentManualPhoneChoiceAuthority,ManualPhoneChoiceChanged} from '../../sourcing/manualProspects.ts';
import {rememberExpiredManualSources} from '../../sourcing/manualProspectSourceLoss.ts';
import {manualOrdinaryFixture} from './support/manualProspectFixture.ts';
import type {PhoneDiscoveryRun} from '../../sourcing/prospectPhoneDiscoveryStore.ts';
let db:TestDatabase,seed:TwoWorkspaces,runtime:SessionQueryable,serial=0;
const ctx=(side:'alpha'|'beta'='alpha')=>repositoryContext(workspaceScope(seed[side].workspaceId,{kind:'user',userId:seed[side].admin.userId,role:'admin'}),runtime);
beforeAll(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);runtime=await db.appRuntimeSession();});
beforeEach(async()=>{await db.session.query('DELETE FROM sourcing_candidates');await db.session.query('DELETE FROM jobs');});
afterAll(async()=>{await db.drop();});
async function source(text='Call us today at 940.262.0091 or enter your address below.'){
 const input=manualOrdinaryFixture(++serial);input.sourceUrl=input.website+'about';
 const saved=await withTransaction(runtime,()=>saveCandidate(ctx(),input));if(!saved.ok)throw Error(saved.reason);
 const requested=await withTransaction(runtime,()=>requestProspectPhoneDiscovery(ctx(),{candidateId:saved.value.id,expectedRevision:1}));if(!requested.ok)throw Error(requested.reason);
 const worker=repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'system',component:'worker'}),runtime),body=new TextEncoder().encode(`<p>${text}</p>`);
 await runProspectPhoneDiscovery(worker,{runId:requested.value.runId},{pageFetch:{providerKey:'fictional-kept818-no-network',fetchPages:async()=>({ok:true,value:{pages:[{url:input.website+'contact',body,contentType:'text/html',contentHash:createHash('sha256').update(body).digest('hex'),retrievedAt:new Date().toISOString(),firstParty:true}],skipped:{}},costCents:0})}});
 const run=(await runtime.query<PhoneDiscoveryRun>('SELECT * FROM sourcing_prospect_phone_discoveries WHERE id=$1',[requested.value.runId])).rows[0]!;
 expect(run.state).toBe('complete');const observation=run.content!.observations[0]!,block=observation.blocks[0]!,literal='940.262.0091',start=block.text.indexOf(literal);
 const choice:ManualPhoneChoice={runId:run.id,observationId:observation.id,blockId:block.id,labelStart:0,labelEnd:7,start,end:start+literal.length,contentHash:observation.contentHash,relevantTextHash:observation.relevantTextHash};
 return {id:saved.value.id,choice,input};
}
const save=(id:string,phoneChoice?:ManualPhoneChoice|null,state:'kept'|'skipped'|'wrong_number'='kept')=>withTransaction(runtime,()=>recordManualProspectFeedback(ctx(),{candidateId:id,expectedRevision:1,state,...(phoneChoice===undefined?{}:{phoneChoice})}));
const list=(id:string,opt=true)=>withTransaction(runtime,()=>listManualProspects(ctx(),{state:'all',offset:0,candidateId:id,expectedRevision:1,...(opt?{includeManualPhone:true}:{})}));
it('saves only source metadata, opts into current enrichment and leaves legacy shapes/canonical effects untouched',async()=>{
 const c=await source();expect(await save(c.id,c.choice)).toEqual({ok:true,value:{candidateId:c.id,revision:1,state:'kept',phoneChoice:c.choice}});
 const selected=await list(c.id);expect(selected).toMatchObject({ok:true,value:{prospects:[{candidateId:c.id,state:'kept',manualPhone:{value:'+19402620091',choice:c.choice},observedPhone:null,phoneBasis:'unknown',qualification:'unverified',contactAuthority:'not_granted'}]}});
 const legacy=await list(c.id,false);if(!legacy.ok)throw Error(legacy.reason);expect(legacy.value.prospects[0]).not.toHaveProperty('manualPhone');
 expect(await save(c.id)).toEqual({ok:true,value:{candidateId:c.id,revision:1,state:'kept'}});
 expect(JSON.stringify((await runtime.query('SELECT manual_phone_choice FROM sourcing_manual_prospect_states WHERE candidate_id=$1',[c.id])).rows)).not.toContain('940');
 for(const table of ['firms','phone_routes','call_sessions','calling_follow_up_drafts','provider_reservations','outbound_messages'])expect((await runtime.query(`SELECT count(*)::int n FROM ${table}`)).rows[0]?.['n']).toBe(0);
});
it.each(['skipped','wrong_number','clear'] as const)('%s clears the annotation and legacy rekeep cannot revive it',async state=>{
 const c=await source();expect((await save(c.id,c.choice)).ok).toBe(true);
 expect((await save(c.id,state==='clear'?null:undefined,state==='clear'?'kept':state)).ok).toBe(true);expect((await save(c.id)).ok).toBe(true);
 const read=await list(c.id);if(!read.ok)throw Error(read.reason);expect(read.value.prospects[0]).not.toHaveProperty('manualPhone');
});
it.each(['hash','span','foreign','revision'] as const)('refuses stale/invalid %s choices without changing state',async kind=>{
 const c=await source(),choice={...c.choice,...(kind==='hash'?{contentHash:'b'.repeat(64)}:kind==='span'?{start:c.choice.start+1}:kind==='foreign'?{runId:c.id}:{})};
 const answer=await withTransaction(runtime,()=>recordManualProspectFeedback(ctx(),{candidateId:c.id,expectedRevision:kind==='revision'?2:1,state:'kept',phoneChoice:choice}));
 expect(answer).toEqual({ok:false,reason:kind==='revision'?'candidate_changed':'phone_source_changed'});
 expect((await runtime.query('SELECT 1 FROM sourcing_manual_prospect_states WHERE candidate_id=$1',[c.id])).rowCount).toBe(0);
 expect(await withTransaction(runtime,()=>recordManualProspectFeedback(ctx('beta'),{candidateId:c.id,expectedRevision:1,state:'kept',phoneChoice:c.choice}))).toEqual({ok:false,reason:'candidate_unavailable'});
});
it.each(['expiry','source'] as const)('current %s loss removes displayed number and refuses an old selection',async kind=>{
 const c=await source();expect((await save(c.id,c.choice)).ok).toBe(true);
 if(kind==='expiry'){await runtime.query("UPDATE sourcing_prospect_phone_discoveries SET expires_at=clock_timestamp()+interval '100 milliseconds' WHERE id=$1",[c.choice.runId]);await new Promise(resolve=>setTimeout(resolve,150));}
 else await withTransaction(runtime,()=>rememberExpiredManualSources(ctx(),[c.input.website+'contact']));
 const read=await list(c.id);if(!read.ok)throw Error(read.reason);expect(read.value.prospects[0]).not.toHaveProperty('manualPhone');
 expect(await save(c.id,c.choice)).toEqual({ok:false,reason:'phone_source_changed'});
});
it('rechecks principal authority after the selected source read before saving',async()=>{
 const c=await source();let checks=0;
 expect(await withTransaction(runtime,()=>recordManualProspectFeedback(ctx(),{candidateId:c.id,expectedRevision:1,state:'kept',phoneChoice:c.choice},async()=>++checks<3))).toEqual({ok:false,reason:'authority_changed'});
 expect((await runtime.query('SELECT 1 FROM sourcing_manual_prospect_states WHERE candidate_id=$1',[c.id])).rowCount).toBe(0);
});
it.each([false,true])('final precommit fence checks exact source after a wait, expired=%s',async expired=>{
 const c=await source();
 const transaction=withTransaction(runtime,async()=>{
  const input={candidateId:c.id,expectedRevision:1,phoneChoice:c.choice};
  expect((await recordManualProspectFeedback(ctx(),{...input,state:'kept'})).ok).toBe(true);
  if(expired){await runtime.query("UPDATE sourcing_prospect_phone_discoveries SET expires_at=clock_timestamp()+interval '100 milliseconds' WHERE id=$1",[c.choice.runId]);await new Promise(resolve=>setTimeout(resolve,150));}
  await currentManualPhoneChoiceAuthority(ctx(),input,async()=>true);
 });
 if(expired){await expect(transaction).rejects.toBeInstanceOf(ManualPhoneChoiceChanged);expect((await runtime.query('SELECT 1 FROM sourcing_manual_prospect_states WHERE candidate_id=$1',[c.id])).rowCount).toBe(0);}
 else{await transaction;expect(await list(c.id)).toMatchObject({ok:true,value:{prospects:[{manualPhone:{value:'+19402620091'}}]}});}
});
