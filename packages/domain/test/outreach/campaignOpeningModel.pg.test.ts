import {updateSetting} from '../../settings/store.ts';
import {withTransaction,type SessionQueryable,type QueryResultRowLike} from '../../db/queryable.ts';
import {updateResearchSettings} from '../../research/settings.ts';
import {expect,it,vi} from 'vitest';
import {campaignOpeningPgFixture} from './campaignOpeningPgFixture.ts';
import {readCampaignOpeningAttempt,selectCampaignOpeningBeforeTransaction,readyCampaignOpening} from '../../outreach/campaignOpeningStore.ts';
import {allowAllEligibility} from '../../sequences/eligibility.ts';
import {repositoryContext} from '../../db/workspaceScope.ts';
import type {CampaignOpeningModelPort} from '../../outreach/campaignOpeningModelPort.ts';

// The accepted campaign fixture deliberately disables research to prevent source
// workers running. Positive tests simulate ownerON with inert model/mail ports;
// production and the separate real-model diagnostic remain OFF.
async function modelFixture(ownerOn=true){
 const f=await campaignOpeningPgFixture();
 try{
  expect((await f.tx(()=>updateResearchSettings(f.admin,{enabled:true}))).ok).toBe(true);
  // Simulated ownerON only in a disposable positive-path fixture; the model and
  // all mail providers are controlled. Production and real-model eval stay OFF.
  if(ownerOn)await f.fixture.database.session.query("INSERT INTO workspace_settings(workspace_id,setting_key,version,value,changed_by_user_id) VALUES($1,'sending_enabled',1,$2::jsonb,$3)",[f.w,JSON.stringify({enabled:true,releaseGateReference:'ci-gate:main'}),f.policy.ownerUserId]);
  return f;
 }
 catch(error){await f.stop();throw error;}
}
const model=():CampaignOpeningModelPort=>({providerKey:'aws_bedrock.campaign_opening',countInputTokens:vi.fn(async()=>100),select:vi.fn(async input=>({choice:{variantId:'local',citationIds:[input.citationIds[0]!]},costCents:1,costEstimated:false}))});
it('new model path commits original attempt and conserved cost before selection; provider work is outside transaction and replay never spends again',async()=>{
 const f=await modelFixture();
 try{
  const observer=await f.fixture.database.appRuntimeSession(),port=model();
  port.select=vi.fn(async input=>{
   expect((await observer.query('SELECT state FROM outreach_campaign_opening_attempts WHERE workspace_id=$1 AND execution_id=$2',[f.w,f.executionId])).rows).toEqual([{state:'unknown'}]);
   expect((await observer.query("SELECT state,subject_kind,model_name,max_output_tokens FROM provider_reservations WHERE workspace_id=$1 AND subject_kind='campaign_opening'",[f.w])).rows).toEqual([{state:'calling',subject_kind:'campaign_opening',model_name:'claude-haiku-4-5',max_output_tokens:256}]);
   expect((await f.db.query('SELECT pg_current_xact_id_if_assigned()::text xid')).rows[0]?.['xid']).toBeNull();
   return {choice:{variantId:'local',citationIds:input.citationIds},costCents:1,costEstimated:false};
  });
  await selectCampaignOpeningBeforeTransaction(f.worker,f.db,{executionId:f.executionId,model:port,eligibility:allowAllEligibility()});
  expect(await readyCampaignOpening(f.worker,f.executionId)).toMatchObject({kind:'ready'});
  await selectCampaignOpeningBeforeTransaction(f.worker,f.db,{executionId:f.executionId,model:port,eligibility:allowAllEligibility()});
  expect(port.select).toHaveBeenCalledTimes(1);expect(port.countInputTokens).toHaveBeenCalledTimes(1);
  expect((await f.db.query("SELECT state,settled_cents FROM provider_reservations WHERE workspace_id=$1 AND subject_kind='campaign_opening'",[f.w])).rows).toEqual([{state:'settled',settled_cents:1}]);
  expect((await f.db.query("SELECT cost_cents FROM provider_ledger WHERE workspace_id=$1 AND provider_key='aws_bedrock.campaign_opening'",[f.w])).rows).toEqual([{cost_cents:1}]);
  expect((await f.db.query('SELECT id FROM outbound_messages WHERE workspace_id=$1',[f.w])).rows).toEqual([]);
 }finally{await f.stop();}
});
it('ordinary production eligibility with owner OFF invokes neither model nor token counting and creates no opening/cost/send attempt',async()=>{
 const f=await modelFixture(false);
 try{
  const port=model();await selectCampaignOpeningBeforeTransaction(f.worker,f.db,{executionId:f.executionId,model:port,eligibility:allowAllEligibility()});
  expect(port.countInputTokens).not.toHaveBeenCalled();expect(port.select).not.toHaveBeenCalled();
  expect(await readCampaignOpeningAttempt(f.worker,f.executionId)).toBeNull();
  expect((await f.db.query("SELECT id FROM provider_reservations WHERE workspace_id=$1 AND subject_kind='campaign_opening'",[f.w])).rows).toEqual([]);
  expect((await f.db.query('SELECT id FROM outbound_messages WHERE workspace_id=$1',[f.w])).rows).toEqual([]);
 }finally{await f.stop();}
});
it('ambiguous model result conserves exact UNKNOWN/estimated cost, while concurrent worker and later replay cannot invoke again',async()=>{
 const f=await modelFixture();
 try{
  const observer=await f.fixture.database.appRuntimeSession(),other=repositoryContext(f.worker.scope,observer),port=model();
  let entered!:()=>void,release!:()=>void;
  const reached=new Promise<void>(r=>{entered=r;}),finish=new Promise<void>(r=>{release=r;});
  port.select=vi.fn(async()=>{entered();await finish;throw Error('fictional ambiguous model response');});
  const first=selectCampaignOpeningBeforeTransaction(f.worker,f.db,{executionId:f.executionId,model:port,eligibility:allowAllEligibility()});
  await Promise.race([first,reached]);
  expect(port.select).toHaveBeenCalledTimes(1);
  try{await selectCampaignOpeningBeforeTransaction(other,observer,{executionId:f.executionId,model:port,eligibility:allowAllEligibility()});}finally{release();}
  await first;await selectCampaignOpeningBeforeTransaction(f.worker,f.db,{executionId:f.executionId,model:port,eligibility:allowAllEligibility()});
  expect(port.select).toHaveBeenCalledTimes(1);expect(port.countInputTokens).toHaveBeenCalledTimes(1);
  expect(await readCampaignOpeningAttempt(f.worker,f.executionId)).toMatchObject({state:'unknown',content:null});
  expect((await f.db.query("SELECT state,settled_cents,cents FROM provider_reservations WHERE workspace_id=$1 AND subject_kind='campaign_opening'",[f.w])).rows).toEqual([{state:'estimated',settled_cents:1,cents:1}]);
 }finally{await f.stop();}
});

