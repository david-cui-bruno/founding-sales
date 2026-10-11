import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {dispatch} from '../src/server.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
it('keeps embedding configuration independently disabled and cannot activate it using a legacy receipt or an owner approval without an embedding adapter',async()=>{
 const fixture=await createAuthFixture();try{
 const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken;
 const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
 expect((await post('/ask/purpose/save',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,expectedRevision:0,purpose:'embedding',enabled:false,endpointId:'controlled-embedding',modelVersion:'fixture-embed-v1',accessGrantVersion:'fixture',dataHandlingVersion:'fixture',evaluationFingerprint:'a'.repeat(64),processorVersion:'ask-agent-v1',retrievalVersion:'ask-hybrid-v1',answerVersion:'ask-agent-v1',supportVersion:'cited-evidence-v1',chunkerVersion:'lexical-original-v1',dailyCeilingCents:10,monthlyCeilingCents:100,inputTokenPriceMicros:1,outputTokenPriceMicros:0})).status).toBe(200);
 const read=await post('/ask/purpose/read',{capability:'ask_answer',purpose:'embedding'});
 expect(read.status).toBe(200);expect(read.body).toMatchObject({enabled:false,ready:false,configuration:{purpose:'embedding',modelVersion:'fixture-embed-v1'}});
 const activate=await post('/ask/purpose/activate',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,capability:'ask_answer',purpose:'embedding',expectedRevision:1,authorityReceiptId:randomUUID()});
 expect(activate.status).toBe(400);
 const approval={consentAcknowledged:true,qualityTier:'provisional_owner',criticalControlsPassed:true,modelIntegrationVerified:true,reviewedEvaluationReference:'synthetic-embedding-review-v1',limitations:['representative_quality_unverified','vector_quality_unverified']};
 const approved=await post('/ask/purpose/activate',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,capability:'ask_answer',purpose:'embedding',expectedRevision:1,approval});
 expect(approved.status).toBe(409);expect(approved.body).toMatchObject({reason:'owner_consent_unavailable'});
 expect((await post('/ask/purpose/read',{capability:'ask_answer',purpose:'embedding'})).body).toMatchObject({enabled:false,revision:1});
 }finally{await fixture.stop();}
});
