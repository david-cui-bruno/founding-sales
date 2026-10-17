import {expect,it} from 'vitest';
import {bookingConversationCommandSchema,bookingInterpretationViewSchema} from '@fss/contracts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';
import {captureAt,setupConversation} from './support/bookingConversationFixture.ts';
import {createHash,randomUUID} from 'node:crypto';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {enqueueJob,claimJobs} from '@fss/domain/jobs/jobStore.ts';
import {workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {registerHandlers} from '../../worker/src/bootstrap/main.ts';

const affirmative='Yes, that works.';

// Each case uses real PostgreSQL, authenticated public commands, canonical capture,
// the registered interpreter and standing-create workers. Only external adapters
// and their policy evidence are controlled. No original test suite is imported.
it.each([
 {suffix:'I cannot attend then.',historical:false},
 {suffix:'I cannot attend then.',historical:true},
 {suffix:'I cannot attend then because I will be away.',historical:false},
 {suffix:"I can't make that time.",historical:false},
 {suffix:'That time does not work for me.',historical:false},
 {suffix:'I do not agree to that time.',historical:false},
 {suffix:'Please cancel our call.',historical:false},
])('withholds cropped prior-offer agreement with authored contradiction $suffix (historical=$historical)',async({suffix,historical})=>{
 const f=await setupConversation();
 try{
  const initial=bookingInterpretationViewSchema.parse((await f.request('POST','/crm/booking/interpretation/read',{requestId:bookingConversationCommandSchema.parse(f.admissionCommand).interpretationRequestId})).body);
  if(initial.outcome?.kind!=='slot_proposal')throw new Error('setup: unique prior-offer proposal missing');
  const {handoff:ignored,...supported}=initial.outcome;void ignored;
  const text=`${affirmative} ${suffix}`;
  const {source}=await captureAt(f,text,new Date().toISOString());
  const requested=await f.request('POST','/crm/booking/interpretation/request',f.command({source,priorSources:[f.offer]}));
  expect(requested.status,'setup: authenticated interpretation admission').toBe(200);
  const requestId=bookingInterpretationViewSchema.parse((requested.body as {result:unknown}).result).requestId;
  const agreement={sourceId:source.sourceId,start:0,end:affirmative.length,quote:affirmative};
  f.setCandidate({intent:'accept_slot',agreement,slot:supported.slot,substantive:null});
  await runOnce(f.db,{registry:f.registry,owner:'attendance-contradiction-interpreter',limit:20});
  const interpreted=bookingInterpretationViewSchema.parse((await f.request('POST','/crm/booking/interpretation/read',{requestId})).body);
  expect(interpreted.state,'setup: registered interpreter completed').toBe('complete');
  if(historical){
   // Persist the formerly accepted result against the SAME unchanged canonical
   // source refs/fingerprint. Standing dispatch must independently re-read it.
   await f.db.query('UPDATE crm_booking_interpretations SET outcome=$2::jsonb WHERE workspace_id=$3 AND id=$1',[requestId,JSON.stringify({...supported,agreement}),f.fixture.alpha.workspaceId]);
  }
  const admitted=await f.request('POST','/meetings/booking-conversation',f.command({interpretationRequestId:requestId,expectedPolicyRevision:1}));
  expect(admitted.status,'setup: public conversation admission').toBe(200);
  await runOnce(f.db,{registry:f.registry,owner:'attendance-contradiction-conversation',limit:20});
  await runOnce(f.db,{registry:f.registry,owner:'attendance-contradiction-standing-create',limit:20});
  // This assertion is deliberately after dispatch, so RED demonstrates an actual
  // controlled provider write, not merely an undesirable classification label.
  expect(f.providerCalls,'whole-authored contradiction must veto provider writes').toHaveLength(0);
  expect(interpreted.outcome).toMatchObject({kind:'clarification',permission:false});
 }finally{await f.fixture.stop();}
});

// Controlled parser ranges are supplied at capture, never edited on persisted
// canonical originals. This exercises the same authored-only consumer boundary.
async function captureHistory(f:Awaited<ReturnType<typeof setupConversation>>,text:string,authoredLength:number){
 const key=randomUUID();
 const conversationId=(await f.db.query<{id:string}>('SELECT id FROM crm_business_conversations WHERE workspace_id=$1 AND mailbox_id=$2',[f.fixture.alpha.workspaceId,f.mailbox.id])).rows[0]!.id;
 await enqueueJob(f.db,{workspaceId:f.fixture.alpha.workspaceId,kind:'crm.mail_capture',idempotencyKey:key,payload:{mailboxId:f.mailbox.id,providerMessageId:key,providerAccountId:'controlled-google',generation:1,conversationId,controlsRevision:1,policyRevision:1,decisionRevision:0}});
 const job=(await claimJobs(f.db,{owner:key,kinds:['crm.mail_capture'],limit:1,leaseSeconds:120}))[0]!;
 const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmMailCapture:{proofVerifier:{verify:async proof=>proof.grantReceipt==='fixture-grant'&&proof.accountBinding===f.binding},provider:{read:async()=>({providerAccountId:'controlled-google',messageId:key,threadId:'booking-thread',labels:['INBOX'],origin:'received',providerAt:new Date().toISOString(),rawSenderDate:null,from:'prospect@booking.example',to:['owner@booking.example'],cc:[],subject:'Agreed call',body:text,parserVersion:'controlled-mime-v1',representation:'plain_text',completeness:'complete',ranges:[{start:0,end:authoredLength,kind:'authored'},{start:authoredLength,end:text.length,kind:'quoted'}]})}}});
 const result=await registry.get('crm.mail_capture')!.handle({session:f.db,scope:workspaceScope(f.fixture.alpha.workspaceId,{kind:'system',component:'worker'}),job});
 expect(result).toMatchObject({progress:{outcome:'captured',sourceId:expect.any(String)}});
 const source={sourceId:String(result?.progress['sourceId']),sourceRevision:1,contentHash:createHash('sha256').update(text).digest('hex')};
 expect((await f.request('POST','/crm/business/mail/read',source)).body).toMatchObject({state:'available',source:{passage:text}});
 return source;
}

