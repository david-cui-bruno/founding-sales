import {describe,expect,it} from 'vitest';
import {callingExecutionReceiptInputSchema,callingExecutionReceiptSchema} from '../src/callingExecution.ts';
import {callingWrapCommandSchema} from '../src/calling.ts';
const id='b385612c-cac8-43a3-a72d-fc2dd7d8553d';
const envelope={commandId:id,clientVersion:'1.0.0'};
describe('receipt-only browser call execution contract',()=>{
 it('requires exact canonical subject and opaque command identity, no replay payload',()=>{
  const input={firmId:id,commandId:id,payloadSHA256:'a'.repeat(64)};
  expect(callingExecutionReceiptInputSchema.parse(input)).toEqual(input);
  for(const extra of [{candidateId:id},{token:'private'},{routeId:id},{retry:true},{payloadSHA256:'invalid'}])
   expect(callingExecutionReceiptInputSchema.safeParse({...input,...extra}).success).toBe(false);
 });
 it('never returns reconnect authority or private routing data',()=>{
  const receipt={state:'accepted',firmId:id,sessionId:id,expiresAt:'2026-10-26T10:30:00.000Z',status:'authorized',canReconnect:false};
  expect(callingExecutionReceiptSchema.parse(receipt)).toEqual(receipt);
  for(const extra of [{canReconnect:true},{token:'private'},{phone:'+12025550100'},{status:'settled'}])
   expect(callingExecutionReceiptSchema.safeParse({...receipt,...extra}).success).toBe(false);
  for(const status of ['expired_unconsumed','unavailable','completed','failed','canceled'])
   expect(callingExecutionReceiptSchema.safeParse({...receipt,status}).success).toBe(true);
  expect(callingExecutionReceiptSchema.parse({state:'unknown'})).toEqual({state:'unknown'});
 });
 it('permits exact session linkage only on explicit canonical reports',()=>{
  expect(callingWrapCommandSchema.safeParse({...envelope,kind:'firm',firmId:id,
   report:{performedByUser:true,outcome:'interested',callSessionId:id}}).success).toBe(true);
  expect(callingWrapCommandSchema.safeParse({...envelope,kind:'candidate',candidateId:id,expectedCandidateRevision:1,attemptId:id,
   report:{performedByUser:true,channel:'manual_phone',occurrence:{kind:'unknown'},result:'conversation',note:null,callback:null,callSessionId:id}}).success).toBe(false);
 });
});
