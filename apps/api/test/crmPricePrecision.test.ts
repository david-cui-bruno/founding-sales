import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {crmExtractJobHandler} from '../../worker/src/handlers/crmExtract.ts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';
import {seedFirm} from './support/crmSeed.ts';
import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {dispatch} from '../src/server.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {activateForwardFixture} from './support/crmForwardScopeFixture.ts';

// Approved seams: authenticated commands/reads and registered workers, real
// disposable PostgreSQL, fake external adapters. No private arithmetic seam.
it('roundtrips exact fractional extraction rates without permitting activation',async()=>{
 const f=await createAuthFixture();
 try{
  const token=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:f.db,auth:f.deps,supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false});
  const purpose={expectedRevision:0,enabled:false,endpointId:'fractional-fixture',modelVersion:'fractional-v1',accessGrantVersion:'fixture-grant',dataHandlingVersion:'fixture-handling',dailyCeilingCents:100,monthlyCeilingCents:1000,inputTokenPriceMicros:'1.1',outputTokenPriceMicros:'5.5'};
  const saved=await post('/crm/processing/purpose/save',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,...purpose});
  expect(saved.status).toBe(200);
  expect((await post('/crm/processing/purpose/read',{})).body).toMatchObject({configured:true,enabled:false,revision:1,inputTokenPriceMicros:'1.1',outputTokenPriceMicros:'5.5',unavailableReason:'activation_not_available'});
 }finally{await f.stop();}
});

it('reserves four cents but settles exact accepted fractional extraction usage at two cents',async()=>{
 const f=await createAuthFixture();
 try{
  const forward=await activateForwardFixture(f),{post,command}=forward;
  await forward.extraction({endpointId:'fractional-fixture',modelVersion:'fractional-v1',accessGrantVersion:'fixture-grant',dataHandlingVersion:'fixture-handling',dailyCeilingCents:100,monthlyCeilingCents:1000,inputTokenPriceMicros:'1.1',outputTokenPriceMicros:'5.5'});
  const lookup=await forward.original('x'.repeat(10000));
  expect((await post('/crm/processing/request',command({source:lookup}))).status).toBe(200);
  const firmId=await seedFirm(f,{name:'Public precision spend',assignedUserId:f.alpha.admin.userId});
  let entered!:()=>void,release!:()=>void;
  const ready=new Promise<void>(r=>{entered=r;}),wait=new Promise<void>(r=>{release=r;});
  const registry=new HandlerRegistry();registry.register(crmExtractJobHandler({verifyPurpose:forward.verifiers.verifyExtraction,revalidatePurpose:forward.verifiers.revalidateExtraction,mailEvidence:forward.mailEvidence,adapter:{endpointId:'fractional-fixture',modelVersion:'fractional-v1',accessGrantVersion:'fixture-grant',dataHandlingVersion:'fixture-handling',providerKey:'aws_bedrock.fixture',fundingVerifiedUntil:'2099-01-01T00:00:00Z',run:async()=>{entered();await wait;return {acceptance:'accepted',usage:{inputTokens:10000,outputTokens:1000},claims:[]};}}}));
  const worker=await f.database.appRuntimeSession();
  const running=runOnce(worker,{registry,owner:'fractional-extraction',limit:20});
  try{
   await Promise.race([ready,running.then(()=>{throw new Error('Worker stopped before provider boundary');})]);
   expect((await post('/research/firm',{firmId})).body).toMatchObject({spend:{monthToDateCents:4}});
  }finally{release();await running;}
  expect((await post('/crm/processing/read',{source:lookup})).body).toMatchObject({state:'complete',financial:{dispatchState:'settled',settlementState:'settled',settledCents:2}});
  expect((await post('/research/firm',{firmId})).body).toMatchObject({spend:{monthToDateCents:2}});
 }finally{await f.stop();}
});

