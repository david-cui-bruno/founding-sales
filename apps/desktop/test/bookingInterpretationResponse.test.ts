import {expect,it} from 'vitest';
import {bookingInterpretationReadSchema,bookingInterpretationRequestSchema,bookingInterpretationViewSchema,wireDrift} from '@fss/contracts';
import {createAuthedClient} from '../src/main/authedClient.ts';
import {answerOperation,operationHandlers,type OperationHostDeps} from '../src/main/operationHost.ts';

const ID='11111111-1111-4111-8111-111111111111';
const source={sourceId:ID,sourceRevision:1,contentHash:'a'.repeat(64)};
const context={contextId:ID,personId:null,firmId:null,opportunityId:null,sourceRevision:1,review:'current',operationalMatchId:null,operationalMatchHash:null,identityStatus:'unresolved'};
const provenance={source,priorSources:[source],occurredAt:'2026-10-13T14:00:00.000Z',observedAt:'2026-10-13T14:00:00.000Z',rawSenderDate:'Tue, 13 Oct 2026 10:00:00 -0400',participant:'casey@example.test',originalContexts:[context],reviewedContexts:[context],accountBinding:'a'.repeat(64),generation:1};
const citation={sourceId:ID,start:0,end:3,quote:'Yes'};
const handoff={ownerUserId:ID,action:'answer_sales_question',evidence:citation};
const outcomes=[
 {kind:'approved_link',bookingUrl:'https://cal.com/controlled/demo',schedulingPaused:false,permission:false,handoff},
 {kind:'slot_proposal',slot:{localDate:'2026-10-20',localTime:'14:00',timeZone:'America/New_York',evidence:citation},agreement:citation,attendeeAddress:'casey@example.test',schedulingPaused:false,permission:false,handoff,requires:['current_attendee_route','fresh_freebusy','guarded_create']},
 {kind:'clarification',reason:'booking_candidate_requires_review',permission:false,handoff},
 {kind:'david_handoff',schedulingPaused:true,permission:false,handoff},
 {kind:'stop',reason:'refusal',evidence:citation,permission:false},
];
function informational(value:unknown):unknown {
 if(Array.isArray(value))return value.map(informational);
 if(typeof value!=='object'||value===null)return value;
 return {...Object.fromEntries(Object.entries(value).map(([key,entry])=>[key,informational(entry)])),informational:'new server detail'};
}
for(const outcome of outcomes)it(`normal desktop host/client strips informational ${outcome.kind} success fields on request and read`,async()=>{
 const expected=bookingInterpretationViewSchema.parse({requestId:ID,state:'complete',reason:null,outcome,provenance,financial:{state:'settled',reservedCents:5,settledCents:1},limitations:['candidate_not_permission','no_sending_or_booking']});
 const extended=informational(expected);
 expect(wireDrift(bookingInterpretationViewSchema,expected)).toEqual([]);
 expect(wireDrift(bookingInterpretationViewSchema,extended)).toContain('outcome.informational: not declared by the contract');
 const paths:string[]=[];
 const api=createAuthedClient({baseUrl:'https://api.example.test',clientVersion:'1.4.0',accessToken:async()=>({token:'controlled-session',generation:1}),send:async(url)=>{
  const path=new URL(url).pathname;paths.push(path);
  return {status:200,body:path.endsWith('/request')?{status:'accepted',result:extended,replayed:false}:extended};
 }});
 const handlers=operationHandlers({api,recordings:{identity:{current:()=>1}}} as unknown as OperationHostDeps);
 expect(await answerOperation(handlers,'command','crm.bookingInterpretationRequest',{source,priorSources:[]})).toEqual(expected);
 expect(await answerOperation(handlers,'read','crm.bookingInterpretationRead',{requestId:ID})).toEqual(expected);
 expect(paths).toEqual(['/crm/booking/interpretation/request','/crm/booking/interpretation/read']);
});
it('keeps commands and source references strict and still refuses invalid success types and vocabularies',()=>{
 const request={commandId:ID,clientVersion:'1.4.0',source,priorSources:[]};
 expect(bookingInterpretationRequestSchema.safeParse({...request,informational:'extra'}).success).toBe(false);
 expect(bookingInterpretationRequestSchema.safeParse({...request,source:{...source,informational:'extra'}}).success).toBe(false);
 expect(bookingInterpretationRequestSchema.safeParse({...request,priorSources:[{...source,informational:'extra'}]}).success).toBe(false);
 expect(bookingInterpretationReadSchema.safeParse({requestId:ID,informational:'extra'}).success).toBe(false);
 const view={requestId:ID,state:'complete',reason:null,outcome:outcomes[0],provenance:null,financial:null,limitations:[]};
 expect(bookingInterpretationViewSchema.safeParse({...view,state:'invented'}).success).toBe(false);
 expect(bookingInterpretationViewSchema.safeParse({...view,outcome:{...outcomes[0],permission:true}}).success).toBe(false);
 expect(bookingInterpretationViewSchema.safeParse({...view,requestId:123}).success).toBe(false);
});
