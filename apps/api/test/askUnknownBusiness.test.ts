import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { dispatch } from "../src/server.ts";
import {
  createAuthFixture,
  CURRENT_CLIENT_VERSION,
} from "./support/authFixture.ts";
import { issueSessionFor } from "./support/sessionFixture.ts";
import {runOnce} from '../../worker/src/runner/jobRunner.ts';
import { HandlerRegistry } from "@fss/domain/jobs/handlerRegistry.ts";
import { registerHandlers } from "../../worker/src/bootstrap/main.ts";
import { enqueueJob, claimJobs } from "@fss/domain/jobs/jobStore.ts";
import { businessAccountBinding } from "@fss/domain/business/acquisition.ts";
import { workspaceScope } from "@fss/domain/db/workspaceScope.ts";
async function approveCaptureFixture(
  fixture: Awaited<ReturnType<typeof createAuthFixture>>,
  ownerUserId = fixture.alpha.admin.userId,
) {
  const workspaceId = fixture.alpha.workspaceId;
  const mailbox = (
    await fixture.db.query<{
      id: string;
      owner_user_id: string;
      email_address: string;
      provider_account_id: string;
      generation: number;
      status: string;
    }>(
      "INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status) VALUES($1,$2,'business@example.test','google-business','connected') RETURNING *",
      [workspaceId, ownerUserId],
    )
  ).rows[0]!;
  const binding = businessAccountBinding(workspaceId, mailbox)!;
  await fixture.db.query(
    "INSERT INTO crm_business_policies(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,enabled) VALUES($1,$2,$3,'google-business',$4,1,1,false)",
    [workspaceId, mailbox.id, ownerUserId, binding],
  );
  const conversationId = (
    await fixture.db.query<{ id: string }>(
      "INSERT INTO crm_business_conversations(workspace_id,mailbox_id,owner_user_id,account_binding,provider_thread_id,subject,participants,latest_provider_at,category,reason,classifier_version,metadata_hash) VALUES($1,$2,$3,$4,'approved-thread','Business','[]',now(),'business','fixture','fixture',$5) RETURNING id",
      [workspaceId, mailbox.id, ownerUserId, binding, "a".repeat(64)],
    )
  ).rows[0]!.id;
  await fixture.db.query(
    "INSERT INTO crm_mail_capture_controls(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,enabled,policy_revision,disclosure_version,disclosure_sha256,grant_receipt,provider_policy_receipt,evaluation_receipt,release_receipt) VALUES($1,$2,$3,'google-business',$4,1,1,true,1,'full-body-fixture',$5,'fixture-grant','fixture-provider','fixture-evaluation','fixture-release')",
    [workspaceId, mailbox.id, ownerUserId, binding, "b".repeat(64)],
  );
  await enqueueJob(fixture.db, {
    workspaceId,
    kind: "crm.mail_capture",
    idempotencyKey: "approved-fixture",
    payload: {
      mailboxId: mailbox.id,
      providerMessageId: "approved-message",
      providerAccountId: "google-business",
      generation: 1,
      conversationId,
      controlsRevision: 1,
      policyRevision: 1,
      decisionRevision: 0,
    },
  });
  const job = (
    await claimJobs(fixture.db, {
      owner: "capture-fixture",
      kinds: ["crm.mail_capture"],
      limit: 1,
      leaseSeconds: 120,
    })
  )[0]!;
  return { workspaceId, ownerUserId, mailbox, binding, conversationId, job };
}

