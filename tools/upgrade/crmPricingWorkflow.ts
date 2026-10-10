import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {withTransaction,type SessionQueryable} from '@fss/domain/db/queryable.ts';
import type {RepositoryContext} from '@fss/domain/db/workspaceScope.ts';
import {createPerson,addSelectedSource} from '@fss/domain/crm/people.ts';
import {requestAskAnswer,readAskAnswer} from '@fss/domain/crm/askAnswers.ts';
import {readSpend} from '@fss/domain/research/ledger.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {askAnswerJobHandler} from '../../apps/worker/src/handlers/askAnswer.ts';
import {runOnce} from '../../apps/worker/src/runner/jobRunner.ts';

/** Disposable upgraded database only. A real registered handler with a fake
 * provider writes the immutable priced receipt through the normal request seam;
 * this executes the replaced JSON authority validator, not a direct SQL probe. */
export async function runCrmPricingUpgradeWorkflow(context:RepositoryContext & {db:SessionQueryable}):Promise<string>{
 const tx=<T>(run:()=>Promise<T>)=>withTransaction(context.db,run);
 const endpoint=`upgrade-fractional-${randomUUID()}`,text='repairs '.repeat(1250).trim();
 const owner=context.scope.actor;if(owner.kind!=='user')throw new Error('Upgrade pricing requires declared administrator');
 const beforeAt=(await context.db.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0]!.at.toISOString();
 const before=await readSpend(context,{businessTimeZone:'Etc/UTC',at:beforeAt});
 const person=await tx(()=>createPerson(context,'Synthetic fractional pricing original'));assert(person.ok&&person.value.personId!==undefined);
 const personId=person.value.personId;
 const imported=await tx(()=>addSelectedSource(context,{personId,sourceKey:randomUUID(),excerpt:text,occurredAt:'2000-01-01T00:00:00Z'}));assert(imported.ok&&imported.value.sourceId!==undefined);
 const source={workspaceId:context.scope.workspaceId,sourceId:imported.value.sourceId,kind:'selected_note' as const,revision:1,contentHash:createHash('sha256').update(text).digest('hex'),locator:null};
 // Existing controls and all production systems are untouched. Only this disposable
 // fixture creates synthetic authority; cleanup removes precisely that purpose.
 await context.db.query(`INSERT INTO crm_ask_purposes(workspace_id,purpose,revision,enabled,endpoint_id,model_version,access_grant_version,data_handling_version,evaluation_fingerprint,processor_version,retrieval_version,answer_version,support_version,chunker_version,daily_ceiling_cents,monthly_ceiling_cents,input_token_price_micros,output_token_price_micros,approved_by) VALUES($1,'answer',1,true,$2,'literal-fractional-v1','upgrade-fixture-grant','upgrade-fixture-no-retention',$3,'ask-answer-v1','lexical-original-v1','literal-v1','exact-original-v1','lexical-original-v1',100000,1000000,1.1,5.5,$4)`,[context.scope.workspaceId,endpoint,'a'.repeat(64),owner.userId]);
 try{
  const accepted=await tx(()=>requestAskAnswer(context,{commandId:randomUUID(),clientVersion:'1.0.13',question:'repairs',scope:{sources:[source]}}));assert(accepted.ok);assert.equal(accepted.value.state,'pending');
  const registry=new HandlerRegistry();registry.register(askAnswerJobHandler({allowControlledEvaluation:true,verifyPurpose:async proof=>{
   assert.equal(proof.purpose.inputTokenPriceMicros,'1.1');assert.equal(proof.purpose.outputTokenPriceMicros,'5.5');
   return {configFingerprint:proof.configFingerprint,authorizationFingerprint:proof.authorizationFingerprint,validUntil:'2099-01-01T00:00:00Z',evaluationKind:'controlled_fixture'};
  },answer:{endpointId:endpoint,modelVersion:'literal-fractional-v1',providerKey:'fixture.upgrade_pricing',run:async()=>({acceptance:'accepted',usage:{inputTokens:10000,outputTokens:1000},answer:{claims:[],abstained:true}})}}));
  await runOnce(context.db,{registry,owner:'upgrade-fractional-worker',limit:100});
  const answer=await tx(()=>readAskAnswer(context,accepted.value.requestId));assert.equal(answer?.state,'complete');assert.equal(answer.answer?.abstained,true);
  const after=await readSpend(context,{businessTimeZone:'Etc/UTC',at:beforeAt});assert.equal(after.monthToDateCents-before.monthToDateCents,2,'Exact accepted1.1/5.5 rates must settle at2 cents, not rounded3');
  return 'disposable controlled purpose; public request and registered fake worker; immutable canonical decimal receipt admitted; exact accepted10000/1000 usage settled2c; no external call or activation';
 }finally{await context.db.query("DELETE FROM crm_ask_purposes WHERE workspace_id=$1 AND purpose='answer' AND endpoint_id=$2",[context.scope.workspaceId,endpoint]);}
}
