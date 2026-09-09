import {randomUUID} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import {requestedCallFixture} from '../../cloud/lambdas/delegated-worker/test/requestedFollowupFixture';
import {DynamoRequestedFollowupRepository} from '../../cloud/lambdas/delegated-worker/src/requestedFollowupRepository';
import {createRequestedFollowupService} from '../../src/main/outreach/requestedFollowupService';
import {createWorkerHandler} from '../../cloud/lambdas/delegated-worker/src/handler';
import {loadRequestedApproval} from '../../cloud/lambdas/delegated-worker/src/requestedFollowupApproval';

async function captureFixture(){
 const f=await requestedCallFixture();const store=new DynamoRequestedFollowupRepository(f.options);
 const drafts=createRequestedFollowupService({store,clock:f.options.clock,id:randomUUID});
 const prepared=await drafts.prepareRequestedFollowup({accountId:'acct',originalCall:f.originalCall,recipientBinding:{kind:'account_route',routeId:'email',routeVersion:1,email:'recipient@example.invalid'},expectedAccountVersion:1,mode:'manual'},new AbortController().signal);
 const edited=await drafts.editRequestedFollowup({accountId:'acct',draftId:prepared.draft.id,expectedRevision:1,subject:'Requested information',body:'The exact owner-reviewed information.'});
 const command={commandId:randomUUID(),workspaceId:'ws',accountId:'acct',expectedAuthorityGeneration:1,expectedVersion:await f.execution.currentVersion('acct'),kind:'approve-requested-followup',payload:{draft:edited.draft,expectedRemoteDraftRevision:edited.draft.revision,approvalId:randomUUID(),actionId:randomUUID(),intentCommandId:randomUUID(),request:{statement:'recipient_requested_information_by_email',recipient:edited.draft.recipient},expiresAt:'2026-09-10T00:00:00.000Z'}};
 const handler=createWorkerHandler({auth:f.auth,google:f.authorization,host:'worker.example.invalid'});
 const post=(body:unknown)=>handler({version:'2.0',rawPath:'/commands',rawQueryString:'',headers:{host:'worker.example.invalid','x-forwarded-proto':'https',authorization:`Bearer ${f.pairing.credential}`},body:JSON.stringify(body),requestContext:{domainName:'worker.example.invalid',http:{method:'POST',sourceIp:'fictional'}}});
 return {...f,store,drafts,command,post};
}
it('captures exactly one human first-email approval through actual authenticated HTTP without making it executable',async()=>{
 const f=await captureFixture();const result=await f.post(f.command);expect(result.statusCode).toBe(200);
 const receipt=JSON.parse(result.body);expect(receipt).toMatchObject({commandId:f.command.commandId,status:'applied'});
 const pending=await loadRequestedApproval(f.store.store,f.command.commandId);expect(pending?.record).toMatchObject({state:'pending_preflight',materializedIntentId:null,draftSnapshot:f.command.payload.draft});
 expect(pending?.receipt).toEqual(receipt);expect(await f.post(f.command)).toEqual(result);
 expect(await f.execution.readDispatch('acct',f.command.payload.actionId)).toBeNull();
 expect(await f.store.store.list('DISPATCH_PERMISSION#')).toEqual([]);expect(await f.store.store.list('MAIL_THREAD#')).toEqual([]);
 const event=(await f.execution.eventsAfter(null)).events.at(-1);expect(event).toMatchObject({kind:'requested_followup.status',payload:{commandId:f.command.commandId,draftId:f.command.payload.draft.id,status:{receipt,state:'pending_preflight',intentCommandId:null}}});
 const changed={...f.command,payload:{...f.command.payload,draft:{...f.command.payload.draft,body:'Changed after capture'}}};expect((await f.post(changed)).statusCode).toBe(400);
});
it.each(['wrong-call','changed-draft','missing-attestation','wrong-recipient'] as const)('rejects %s before creating a pending or executable approval',async scenario=>{
 const f=await captureFixture();const command=structuredClone(f.command);
 if(scenario==='wrong-call')command.payload.draft.originalCall.outcomeEventHash='f'.repeat(64);
 if(scenario==='changed-draft')command.payload.draft.body='Not the persisted reviewed revision';
 if(scenario==='missing-attestation')delete (command.payload as {request?:unknown}).request;
 if(scenario==='wrong-recipient')command.payload.request.recipient='other@example.invalid';
 expect((await f.post(command)).statusCode).toBe(400);
 expect(await f.store.store.list('REQUESTED_APPROVAL#')).toEqual([]);expect(await f.execution.readDispatch('acct',command.payload.actionId)).toBeNull();
});

it.each(['requested','owner','delegation'] as const)('parses canonical requested approval after fresh %s entry import',async entry=>{
 const f=await captureFixture();vi.resetModules();
 if(entry==='requested')await import('../../src/shared/contracts/requestedFollowupContract');
 if(entry==='owner')await import('../../src/shared/contracts/ownerCommandContract');
 if(entry==='delegation')await import('../../src/shared/contracts/delegationContract');
 const owner=await import('../../src/shared/contracts/ownerCommandContract');const delegation=await import('../../src/shared/contracts/delegationContract');
 expect(owner.ownerCommandSchema.parse(f.command)).toEqual(f.command);
 const receipt={commandId:f.command.commandId,status:'applied',authorityGeneration:1,aggregateVersion:f.command.expectedVersion+1,reason:null as null};
 expect(delegation.workerEventSchema.parse({id:'capture',workspaceId:'ws',accountId:'acct',authorityGeneration:1,aggregateVersion:receipt.aggregateVersion,kind:'requested_followup.status',payload:{commandId:f.command.commandId,draftId:f.command.payload.draft.id,status:{receipt,state:'pending_preflight',intentCommandId:null,reason:null}}})).toMatchObject({kind:'requested_followup.status'});
});

it('rejects a requested status carrying another campaign command identity',async()=>{
 const f=await captureFixture();expect((await f.post(f.command)).statusCode).toBe(200);
 const event=(await f.execution.eventsAfter(null)).events.at(-1);
 const {workerEventSchema}=await import('../../src/shared/contracts/delegationContract');
 expect(workerEventSchema.safeParse({...event,campaign:{commandId:randomUUID(),version:null,enrollment:null,evidence:null}}).success).toBe(false);
});
