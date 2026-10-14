import {bookingConversationInputSchema} from '@fss/contracts';
import {expect,it} from 'vitest';
import {createAuthedClient} from '../src/main/authedClient.ts';
import {answerOperation,operationHandlers,type OperationHostDeps} from '../src/main/operationHost.ts';
import {OPERATIONS,type OperationName} from '../src/shared/operations.ts';
const ID='11111111-1111-4111-8111-111111111111';
const conversation={conversationId:ID,interpretationRequestId:ID,policyRevision:3,origin:'standing_policy',enabled:false,state:'unknown',reason:'unknown_acceptance',outcome:null,handoff:null,booking:{submissionId:ID,state:'unknown',providerBookingUid:null,meetingId:null,sourceState:'current',reason:'inspect',dispatchStartedAt:null},change:null,nudgeCount:0,nudgesStoppedAt:null,lastReplyAt:null,explicitNoShowAt:null,noShowRebookingUsed:false,limitations:[]};
const message={messageId:ID,conversationId:ID,kind:'approved_link',state:'unknown_terminal',reason:'unknown_acceptance',outboundMessageId:null,providerMessageId:null,sentAt:null,limitations:[]};
it('uses the canonical metadata-free request schema and refuses unpaired target hints',()=>{
 const schema=OPERATIONS['meetings.bookingConversationRequest'].input;
 expect(schema).toBe(bookingConversationInputSchema);
 expect(schema.safeParse({interpretationRequestId:ID,expectedPolicyRevision:3,meetingId:ID}).success).toBe(false);
 expect(schema.safeParse({interpretationRequestId:ID,expectedPolicyRevision:3,expectedBookingUid:'current'}).success).toBe(false);
 expect(schema.safeParse({interpretationRequestId:ID,expectedPolicyRevision:3,meetingId:ID,expectedBookingUid:'current'}).success).toBe(true);
});
const cases:[OperationName,unknown,string][]=[
 ['meetings.bookingConversationRequest',{interpretationRequestId:ID,expectedPolicyRevision:3},'/meetings/booking-conversation'],
 ['meetings.bookingConversationRead',{conversationId:ID},`/meetings/booking-conversation?conversationId=${ID}`],
 ['meetings.bookingConversationEvent',{conversationId:ID,expectedPolicyRevision:3,event:'reply'},'/meetings/booking-conversation/event'],
 ['meetings.bookingMessageRequest',{conversationId:ID,kind:'approved_link'},'/meetings/booking-messages'],
 ['meetings.bookingMessageRead',{messageId:ID},`/meetings/booking-messages?messageId=${ID}`],
];
for(const [name,input,path] of cases){
 it(`${name} uses exact authenticated path, envelope and validated readback`,async()=>{
  const calls:{url:string;method:string;body:unknown}[]=[];
  const expected=name.includes('Message')?message:conversation;
  const kind=OPERATIONS[name].kind;
  const api=createAuthedClient({baseUrl:'https://api.example.test',clientVersion:'1.0.49',accessToken:async()=>({token:'fixture',generation:0}),send:async(url,init)=>{calls.push({url,method:init.method,body:init.body?JSON.parse(init.body):null});return {status:200,body:kind==='command'?{status:'accepted',replayed:false,result:expected}:expected};}});
  const handlers=operationHandlers({api,recordings:{identity:{current:()=>0}}} as unknown as OperationHostDeps);
  expect(await answerOperation(handlers,kind,name,input)).toEqual(expected);
  expect(calls[0]?.url).toBe(`https://api.example.test${path}`);expect(calls[0]?.method).toBe(kind==='command'?'POST':'GET');
  if(kind==='command')expect(calls[0]?.body).toMatchObject({...input as object,clientVersion:'1.0.49',commandId:expect.any(String)});else expect(calls[0]?.body).toBeNull();
 });
 it(`${name} rejects private replies after a session changes while awaiting transport`,async()=>{
  let generation=0;const kind=OPERATIONS[name].kind,expected=name.includes('Message')?message:conversation;
  const api=createAuthedClient({baseUrl:'https://api.example.test',clientVersion:'1.0.49',accessToken:async()=>({token:'fixture',generation:0}),send:async()=>{generation++;return {status:200,body:kind==='command'?{status:'accepted',replayed:false,result:expected}:expected};}});
  await expect(answerOperation(operationHandlers({api,recordings:{identity:{current:()=>generation}}} as unknown as OperationHostDeps),kind,name,input)).rejects.toThrow('session_changed');
 });
 it(`${name} rejects malformed server authority and extra caller authority`,async()=>{
  const kind=OPERATIONS[name].kind,expected=name.includes('Message')?message:conversation;
  const api=createAuthedClient({baseUrl:'https://api.example.test',clientVersion:'1.0.49',accessToken:async()=>({token:'fixture',generation:0}),send:async()=>({status:200,body:kind==='command'?{status:'accepted',replayed:false,result:{...expected,enabled:true}}:{...expected,enabled:true}})});
  const handlers=operationHandlers({api,recordings:{identity:{current:()=>0}}} as unknown as OperationHostDeps);
  await expect(answerOperation(handlers,kind,name,input)).rejects.toThrow();
  await expect(answerOperation(handlers,kind,name,{...input as object,confirmation:'owner_confirmed_unconditional_exact_slot'})).rejects.toThrow();
 });
}