it('an owner OFF committed during the final combined authority/clock read releases the exact paid claim without model invocation',async()=>{
 const f=await modelFixture();
 try{
  const observer=await f.fixture.database.appRuntimeSession(),admin=repositoryContext(f.admin.scope,observer),port=model();
  let reached=false,enter!:()=>void,resume!:()=>void;
  const paused=new Promise<void>(r=>{enter=r;}),release=new Promise<void>(r=>{resume=r;});
  const wrapped:SessionQueryable={query:async<Row extends QueryResultRowLike>(text:string,values?:readonly unknown[])=>{
   if(text.startsWith('SELECT clock_timestamp() AS at,w.business_time_zone,')){reached=true;enter();await release;}
   return f.db.query<Row>(text,values);
  }};
  const worker=repositoryContext(f.worker.scope,wrapped);
  const running=selectCampaignOpeningBeforeTransaction(worker,wrapped,{executionId:f.executionId,model:port,eligibility:allowAllEligibility()});
  try{
   await Promise.race([running,paused]);expect(reached).toBe(true);
   expect((await observer.query("SELECT state FROM provider_reservations WHERE workspace_id=$1 AND subject_kind='campaign_opening'",[f.w])).rows).toEqual([{state:'calling'}]);
   expect((await withTransaction(observer,()=>updateSetting(admin,{settingKey:'sending_enabled',value:{enabled:false,releaseGateReference:null}}))).ok).toBe(true);
  }finally{resume();await running;}
  expect(port.countInputTokens).toHaveBeenCalledTimes(1);expect(port.select).not.toHaveBeenCalled();
  expect((await observer.query("SELECT state,settled_cents FROM provider_reservations WHERE workspace_id=$1 AND subject_kind='campaign_opening'",[f.w])).rows).toEqual([{state:'released',settled_cents:0}]);
  expect((await observer.query('SELECT id FROM outbound_messages WHERE workspace_id=$1',[f.w])).rows).toEqual([]);
 }finally{await f.stop();}
});