it('rejects unrepresentable rates, preserves integer readbacks, and explicitly allows zero output price',async()=>{
 const f=await createAuthFixture();
 try{
  const token=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:f.db,auth:f.deps,supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false});
  const base={expectedRevision:0,enabled:false,endpointId:'precision-fixture',modelVersion:'precision-v1',accessGrantVersion:'fixture-grant',dataHandlingVersion:'fixture-handling',dailyCeilingCents:1,monthlyCeilingCents:1,inputTokenPriceMicros:2,outputTokenPriceMicros:8};
  const save=(patch:Record<string,unknown>)=>post('/crm/processing/purpose/save',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,...base,...patch});
  for(const inputTokenPriceMicros of [0,-1,1.1,'0.0000001','1.1000000','1000000.000001','1e-2','01.1',Number.MAX_SAFE_INTEGER])expect((await save({inputTokenPriceMicros})).status).toBe(400);
  for(const outputTokenPriceMicros of [-1,0.02,'0.0000001','1000001'])expect((await save({outputTokenPriceMicros})).status).toBe(400);
  expect((await save({inputTokenPriceMicros:'2.000000',outputTokenPriceMicros:'8.0'})).status).toBe(200);
  expect((await post('/crm/processing/purpose/read',{})).body).toMatchObject({revision:1,inputTokenPriceMicros:2,outputTokenPriceMicros:8});
  expect((await save({expectedRevision:1,inputTokenPriceMicros:'0.02',outputTokenPriceMicros:0})).status).toBe(200);
  expect((await post('/crm/processing/purpose/read',{})).body).toMatchObject({revision:2,enabled:false,inputTokenPriceMicros:'0.02',outputTokenPriceMicros:0});
 }finally{await f.stop();}
});

async function fractionalExtractionFixture(inputRate:number|string='1.1',outputRate:number|string='5.5',ceiling=100){
 const f=await createAuthFixture();
 const forward=await activateForwardFixture(f),{post,command}=forward;
 await forward.extraction({endpointId:'precision-fixture',modelVersion:'precision-v1',accessGrantVersion:'fixture-grant',dataHandlingVersion:'fixture-handling',dailyCeilingCents:ceiling,monthlyCeilingCents:ceiling,inputTokenPriceMicros:inputRate,outputTokenPriceMicros:outputRate});
 const at=Date.now(),readSource=()=>forward.original('x'.repeat(10000),{messageId:'precision-message',at});
 const source=await readSource();expect((await post('/crm/processing/request',command({source}))).status).toBe(200);
 return {f,post,command,forward,source,readSource};
}

it('settles using immutable fractional prices after current purpose pricing changes',async()=>{
 const {f,post,source,forward}=await fractionalExtractionFixture();
 try{
  const registry=new HandlerRegistry();registry.register(crmExtractJobHandler({verifyPurpose:forward.verifiers.verifyExtraction,revalidatePurpose:forward.verifiers.revalidateExtraction,mailEvidence:forward.mailEvidence,adapter:{endpointId:'precision-fixture',modelVersion:'precision-v1',accessGrantVersion:'fixture-grant',dataHandlingVersion:'fixture-handling',providerKey:'aws_bedrock.fixture',fundingVerifiedUntil:'2099-01-01T00:00:00Z',run:async()=>{
   await f.db.query('UPDATE crm_extraction_purposes SET revision=revision+1,input_token_price_micros=2,output_token_price_micros=6 WHERE workspace_id=$1',[f.alpha.workspaceId]);
   return {acceptance:'accepted',usage:{inputTokens:10000,outputTokens:1000},claims:[]};
  }}}));
  await runOnce(f.db,{registry,owner:'fractional-drift',limit:20});
  expect((await post('/crm/processing/health/read',{sourceId:source.sourceId,kind:source.kind})).body).toMatchObject({generations:[{state:'stale',claims:[],financial:{settlementState:'settled',settledCents:2}}]});
 }finally{await f.stop();}
});

it('conserves the full fractional reservation through unknown acceptance, deletion and recapture without retry',async()=>{
 const {f,post,command,forward,source,readSource}=await fractionalExtractionFixture();
 try{
  let calls=0;
  const registry=new HandlerRegistry();registry.register(crmExtractJobHandler({verifyPurpose:forward.verifiers.verifyExtraction,revalidatePurpose:forward.verifiers.revalidateExtraction,mailEvidence:forward.mailEvidence,adapter:{endpointId:'precision-fixture',modelVersion:'precision-v1',accessGrantVersion:'fixture-grant',dataHandlingVersion:'fixture-handling',providerKey:'aws_bedrock.fixture',fundingVerifiedUntil:'2099-01-01T00:00:00Z',run:async()=>{calls++;return {acceptance:'unknown',usage:{inputTokens:0,outputTokens:0},claims:[]};}}}));
  await runOnce(f.db,{registry,owner:'fractional-unknown',limit:20});
  expect((await post('/crm/processing/read',{source})).body).toMatchObject({state:'unknown_acceptance',financial:{dispatchState:'unknown_acceptance',settlementState:'estimated',settledCents:4}});
  expect((await post('/crm/business/mail/delete',command({sourceId:source.sourceId,expectedRevision:1}))).status).toBe(200);
  expect((await post('/crm/processing/health/read',{sourceId:source.sourceId,kind:source.kind})).body).toMatchObject({availability:'deleted',generations:[{state:'deleted',claims:[],financial:{dispatchState:'unknown_acceptance',settledCents:4}}]});
  expect((await post('/crm/business/mail/restore',command({sourceId:source.sourceId,expectedRevision:2}))).status).toBe(200);
  expect((await post('/crm/business/mail/recapture',command({sourceId:source.sourceId,expectedRevision:3}))).status).toBe(200);
  const recaptured=await readSource();await post('/crm/processing/request',command({source:recaptured}));await runOnce(f.db,{registry,owner:'fractional-no-retry',limit:20});
  expect(calls).toBe(1);
  expect((await post('/crm/processing/read',{source:recaptured})).body).toMatchObject({state:'unknown_acceptance',reason:'prior_acceptance_unknown'});
 }finally{await f.stop();}
});