import type {AskPurposeProofInput} from '@fss/domain/crm/askAnswerPorts.ts';
it.each([false,true])('uses retained unknown-business envelope metadata and fences changed metadata during paid wait=%s',async(changeEnvelopeDuringWait)=>{
 const fixture=await createAuthFixture();try{
  const approved=await approveCaptureFixture(fixture);const text='Drainage coordination is needed.';let gmailReads=0;
  const capture=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmMailCapture:{proofVerifier:{verify:async()=>true},provider:{async read(){gmailReads++;return {providerAccountId:'google-business',messageId:'approved-message',threadId:'approved-thread',labels:['INBOX'],providerAt:'2026-10-08T15:00:00.000Z',rawSenderDate:null,from:'unknown@business.test',to:['business@example.test'],cc:[],subject:'Business',body:text,parserVersion:'fixture-mime-v1',representation:'plain_text' as const,completeness:'complete' as const,ranges:[{start:0,end:text.length,kind:'authored' as const}]};}}}}).get('crm.mail_capture')!;
  const captured=await capture.handle({session:fixture.db,scope:workspaceScope(approved.workspaceId,{kind:'system',component:'worker'}),job:approved.job});expect(captured).toMatchObject({done:true,progress:{outcome:'captured'}});const sourceId=captured!.progress['sourceId'];
  const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken;
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});const command=(body:object)=>({...body,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});
  await fixture.db.query(`INSERT INTO crm_ask_purposes(workspace_id,purpose,revision,enabled,endpoint_id,model_version,access_grant_version,data_handling_version,evaluation_fingerprint,processor_version,retrieval_version,answer_version,support_version,chunker_version,daily_ceiling_cents,monthly_ceiling_cents,input_token_price_micros,output_token_price_micros,approved_by,embedding_dimensions) VALUES($1,'embedding',1,true,'controlled-embedding','embedding-v1','fixture-grant','fixture-handling',$2,'ask-answer-v1','lexical-original-v1','literal-v1','exact-original-v1','lexical-original-v1',1000,10000,1,0,$3,256)`,[fixture.alpha.workspaceId,'a'.repeat(64),fixture.alpha.admin.userId]);
  const composition={allowControlledEvaluation:true,verifyPurpose:async(proof:AskPurposeProofInput)=>({configFingerprint:proof.configFingerprint,authorizationFingerprint:proof.authorizationFingerprint,validUntil:'2099-01-01T00:00:00Z',evaluationKind:'controlled_fixture' as const}),embedding:{endpointId:'controlled-embedding',modelVersion:'embedding-v1',providerKey:'fixture.ask.embedding',dimensions:256 as const,async embed(){return {acceptance:'accepted' as const,usage:{inputTokens:10,outputTokens:0 as const},vector:[1,...Array<number>(255).fill(0)]};}}};
  const indexed=await post('/ask/index/request',command({scope:{kind:'business'},expectedPurposeRevision:1}));expect(indexed.status).toBe(200);const workId=(indexed.body as {result:{workId:string}}).result.workId;
  await runOnce(fixture.db,{registry:registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmAskIndex:composition}),owner:'unknown-copy-index',limit:20});expect((await post('/ask/index/read',{workId})).body).toMatchObject({state:'complete',indexedWindows:1});
  await fixture.db.query(`INSERT INTO crm_ask_purposes(workspace_id,purpose,revision,enabled,endpoint_id,model_version,access_grant_version,data_handling_version,evaluation_fingerprint,processor_version,retrieval_version,answer_version,support_version,chunker_version,daily_ceiling_cents,monthly_ceiling_cents,input_token_price_micros,output_token_price_micros,approved_by) SELECT workspace_id,'answer',revision,enabled,'controlled-answer','literal-v1',access_grant_version,data_handling_version,evaluation_fingerprint,processor_version,retrieval_version,answer_version,support_version,chunker_version,daily_ceiling_cents,monthly_ceiling_cents,input_token_price_micros,output_token_price_micros,approved_by FROM crm_ask_purposes WHERE workspace_id=$1 AND purpose='embedding'`,[fixture.alpha.workspaceId]);
  await fixture.db.query("UPDATE mailboxes SET status='disconnected',disconnected_at=now(),generation=generation+1 WHERE workspace_id=$1 AND id=$2",[fixture.alpha.workspaceId,approved.mailbox.id]);
  const requested=await post('/ask/answers/request',command({question:'Vendor response?',execution:'agent_v1',agentScope:{kind:'business'},scope:{sources:[]}}));const requestId=(requested.body as {result:{requestId:string}}).result.requestId;let steps=0;
  const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmAskAnswers:{...composition,agentLimits:{maxSteps:4,maxInputBytes:100000,maxOutputTokens:1000,deadlineMs:60000},agent:{endpointId:'controlled-answer',modelVersion:'literal-v1',providerKey:'fixture.ask.answer',async runStep(input){steps++;if(steps===1)return {acceptance:'accepted',usage:{inputTokens:20,outputTokens:10},answer:null,toolCalls:[{id:'unknown-business-search',name:'search_history',input:{query:'vendor response',limit:5}}]};if(steps===2)return {acceptance:'accepted',usage:{inputTokens:20,outputTokens:10},answer:null,toolCalls:[{id:'unknown-business-context',name:'read_conversation',input:{sourceId,kind:'mail',limit:3}}]};const transcript=JSON.stringify(input.transcript);expect(transcript).toContain(text);expect(transcript).toContain('"direction":"incoming"');expect(transcript).toContain('"envelope":{"from":"unknown@business.test","to":["business@example.test"],"cc":[]}');expect(transcript).toContain('"kind":"authored"');if(changeEnvelopeDuringWait)await fixture.db.query("UPDATE mail_messages SET header_from='changed@business.test' WHERE workspace_id=$1 AND id=$2",[fixture.alpha.workspaceId,sourceId]);const ids=[...transcript.matchAll(/"id":"([a-f0-9-]{36})"/gu)].map(match=>match[1]!);return {acceptance:'accepted',usage:{inputTokens:20,outputTokens:10},answer:{claims:[{text,kind:'fact',citationWindowIds:[ids.at(-1)!]}],abstained:false},toolCalls:[]};}}}});
  await runOnce(fixture.db,{registry,owner:'unknown-business-ask',limit:20});expect(steps).toBe(3);if(changeEnvelopeDuringWait){expect((await post('/ask/answers/read',{requestId})).body).toMatchObject({state:'stale',answer:null});expect((await fixture.db.query<{dispatch_state:string}>("SELECT dispatch_state FROM crm_ask_financial_receipts WHERE request_id=$1 AND stage='answer' ORDER BY attempt DESC LIMIT 1",[requestId])).rows[0]!.dispatch_state).toBe('settled');}else expect((await post('/ask/answers/read',{requestId})).body).toMatchObject({state:'complete',answer:{retrieval:{method:'hybrid_rrf'},claims:[{text}],missingEvidence:expect.arrayContaining(['identity_unresolved'])}});expect(gmailReads).toBe(1);
 }finally{await fixture.stop();}
});
