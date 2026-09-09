import {randomUUID} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import {requestedCallFixture} from '../../cloud/lambdas/delegated-worker/test/requestedFollowupFixture';
import {DynamoRequestedFollowupRepository} from '../../cloud/lambdas/delegated-worker/src/requestedFollowupRepository';
import {createRequestedFollowupService} from '../../src/main/outreach/requestedFollowupService';
import {createWorkerHandler} from '../../cloud/lambdas/delegated-worker/src/handler';
import {loadRequestedApproval} from '../../cloud/lambdas/delegated-worker/src/requestedFollowupApproval';

async function captureFixture(ownerSupplied=false){
 const f=await requestedCallFixture();const store=new DynamoRequestedFollowupRepository(f.options);
 const drafts=createRequestedFollowupService({store,clock:f.options.clock,id:randomUUID});
 const prepared=await drafts.prepareRequestedFollowup({accountId:'acct',originalCall:f.originalCall,recipientBinding:ownerSupplied?{kind:'owner_supplied',email:'requested@example.invalid',originalCall:f.originalCall}:{kind:'account_route',routeId:'email',routeVersion:1,email:'recipient@example.invalid'},expectedAccountVersion:1,mode:'manual'},new AbortController().signal);
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

it('returns bounded authenticated actual context and rejects foreign pairing or caller proof',async()=>{
 const f=await captureFixture();const request={workspaceId:'ws',input:{accountId:'acct',originalCall:f.originalCall,recipientBinding:f.command.payload.draft.recipientBinding,expectedAccountVersion:1,mode:'manual'}};
 const handler=createWorkerHandler({auth:f.auth,google:f.authorization,host:'worker.example.invalid'});
 const read=(body:unknown,credential=f.pairing.credential)=>handler({version:'2.0',rawPath:'/requested-followup/context',rawQueryString:'',headers:{host:'worker.example.invalid','x-forwarded-proto':'https',authorization:`Bearer ${credential}`},body:JSON.stringify(body),requestContext:{domainName:'worker.example.invalid',http:{method:'POST',sourceIp:'fictional'}}});
 const response=await read(request);expect(response.statusCode).toBe(200);const proof=JSON.parse(response.body);
 expect(proof).toMatchObject({workspaceId:'ws',accountId:'acct',authorityGeneration:1,aggregateVersion:await f.execution.currentVersion('acct'),mailContext:f.command.payload.draft.mailContext,mailbox:{subject:'mailbox',sender:'sender@example.invalid'}});
 expect(Date.parse(proof.expiresAt)-Date.parse(f.options.clock.now())).toBeGreaterThan(0);expect(Date.parse(proof.expiresAt)-Date.parse(f.options.clock.now())).toBeLessThanOrEqual(60000);
 expect((await read({...request,expiresAt:'2099-01-01T00:00:00.000Z'})).statusCode).toBe(400);
 const invitation=await f.auth.issuePairing({scopes:['events:read'],expiresInSeconds:300});const other=await f.auth.redeemPairing(invitation.code,'other-fictional');expect((await read(request,other.credential)).statusCode).not.toBe(200);
});
it('normal runtime exposes four requested draft operations without raw approval bypass',async()=>{
 const {createDelegationRuntime}=await import('../../src/main/delegation/delegationRuntime');
 const runtime=createDelegationRuntime({databaseGate:{withDatabase:async()=>{throw Error('locked fixture');}},pairing:null,clock:{now:()=> '2026-09-09T00:00:00.000Z'}});
 try{for(const name of ['prepareRequestedFollowup','getRequestedFollowup','editRequestedFollowup','approveRequestedFollowup'])expect(typeof runtime[name as keyof typeof runtime]).toBe('function');
 const f=await captureFixture();const {publicDelegationCommandSchema}=await import('../../src/shared/contracts/delegationContract');expect(publicDelegationCommandSchema.safeParse(f.command).success).toBe(false);
 }finally{await runtime.dispose();}
});

async function desktopFixture(){
 const f=await requestedCallFixture();const {createPmFixture}=await import('../fixtures/pmAccounts');const local=await createPmFixture();
 const {AccountRepository}=await import('../../src/main/domain/accounts/accountRepository');const {DelegationRepository}=await import('../../src/main/delegation/delegationRepository');
 const {delegationCommandSchema}=await import('../../src/shared/contracts/delegationContract');const {exportSelectedAccountRecord}=await import('../../src/main/delegation/selectedAccountSnapshot');
 const {accountRecordSchema}=await import('../../src/shared/contracts/accountRecordContract');
 const remote=accountRecordSchema.parse((await f.store.get('ACCOUNT#acct'))!.data);
 const accounts=new AccountRepository({database:local.db,clock:f.options.clock,ids:{next:()=> 'acct'},sourcePolicy:{attest:source=>source.url==='https://example.invalid/team'}});
 accounts.create({commandId:randomUUID(),name:remote.account.name,domain:null});accounts.admitEvidence({commandId:randomUUID(),accountId:'acct',expectedVersion:1,sources:remote.sources,claims:[],routes:remote.routes.map(({version:_version,...route})=>{void _version;return route;})});
 // Test fixture seeds the actual SDK account projection from the real SQL exporter, not a fake event.
 const record=exportSelectedAccountRecord({database:local.db,workspaceId:'ws',accountId:'acct',asOf:f.options.clock.now(),researchRevision:1});const row=(await f.store.get('ACCOUNT#acct'))!;await f.store.transact([f.store.put('ACCOUNT#acct',record,row.rev)]);
 const repository=new DelegationRepository({database:local.db,workspaceId:'ws',clock:f.options.clock});repository.initializeLocalAuthority('acct');
 for(const event of (await f.execution.eventsAfter(null)).events){
  const receipt='receipt' in event?event.receipt:event.kind==='authority.changed'?event.payload.receipt:null;
  if(receipt){const marker=await f.store.get<{command?:unknown}>(`COMMAND#${receipt.commandId}`);const command=marker?.data.command??{commandId:'delegate',workspaceId:'ws',accountId:'acct',expectedAuthorityGeneration:0,expectedVersion:0,kind:'delegate',payload:{delegationId:'explicit',approvedAt:f.options.clock.now()}};repository.queueCommand(delegationCommandSchema.parse(command));}
  expect(repository.applyWorkerEvent(event)).toBe('applied');
  if(event.kind==='manual.handoff')repository.consumeManualHandoff({...event.payload,accountId:'acct',authorityGeneration:1},()=>undefined);
 }
 const handler=createWorkerHandler({auth:f.auth,google:f.authorization,host:'worker.example.invalid'});let offline=false;const requests:{path:string;body:unknown}[]=[];
 const http:typeof fetch=async(input,init)=>{if(offline)throw Error('fictional offline');const url=new URL(String(input));requests.push({path:url.pathname,body:init?.body?JSON.parse(String(init.body)):null});const result=await handler({version:'2.0',rawPath:url.pathname,rawQueryString:url.search.slice(1),headers:{host:url.host,'x-forwarded-proto':'https',authorization:new Headers(init?.headers).get('authorization')??''},body:init?.body,requestContext:{domainName:url.host,http:{method:init?.method??'GET',sourceIp:'fictional'}}});return new Response(result.body,{status:result.statusCode});};
 const {createDelegationRuntime}=await import('../../src/main/delegation/delegationRuntime');
 const runtime=(overrides:Partial<Parameters<typeof createDelegationRuntime>[0]>={})=>createDelegationRuntime({databaseGate:{withDatabase:async run=>run(local.db)},pairing:{...f.pairing,endpoint:'https://worker.example.invalid'},clock:f.options.clock,fetch:http,...overrides});
 return {...f,local,repository,runtime,requests,setOffline:(value:boolean)=>{offline=value;}};
}
function firstEmailHttp(){let sends=0;const mime:string[]=[];const http:typeof fetch=async(resource,init)=>{
 init?.signal?.throwIfAborted();const url=new URL(String(resource));
 if(url.pathname.endsWith('/profile'))return Response.json({historyId:'2'});
 if(url.pathname.endsWith('/history'))return Response.json({historyId:'2',history:[]});
 if(url.pathname.endsWith('/messages'))return Response.json({messages:[]});
 if(url.pathname.endsWith('/messages/send')){sends++;const wire=JSON.parse(String(init?.body));expect(wire.threadId).toBeUndefined();mime.push(Buffer.from(wire.raw,'base64url').toString());return Response.json({id:'actual-first-email',threadId:'actual-provider-thread'});}
 throw Error('unexpected fictional Gmail HTTP');
 };return {http,mime,sends:()=>sends};}
it('real SQL restart and authenticated normal runtime capture reaches source send with one exact human approval',async()=>{
 const f=await desktopFixture();let runtime=f.runtime();const mail=firstEmailHttp();
 try{
  const prepared=await runtime.prepareRequestedFollowup({accountId:'acct',originalCall:f.originalCall,recipientBinding:{kind:'owner_supplied',email:'requested@example.invalid',originalCall:f.originalCall},expectedAccountVersion:2,mode:'manual'});
  const edited=await runtime.editRequestedFollowup({accountId:'acct',draftId:prepared.draft.id,expectedRevision:1,subject:'Requested information',body:'Exact saved local information.'});
  const editedAgain=await runtime.editRequestedFollowup({accountId:'acct',draftId:prepared.draft.id,expectedRevision:2,subject:edited.draft.subject,body:'Third exact saved revision.'});
  await runtime.dispose();const {openDatabase,closeDatabase}=await import('../../src/main/db/database');const {createTestWorkspaceKey}=await import('../fixtures/tempDatabase');closeDatabase(f.local.db);const key=createTestWorkspaceKey();const reopened=openDatabase({path:f.local.db.path,key});key.bytes.fill(0);f.local.db.raw=reopened.raw;f.local.db.kysely=reopened.kysely;runtime=f.runtime();
  const saved=await runtime.getRequestedFollowup({accountId:'acct',draftId:prepared.draft.id});expect(saved?.draft).toEqual(editedAgain.draft);
  const approval={draft:editedAgain.draft,expectedRemoteDraftRevision:null as null,approvalId:randomUUID(),actionId:randomUUID(),intentCommandId:randomUUID(),request:{statement:'recipient_requested_information_by_email' as const,recipient:editedAgain.draft.recipient},expiresAt:'2026-09-10T00:00:00.000Z'};
  await expect(runtime.approveRequestedFollowup({...approval,draft:{...approval.draft,body:'Unsaved renderer text'}})).rejects.toThrow('requested_saved_content_mismatch');
  const captured=await runtime.approveRequestedFollowup(approval);expect(captured).toMatchObject({state:'pending_preflight',receipt:{status:'applied'},intentCommandId:null});
  expect(await f.execution.readDispatch('acct',approval.actionId)).toBeNull();expect(mail.sends()).toBe(0);
  const {createSourceCoordinator}=await import('../../cloud/lambdas/delegated-worker/src/sourceCoordinator');
  for(let i=0;i<3;i++){await createSourceCoordinator({auth:f.auth,authorization:f.authorization,fetch:mail.http}).tick(new AbortController().signal);await runtime.sync();}
  const final=await runtime.getRequestedFollowup({accountId:'acct',draftId:prepared.draft.id});expect(final?.approval).toMatchObject({state:'materialized',receipt:captured.receipt,intentCommandId:approval.intentCommandId});
  expect(final?.draft).toEqual(editedAgain.draft);expect(f.repository.commandStatus(captured.receipt.commandId)).toEqual(captured.receipt);expect(mail.sends()).toBe(1);expect(mail.mime[0]).not.toMatch(/^(In-Reply-To|References):/mi);
  const approvals=f.requests.filter(r=>r.path==='/commands'&&(r.body as {kind?:string})?.kind==='approve-requested-followup');expect(new Set(approvals.map(r=>(r.body as {commandId:string}).commandId)).size).toBe(1);expect(approvals.every(r=>JSON.stringify(r.body)===JSON.stringify(approvals[0].body))).toBe(true);
  const replyHttp:typeof fetch=async(resource,init)=>{
   const url=new URL(String(resource));
   if(url.pathname.endsWith('/history'))return Response.json({historyId:'3',history:[{messagesAdded:[{message:{id:'actual-reply'}}]}]});
   if(url.pathname.endsWith('/messages/actual-reply'))return Response.json({id:'actual-reply',threadId:'actual-provider-thread',internalDate:String(Date.parse(f.options.clock.now())),payload:{mimeType:'text/plain',headers:[{name:'From',value:approval.draft.recipient},{name:'To',value:approval.draft.sender},{name:'Subject',value:'Re: Requested information'},{name:'Message-ID',value:'<actual-reply@example.invalid>'},{name:'In-Reply-To',value:`<${approval.intentCommandId}@callie.invalid>`}],body:{data:Buffer.from('Please explain the next step.').toString('base64url')}}});
   return mail.http(resource,init);
  };
  await createSourceCoordinator({auth:f.auth,authorization:f.authorization,fetch:replyHttp}).tick(new AbortController().signal);await runtime.sync();
  expect(await f.policy.requestedReplyAssociation(approval.intentCommandId,'actual-provider-thread')).toMatchObject({providerMessageId:'actual-first-email',inboundMessageId:'actual-reply'});
  expect((await runtime.getRequestedFollowup({accountId:'acct',draftId:prepared.draft.id}))?.stale).toBe(true);expect(mail.sends()).toBe(1);
  f.setOffline(true);const offline=await runtime.getRequestedFollowup({accountId:'acct',draftId:prepared.draft.id});expect(offline).toMatchObject({stale:true,draft:editedAgain.draft,approval:{state:'materialized'}});
 }finally{await runtime.dispose();f.local.close();}
});

it('keeps captured requested participant through actual source expansion and configure-owner pause/reactivation',async()=>{
 const f=await captureFixture(true);expect((await f.post(f.command)).statusCode).toBe(200);const mail=firstEmailHttp();
 const {createSourceCoordinator}=await import('../../cloud/lambdas/delegated-worker/src/sourceCoordinator');
 await createSourceCoordinator({auth:f.auth,authorization:f.authorization,fetch:mail.http}).tick(new AbortController().signal);
 const expanded=await f.threads.scope('acct','mailbox');expect(expanded?.participantAddresses).toContain('requested@example.invalid');
 const {ownerSourceKey,ownerSourceConfigurationSchema}=await import('../../src/shared/contracts/ownerCommandContract');
 for(const state of ['paused','active'] as const){const previous=ownerSourceConfigurationSchema.parse((await f.store.store.get(ownerSourceKey('acct')))!.data);
  await f.apply('configure-owner',{expectedConfigurationRevision:previous.revision,configuration:{...previous,revision:previous.revision+1,state},mailScope:null});
 }
 expect((await f.threads.scope('acct','mailbox'))?.participantAddresses).toEqual(expanded?.participantAddresses);
 await createSourceCoordinator({auth:f.auth,authorization:f.authorization,fetch:mail.http}).tick(new AbortController().signal);
 expect((await loadRequestedApproval(f.store.store,f.command.commandId))?.record.state).toBe('materialized');expect(mail.sends()).toBe(1);
});
it('refuses a stronger collaborator AUTH condition rather than silently discarding it during capture',async()=>{
 const f=await captureFixture();const original=DynamoRequestedFollowupRepository.prototype.planCurrent;
 const spy=vi.spyOn(DynamoRequestedFollowupRepository.prototype,'planCurrent').mockImplementation(async function(this:DynamoRequestedFollowupRepository,draft){const plan:Awaited<ReturnType<DynamoRequestedFollowupRepository['planCurrent']>>=await original.call(this,draft);const condition=plan.checks.find(item=>item.ConditionCheck?.Key?.sk?.S==='AUTH#acct')!.ConditionCheck!;condition.ConditionExpression+=' AND attribute_exists(extra_guard)';return plan;});
 try{expect((await f.post(f.command)).statusCode).toBe(400);expect(await f.store.store.list('REQUESTED_APPROVAL#')).toEqual([]);}finally{spy.mockRestore();}
});
it('keeps an offline exact approval pending through SQL reopen and reconnects the same command',async()=>{
 const f=await desktopFixture();let runtime=f.runtime();
 try{
  const prepared=await runtime.prepareRequestedFollowup({accountId:'acct',originalCall:f.originalCall,recipientBinding:{kind:'owner_supplied',email:'requested@example.invalid',originalCall:f.originalCall},expectedAccountVersion:2,mode:'manual'});
  const edited=await runtime.editRequestedFollowup({accountId:'acct',draftId:prepared.draft.id,expectedRevision:1,subject:'Requested',body:'Offline queued exact information'});
  f.setOffline(true);const status=await runtime.approveRequestedFollowup({draft:edited.draft,expectedRemoteDraftRevision:null,approvalId:randomUUID(),actionId:randomUUID(),intentCommandId:randomUUID(),request:{statement:'recipient_requested_information_by_email',recipient:edited.draft.recipient},expiresAt:'2026-09-10T00:00:00.000Z'});
  expect(status).toMatchObject({state:'pending_preflight',receipt:{status:'pending'}});expect(await f.store.list('REQUESTED_APPROVAL#')).toEqual([]);
  await runtime.dispose();const {openDatabase,closeDatabase}=await import('../../src/main/db/database');const {createTestWorkspaceKey}=await import('../fixtures/tempDatabase');closeDatabase(f.local.db);const key=createTestWorkspaceKey();const reopened=openDatabase({path:f.local.db.path,key});key.bytes.fill(0);f.local.db.raw=reopened.raw;f.local.db.kysely=reopened.kysely;runtime=f.runtime();
  expect((await runtime.getRequestedFollowup({accountId:'acct',draftId:prepared.draft.id}))?.approval).toEqual(status);
  f.setOffline(false);await runtime.sync();const result=await runtime.getRequestedFollowup({accountId:'acct',draftId:prepared.draft.id});expect(result?.approval).toMatchObject({state:'pending_preflight',receipt:{commandId:status.receipt.commandId,status:'applied'}});expect(result?.draft).toEqual(edited.draft);
  expect(await f.store.list('REQUESTED_APPROVAL#')).toHaveLength(1);
 }finally{await runtime.dispose();f.local.close();}
});
it('invalidating the actual runtime lease during model credential resolution prevents saving a draft',async()=>{
 const f=await desktopFixture();let resolve!:()=>void;const entered=new Promise<void>(done=>{resolve=done;});let release!:()=>void;const held=new Promise<void>(done=>{release=done;});
 const runtime=f.runtime({requestedModel:async()=>{resolve();await held;return undefined;}});
 try{
  const result=runtime.prepareRequestedFollowup({accountId:'acct',originalCall:f.originalCall,recipientBinding:{kind:'owner_supplied',email:'requested@example.invalid',originalCall:f.originalCall},expectedAccountVersion:2,mode:'model'});
  await entered;runtime.invalidate(true);release();await expect(result).rejects.toThrow();
  expect(f.local.db.raw.prepare('SELECT COUNT(*) n FROM delegated_requested_followup_drafts').get()).toEqual({n:0});expect(await f.store.list('REQUESTED_APPROVAL#')).toEqual([]);
 }finally{release();await runtime.dispose();f.local.close();}
});
it('optional policy importer is a lease-bound native-only runtime surface',async()=>{
 const f=await desktopFixture();let selections=0;const runtime=f.runtime({pairing:{...f.pairing,workspaceId:'11111111-1111-4111-8111-111111111111',endpoint:'https://worker.example.invalid'},policyImportNative:{selectArtifact:async()=>{selections++;return null;},confirmReview:async()=>false}});
 try{expect(runtime.policyImport).toBeTruthy();expect(await runtime.policyImport!.selectAndPreview()).toBeNull();expect(selections).toBe(1);runtime.invalidate(true);await expect(runtime.policyImport!.selectAndPreview()).rejects.toThrow();expect(selections).toBe(1);}finally{await runtime.dispose();f.local.close();}
});

vi.mock('electron',()=>({dialog:{},safeStorage:{}}));
it('native file selection and exact review dialog compose into durable SQL policy review without renderer attestation',async()=>{
 const f=await desktopFixture();const {createPolicyImportNativeAdapters}=await import('../../src/main/startApplication');const {writeFile,symlink}=await import('node:fs/promises');
 const {AccountRepository}=await import('../../src/main/domain/accounts/accountRepository');const {createHash}=await import('node:crypto');const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
 const workspaceId='11111111-1111-4111-8111-111111111111';const at=f.options.clock.now();const repository=new AccountRepository({database:f.local.db,clock:f.options.clock,ids:{next:randomUUID},sourcePolicy:{attest:()=>true}});
 const account=repository.create({commandId:randomUUID(),name:'Fictional imported evidence account',domain:null});const routeId=randomUUID(),sourceId=randomUUID();
 repository.admitEvidence({commandId:randomUUID(),accountId:account.id,expectedVersion:1,claims:[],sources:[{id:sourceId,url:'https://example.invalid/team',fetchedAt:at,sha256:hash('source'),excerpt:'Fictional public phone evidence only',permitted:true}],routes:[{id:routeId,accountId:account.id,personId:null,channel:'phone',value:'+12025550155',purpose:'business',evidenceIds:[sourceId],verification:'published'}]});
 const content='Fictional manual evidence. No government verification or legal clearance.';
 const artifact={format:'fss-account-route-policy-review',version:1,workspaceId,documents:[{id:'doc',mediaType:'text/plain',content,sha256:hash(content)}],rows:[{rowId:'row',accountId:account.id,routeId,expectedRouteVersion:1,expectedEvidenceFingerprint:repository.snapshot(account.id,at).fingerprint,targetSourceIds:[sourceId],documentIds:['doc'],citations:[{documentId:'doc',field:'contact.evidence',excerpt:content}],observedAt:at,effectiveAt:at,expiresAt:'2026-09-10T00:00:00.000Z',operation:'observe',reason:'Owner review',policy:{contact:{kind:'phone',normalizedValue:'+12025550155',validationState:'unverified',evidence:{source:'manual_import',federalStatus:'unknown',tcpaFlag:null as null,coveredAreaCode:null as null,scrubbedAt:null as null,expiresAt:null as null}},jurisdiction:null as null,clearance:null as null}}]};
 const path=f.local.db.path+'.review.json';await writeFile(path,JSON.stringify(artifact));let selected=path;let response=0;let detail='';
 const native=createPolicyImportNativeAdapters({showOpenDialog:vi.fn(async()=>({canceled:false,filePaths:[selected]})),showMessageBox:vi.fn(async(options)=>{detail=options.detail??'';return {response,checkboxChecked:false};})});
 const runtime=f.runtime({pairing:{...f.pairing,workspaceId,endpoint:'https://worker.example.invalid'},policyImportNative:native});
 try{
  await expect(native.selectArtifact(4,new AbortController().signal)).rejects.toThrow('policy_import_size_invalid');const link=path+'.link';await symlink(path,link);selected=link;await expect(native.selectArtifact(1048576,new AbortController().signal)).rejects.toThrow();selected=path;
  const preview=(await runtime.policyImport!.selectAndPreview())!;const request={previewId:preview.previewId,expectedArtifactHash:preview.artifactHash,reviewReason:'I reviewed the actual fictional source text'};
  await expect(runtime.policyImport!.confirm({...request,approved:true} as typeof request)).rejects.toThrow();
  await expect(runtime.policyImport!.confirm(request)).rejects.toThrow('review_cancelled');expect(f.local.db.raw.prepare('SELECT COUNT(*) n FROM account_route_policy_import_reviews').get()).toEqual({n:0});
  response=1;const report=await runtime.policyImport!.confirm(request);expect(report.rows[0].status).toBe('admitted');expect(JSON.parse(detail)).toMatchObject({artifactHash:preview.artifactHash,reviewReason:request.reviewReason,artifact});
  const {accountFingerprint}=await import('../../src/main/domain/accounts/accountEvidence');expect(JSON.parse(detail).rowHashes).toEqual([{rowId:'row',sha256:accountFingerprint(artifact.rows[0])}]);
  expect(await runtime.policyImport!.status({reviewId:report.reviewId})).toEqual(report);expect((await runtime.policyImport!.resume({reviewId:report.reviewId,expectedArtifactHash:report.artifactHash})).rows[0].status).toBe('admitted');
  expect(f.requests).toEqual([]);
 }finally{await runtime.dispose();f.local.close();}
});
it('projects remote rejection of offline requested approval separately from its saved draft',async()=>{
 const f=await desktopFixture();const runtime=f.runtime();
 try{
  const prepared=await runtime.prepareRequestedFollowup({accountId:'acct',originalCall:f.originalCall,recipientBinding:{kind:'owner_supplied',email:'requested@example.invalid',originalCall:f.originalCall},expectedAccountVersion:2,mode:'manual'});
  const edited=await runtime.editRequestedFollowup({accountId:'acct',draftId:prepared.draft.id,expectedRevision:1,subject:'Requested',body:'Exact review'});
  f.setOffline(true);const pending=await runtime.approveRequestedFollowup({draft:edited.draft,expectedRemoteDraftRevision:null,approvalId:randomUUID(),actionId:randomUUID(),intentCommandId:randomUUID(),request:{statement:'recipient_requested_information_by_email',recipient:edited.draft.recipient},expiresAt:'2026-09-10T00:00:00.000Z'});
  await f.execution.applyCommand({commandId:randomUUID(),workspaceId:'ws',accountId:'acct',expectedAuthorityGeneration:1,expectedVersion:await f.execution.currentVersion('acct'),kind:'pause',payload:{reason:'Owner paused while device offline'}});
  f.setOffline(false);await runtime.sync();const saved=await runtime.getRequestedFollowup({accountId:'acct',draftId:prepared.draft.id});expect(f.repository.commandStatus(pending.receipt.commandId)?.status).toBe('rejected');
  expect(saved).toMatchObject({draft:edited.draft,approval:{state:'needs_review',receipt:{status:'rejected'}}});expect(await f.store.list('REQUESTED_APPROVAL#')).toEqual([]);
 }finally{await runtime.dispose();f.local.close();}
});
