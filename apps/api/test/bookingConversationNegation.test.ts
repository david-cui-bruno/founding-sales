import {expect,it} from 'vitest';
import {bookingConversationCommandSchema,bookingInterpretationViewSchema} from '@fss/contracts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';
import {captureAt,setupConversation} from './support/bookingConversationFixture.ts';

it('withholds a historical cropped slot proposal when the current original explicitly says not to book',async()=>{
 const f=await setupConversation();
 try{
  const original=bookingInterpretationViewSchema.parse((await f.request('POST','/crm/booking/interpretation/read',{requestId:bookingConversationCommandSchema.parse(f.admissionCommand).interpretationRequestId})).body);
  if(original.outcome?.kind!=='slot_proposal')throw new Error('positive original proposal missing');
  const {handoff:ignored,...supported}=original.outcome;void ignored;
  const text='Yes, that works. Actually, do not book it.';
  const {source}=await captureAt(f,text,new Date().toISOString());
  const requested=await f.request('POST','/crm/booking/interpretation/request',f.command({source,priorSources:[f.offer]}));
  expect(requested.status).toBe(200);
  const requestId=bookingInterpretationViewSchema.parse((requested.body as {result:unknown}).result).requestId;
  f.setCandidate({intent:'accept_slot',agreement:{sourceId:source.sourceId,start:0,end:15,quote:'Yes, that works.'},slot:supported.slot,substantive:null});
  await runOnce(f.db,{registry:f.registry,owner:'historical-negation-interpretation',limit:20});
  expect((await f.request('POST','/crm/booking/interpretation/read',{requestId})).body).toMatchObject({state:'complete',outcome:{kind:'clarification'}});
  // Explicit historical regression fixture: simulate a previously persisted cropped
  // proposal, without mutating its canonical original, fingerprint or source refs.
  const historical={...supported,agreement:{sourceId:source.sourceId,start:0,end:15,quote:'Yes, that works.'}};
  await f.db.query('UPDATE crm_booking_interpretations SET outcome=$2::jsonb WHERE workspace_id=$3 AND id=$1',[requestId,JSON.stringify(historical),f.fixture.alpha.workspaceId]);
  const admitted=await f.request('POST','/meetings/booking-conversation',f.command({interpretationRequestId:requestId,expectedPolicyRevision:1}));
  expect(admitted.status).toBe(200);
  await runOnce(f.db,{registry:f.registry,owner:'historical-negation-conversation',limit:20});
  await runOnce(f.db,{registry:f.registry,owner:'historical-negation-create',limit:20});
  expect(f.providerCalls).toHaveLength(0);
 }finally{await f.fixture.stop();}
});
