import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {expect,it} from 'vitest';
import {z} from 'zod';
import {crmResolvedSourceSchema,personPageSchema} from '@fss/contracts';
import {dispatch} from '../src/server.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {pilotHash,realPilotManifestSchema,runRealPilot,type PilotPorts} from '../../../tools/ask-evaluation/realPilot.ts';
import {createRealPilotSqlRanker} from '../../../tools/ask-evaluation/realPilotSql.ts';
import {createTitanPilotTransport} from '../../../tools/ask-evaluation/titanTransport.ts';
import {createPilotAnswerTransport} from '../../../tools/ask-evaluation/pilotAnswerTransport.ts';
import {createBedrockAskAnswerAdapter} from '../../worker/src/providers/crmBedrock.ts';
const text='Dana promised a demo tomorrow.';
const PERSON=z.object({result:z.object({personId:z.uuid()})});
const SOURCE=z.object({result:z.object({sourceId:z.uuid()})});
async function publicPilot(deletion:boolean){
 const fixture=await createAuthFixture();const directory=await mkdtemp(join(tmpdir(),'callie-public-pilot-'));const ledger=join(directory,'ledger.json');
 try{
  const actor=fixture.alpha.salesperson.userId;const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.salesperson)).accessToken;
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
  const command=(body:Record<string,unknown>)=>({...body,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});
  const personId=PERSON.parse((await post('/crm/people/create',command({fullName:'Pilot synthetic Dana'}))).body).result.personId;
  const sourceId=SOURCE.parse((await post('/crm/people/source/add',command({personId,sourceKey:'independently labeled synthetic business note',excerpt:text,occurredAt:'2026-10-01T14:00:00Z'}))).body).result.sourceId;
  const page=personPageSchema.parse((await post('/crm/people/read',{personId})).body);const original=page.sources.find(row=>row.sourceId===sourceId);if(!original)throw new Error('selected fixture missing');
  const lookup={workspaceId:original.workspaceId,sourceId:original.sourceId,kind:original.kind,revision:original.revision,contentHash:original.contentHash,locator:`text:0:${text.length}`};
  const resolved=crmResolvedSourceSchema.parse((await post('/crm/processing/source/read',lookup)).body);
  const timestamp=new Date().toISOString();
  const manifest=realPilotManifestSchema.parse({version:'real-diagnostic-v1',mode:'controlled_transport',chunkerVersion:'lexical-original-v1',dedupUnit:'trim_whitespace_lowercase_en_us_text_group',actorId:actor,windows:[{id:'w1',source:resolved.source,textSha256:pilotHash(text)}],questions:[{id:'q1',text:'demo',relevantWindowIds:['w1'],acceptableClaims:[{text,supportedBy:['w1']}],mustAbstain:false}],labelState:'independent_before_outputs',labelAuthor:'preregistered test case',labelsFrozenAt:timestamp,embedding:{modelId:'amazon.titan-embed-text-v2:0',dimensions:256,inputRate:'0.02',outputRate:0,maxInputTokens:8000,maxOutputTokens:0,priceVerifiedAt:timestamp},answer:{modelId:'us.anthropic.claude-haiku-4-5-20251001-v1:0',inputRate:'1',outputRate:'5',maxInputTokens:8000,maxOutputTokens:512,priceVerifiedAt:timestamp},limits:{maxSources:4,maxWindows:12,maxQuestions:3,maxAttempts:25,budgetCents:100},activationAllowed:false});
  let calls=0;
  const answer=createPilotAnswerTransport(createBedrockAskAnswerAdapter({endpointId:'controlled-sdk-surface',providerKey:'controlled-fixture',modelVersion:manifest.answer.modelId,surface:{async converse(){calls++;if(deletion){const removed=await post('/crm/people/source/delete',command({personId,sourceId,expectedRevision:1}));expect(removed.status).toBe(200);}return {stopReason:'end_turn',usage:{inputTokens:50,outputTokens:20},output:{message:{role:'assistant',content:[{text:JSON.stringify({claims:[{text,kind:'extractive',citationWindowIds:['w1']}],abstained:false})}]}}};}}}), 'controlled');
  const ports:PilotPorts={now:()=>new Date(),verifyAuthority:async(_hash,mode)=>mode==='controlled_transport',readSource:async(suppliedActor,body)=>{expect(suppliedActor).toBe(actor);return post('/crm/processing/source/read',body);},readAsk:async(suppliedActor,body)=>{expect(suppliedActor).toBe(actor);return post('/ask/read',body);},embedding:createTitanPilotTransport({kind:'controlled',invoke:async()=>({body:new Uint8Array(Buffer.from(JSON.stringify({embedding:Array.from({length:256},(_,index)=>index===0?1:0),inputTextTokenCount:10})))})},256),answer,rank:createRealPilotSqlRanker(fixture.db)};
  const report=await runRealPilot(manifest,ledger,ports);
  expect(calls).toBe(1);expect(report.activationAllowed).toBe(false);expect(report.realVectorMeasured).toBe(false);expect(report.realModelMeasured).toBe(false);expect((await post('/crm/processing/purpose/read',{})).body).toMatchObject({configured:false,enabled:false});
  expect(await readFile(ledger,'utf8')).not.toContain(text);
  if(deletion){expect(report.state).toBe('refused');expect(report.reason).toBe('canonical_source_changed_or_unavailable');expect(report.results).toEqual([]);expect(report.conservedCents).toBe(0);expect(report.spentCents).toBe(3);expect((await post('/crm/processing/source/read',lookup)).status).toBe(404);}
  else{expect(report.state).toBe('complete');expect(report.results[0]).toMatchObject({supportedClaims:1,unsupportedClaims:0,invalidCitations:0,rankings:[{path:'lexical',recallAt10:1},{path:'controlled_exact_sql_vector',recallAt10:1},{path:'controlled_rrf_hybrid',recallAt10:1}]});}
 }finally{await fixture.stop();await rm(directory,{recursive:true,force:true});}
}
it('composes authenticated canonical and Ask reads, real PostgreSQL ranking and controlled SDK transports without activation',async()=>publicPilot(false));
it('honors public source deletion during external answer dispatch and settles billed work without releasing a result',async()=>publicPilot(true));
