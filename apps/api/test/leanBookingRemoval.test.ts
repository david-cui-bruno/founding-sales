import {afterAll,beforeAll,expect,it} from 'vitest';
import {createAuthFixture,type AuthFixture} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {startIntegrationServer,type IntegrationServer} from './support/integrationServer.ts';
import {bookingCapacityResponseSchema} from '@fss/contracts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {decideSend} from '@fss/domain/outbound/gate.ts';
import type {OutboundFenceRow} from '@fss/domain/outbound/fence.ts';
import {registerHandlers} from '../../worker/src/bootstrap/main.ts';

let fixture:AuthFixture,server:IntegrationServer,token:string;
beforeAll(async()=>{
  fixture=await createAuthFixture();
  token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken;
  server=await startIntegrationServer(fixture);
});
afterAll(async()=>{await server?.close();await fixture?.stop();});

it('does not expose retired booking commands, reads or policy through the real API',async()=>{
  for(const path of ['/crm/booking/interpretation/request','/crm/booking/interpretation/read','/meetings/booking-policy','/meetings/booking-create','/meetings/booking-create/inspect','/meetings/booking-change','/meetings/booking-change/inspect','/meetings/booking-conversation','/meetings/booking-conversation/event','/meetings/booking-messages']){
    for(const method of ['GET','POST']){
      const response=await fetch(`${server.origin}${path}`,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(method==='POST'?{body:'{}'}:{})});
      expect(response.status,`${method} ${path}`).toBe(404);
    }
  }
});

it('keeps the installed 1.0.51 capacity read and ordinary meeting reads compatible',async()=>{
  const response=await fetch(`${server.origin}/meetings/booking-capacity`,{headers:{authorization:`Bearer ${token}`}});
  expect(response.status).toBe(200);
  expect(bookingCapacityResponseSchema.parse(await response.json())).toMatchObject({preference:{weeklyIntroCalls:3,enforcementVerified:false},provider:{status:'unavailable'},recorded:{bookings:[]}});
  const unmatched=await fetch(`${server.origin}/meetings/unmatched`,{headers:{authorization:`Bearer ${token}`}});
  expect(unmatched.status).toBe(200);
});

it('registers existing Cal.com sync but no booking automation even with a Cal.com client',()=>{
  const registry=registerHandlers(new HandlerRegistry(),{
    classifier:undefined,mail:undefined,send:undefined,research:undefined,
    calcom:{client:{async listBookings(){throw new Error('must_not_read_provider');}}},
  });
  expect(registry.get('calcom.reconcile')).toBeDefined();
  for(const kind of ['meeting.booking_create','meeting.booking_change','meeting.booking_conversation','booking.message_send','crm.booking_interpretation'] as const)expect(registry.get(kind)).toBeUndefined();
  expect(registry.get('sequence.action')).toBeDefined();
  expect(registry.get('reply.human_send')).toBeDefined();
});

it('never treats a retained standing-booking fence as sequence or human approval',async()=>{
  const id='11111111-1111-4111-8111-111111111111';
  const fence:OutboundFenceRow={
    id,mailboxId:id,state:'prepared',originKind:'standing_booking',enrollmentId:null,stepExecutionId:null,draftId:id,
    firmId:id,contactId:null,opportunityId:null,recipientAddress:'controlled@example.test',recipientRouteId:null,recipientRouteVersion:null,
    subject:'Retained booking',body:'Historical bytes',templateVersionId:null,renderedHash:'a'.repeat(64),providerMessageIdHeader:'<retained@example.test>',
    sendAt:'2026-10-18T00:00:00Z',sourceZone:'America/New_York',attemptToken:null,dispatchStartedAt:null,sentAt:null,
    providerMessageId:null,providerThreadId:null,reconcileDeadlineAt:null,reconcileAttempts:0,heldReason:null,unknownTerminalAt:null,adminResolution:null,businessDate:null,
  };
  const result=await decideSend({db:fixture.db,scope:workspaceScope(fixture.alpha.workspaceId,{kind:'system',component:'worker'})},fence,{now:()=>{throw new Error('must_refuse_before_readiness');}});
  expect(result).toMatchObject({ok:false,reason:'step_ineligible',detail:'booking_automation_removed'});
});