it('keeps zero output price funded and bounded, and settles sub-micro input without binary rounding',async()=>{
 const {f,post,source,forward}=await fractionalExtractionFixture('0.14',0,100);
 try{
  const registry=new HandlerRegistry();registry.register(crmExtractJobHandler({verifyPurpose:forward.verifiers.verifyExtraction,revalidatePurpose:forward.verifiers.revalidateExtraction,mailEvidence:forward.mailEvidence,adapter:{endpointId:'precision-fixture',modelVersion:'precision-v1',accessGrantVersion:'fixture-grant',dataHandlingVersion:'fixture-handling',providerKey:'aws_bedrock.fixture',fundingVerifiedUntil:'2099-01-01T00:00:00Z',run:async()=>({acceptance:'accepted',usage:{inputTokens:1000000,outputTokens:1000},claims:[]})}}));
  await runOnce(f.db,{registry,owner:'fractional-binary-boundary',limit:20});
  // Known usage is conserved even when it exceeds the reserved token fence.
  expect((await post('/crm/processing/read',{source})).body).toMatchObject({state:'failed',reason:'provider_usage_exceeded',claims:[],financial:{settlementState:'settled',settledCents:14}});
 }finally{await f.stop();}
});

it('does not dispatch a zero-output purpose without adequate reservation headroom',async()=>{
 const {f,post,source,forward}=await fractionalExtractionFixture('1.1',0,1);
 try{
  let calls=0;
  const registry=new HandlerRegistry();registry.register(crmExtractJobHandler({verifyPurpose:forward.verifiers.verifyExtraction,revalidatePurpose:forward.verifiers.revalidateExtraction,mailEvidence:forward.mailEvidence,adapter:{endpointId:'precision-fixture',modelVersion:'precision-v1',accessGrantVersion:'fixture-grant',dataHandlingVersion:'fixture-handling',providerKey:'aws_bedrock.fixture',fundingVerifiedUntil:'2099-01-01T00:00:00Z',run:async()=>{calls++;return {acceptance:'accepted',usage:{inputTokens:0,outputTokens:0},claims:[]};}}}));
  await runOnce(f.db,{registry,owner:'zero-output-budget',limit:20});
  expect(calls).toBe(0);expect((await post('/crm/processing/read',{source})).body).toMatchObject({state:'unavailable',reason:'budget_held'});
 }finally{await f.stop();}
});

it('does not dispatch a zero-output purpose without current funding verification',async()=>{
 const {f,post,source,forward}=await fractionalExtractionFixture('0.02',0);
 try{
  let calls=0;
  const registry=new HandlerRegistry();registry.register(crmExtractJobHandler({verifyPurpose:forward.verifiers.verifyExtraction,revalidatePurpose:forward.verifiers.revalidateExtraction,mailEvidence:forward.mailEvidence,adapter:{endpointId:'precision-fixture',modelVersion:'precision-v1',accessGrantVersion:'fixture-grant',dataHandlingVersion:'fixture-handling',providerKey:'aws_bedrock.fixture',fundingVerifiedUntil:'2000-01-01T00:00:00Z',run:async()=>{calls++;return {acceptance:'accepted',usage:{inputTokens:0,outputTokens:0},claims:[]};}}}));
  await runOnce(f.db,{registry,owner:'zero-output-no-funding',limit:20});
  expect(calls).toBe(0);expect((await post('/crm/processing/read',{source})).body).toMatchObject({state:'unavailable',reason:'purpose_authority_unavailable'});
 }finally{await f.stop();}
});