it.each([
 {mode:'direct slot',contradiction:true,history:false},
 {mode:'direct slot',contradiction:false,history:false},
 {mode:'approved link',contradiction:true,history:false},
 {mode:'prior offer',contradiction:false,history:false},
 {mode:'unrelated negative',contradiction:false,history:false},
 {mode:'negated cancellation',contradiction:false,history:false},
 {mode:'sales disagreement',contradiction:false,history:false},
 {mode:'quoted attendance contradiction',contradiction:false,history:true},
 {mode:'quoted booking negation',contradiction:false,history:true},
 {mode:'approved link',contradiction:false,history:false},
])('checks $mode without granting authority from a lexical match (contradiction=$contradiction)',async({mode,contradiction,history})=>{
 const f=await setupConversation();
 try{
  const initial=bookingInterpretationViewSchema.parse((await f.request('POST','/crm/booking/interpretation/read',{requestId:bookingConversationCommandSchema.parse(f.admissionCommand).interpretationRequestId})).body);
  if(initial.outcome?.kind!=='slot_proposal')throw new Error('setup: prior proposal missing');
  const originalSlot=initial.outcome.slot;
  const direct=mode==='direct slot',interest=mode==='approved link';
  const positive=direct?`Yes, ${originalSlot.localDate} at ${originalSlot.localTime} America/New_York works for me.`:affirmative;
  const text=positive+(contradiction?' I cannot attend then.':mode==='unrelated negative'?' I cannot attend the conference.':mode==='negated cancellation'?' Please do not cancel our call.':mode==='sales disagreement'?' I cannot agree with your pricing.':history?`\n> ${mode==='quoted booking negation'?'Please do not book this call.':'I cannot attend then.'}`:'');
  const source=history?await captureHistory(f,text,positive.length):(await captureAt(f,text,new Date().toISOString())).source;
  const requested=await f.request('POST','/crm/booking/interpretation/request',f.command({source,priorSources:direct||interest?[]:[f.offer]}));
  expect(requested.status,'setup: interpretation admitted').toBe(200);
  const requestId=bookingInterpretationViewSchema.parse((requested.body as {result:unknown}).result).requestId;
  const agreement={sourceId:source.sourceId,start:0,end:positive.length,quote:positive};
  f.setCandidate({intent:interest?'interest':'accept_slot',agreement,slot:interest?null:direct?{...originalSlot,evidence:agreement}:originalSlot,substantive:null});
  await runOnce(f.db,{registry:f.registry,owner:'attendance-controls-interpreter',limit:20});
  const interpreted=bookingInterpretationViewSchema.parse((await f.request('POST','/crm/booking/interpretation/read',{requestId})).body);
  expect(interpreted).toMatchObject({state:'complete',outcome:{kind:contradiction?'clarification':interest?'approved_link':'slot_proposal',permission:false}});
  const admitted=await f.request('POST','/meetings/booking-conversation',f.command({interpretationRequestId:requestId,expectedPolicyRevision:1}));
  expect(admitted.status,'setup: conversation admitted').toBe(200);
  await runOnce(f.db,{registry:f.registry,owner:'attendance-controls-conversation',limit:20});
  await runOnce(f.db,{registry:f.registry,owner:'attendance-controls-create',limit:20});
  expect(f.providerCalls).toHaveLength(contradiction||interest?0:1);
 }finally{await f.fixture.stop();}
});
