import { expect, it, vi } from 'vitest';
import { createAuthedClient, type AccessSession } from '../src/main/authedClient.ts';
import { crmCaptureReadRecoveryHandlers } from '../src/main/crmCaptureReadRecoveryHandlers.ts';
import { OPERATIONS } from '../src/shared/operations.ts';
const id='11111111-1111-4111-8111-111111111111';
const payload={mailboxId:id,expectedGeneration:1,incidentId:id,expectedRecoveryBinding:'a'.repeat(64),commandId:id};
const status={mailboxId:id,generation:1,eligible:true,incidentId:id,recoveryBinding:'a'.repeat(64),reason:null,attempt:null,sendingUnchanged:true,holdsUnchanged:true,providerCoverage:'unproven'};
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
for(const operation of ['crm.captureReadRecoveryRead','crm.captureReadRecoveryRequest'] as const){
 it(`${operation} fences an actual AuthedClient token renewal before any HTTP dispatch`,async()=>{
  let generation=1;const token=deferred<AccessSession|null>(),send=vi.fn();
  const api=createAuthedClient({baseUrl:'https://example.test',clientVersion:'1.0.0',accessToken:()=>token.promise,send});
  const handlers=crmCaptureReadRecoveryHandlers({api,generation:()=>generation});
  const pending=operation==='crm.captureReadRecoveryRead'?handlers[operation]({mailboxId:id}):handlers[operation](payload);
  generation++;token.resolve({token:'synthetic-only',generation:2});
  await expect(pending).rejects.toThrow('identity_changed');expect(send).not.toHaveBeenCalled();
 });
 it(`${operation} suppresses late actual transport results and auth side effects after identity change`,async()=>{
  let generation=1;const answer=deferred<{status:number;body:unknown}>(),started=deferred<void>(),connection=vi.fn(),authRefusal=vi.fn();
  const api=createAuthedClient({baseUrl:'https://example.test',clientVersion:'1.0.0',accessToken:async()=>({token:'synthetic-only',generation:1}),send:async()=>{started.resolve();return answer.promise;},onConnection:connection,onAuthRefusal:authRefusal});
  const handlers=crmCaptureReadRecoveryHandlers({api,generation:()=>generation});
  const pending=operation==='crm.captureReadRecoveryRead'?handlers[operation]({mailboxId:id}):handlers[operation](payload);
  await started.promise;generation++;answer.resolve({status:403,body:{reason:'device_revoked'}});
  await expect(pending).rejects.toThrow('identity_changed');expect(connection).not.toHaveBeenCalled();expect(authRefusal).not.toHaveBeenCalled();
 });
}
it('actual command transport preserves one renderer command ID and sends only strict frozen fields',async()=>{
 const seen:unknown[]=[];const api=createAuthedClient({baseUrl:'https://example.test',clientVersion:'1.0.0',accessToken:async()=>({token:'synthetic-only',generation:1}),send:async(url,init)=>{seen.push({url,method:init.method,body:JSON.parse(init.body!)});return {status:200,body:{status:'accepted',replayed:false,result:{attemptId:id,state:'queued',sendingUnchanged:true,holdsUnchanged:true}}};}});
 const handlers=crmCaptureReadRecoveryHandlers({api,generation:()=>1});
 expect(await handlers['crm.captureReadRecoveryRequest'](payload)).toMatchObject({attemptId:id,state:'queued'});
 expect(seen).toEqual([{url:'https://example.test/crm/business/capture-read-recovery/request',method:'POST',body:{...payload,clientVersion:'1.0.0'}}]);
 expect(OPERATIONS['crm.captureReadRecoveryRequest'].input.safeParse({...payload,clearIncident:true}).success).toBe(false);
 expect(OPERATIONS['crm.captureReadRecoveryRead'].output.safeParse({...status,providerCoverage:'complete'}).success).toBe(false);
});
