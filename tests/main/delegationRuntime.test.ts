import {expect,it,vi} from 'vitest';
import {createPmFixture,PM_NOW} from '../fixtures/pmAccounts';
import {createDelegationRuntime,assertRefreshCommandTransportable,REFRESH_COMMAND_LIMITS} from '../../src/main/delegation/delegationRuntime';
import {exportSelectedAccountRecord} from '../../src/main/delegation/selectedAccountSnapshot';
import type {StoredPairing} from '../../src/main/delegation/pairingStore';
// The real exporter refuses records over 200000 bytes on its own. To prove the gateway guard in the runtime, one call is
// handed a record the exporter never produces; every other call runs the real exporter unchanged.
const snapshotModule=vi.hoisted(()=>({actual:null as typeof import('../../src/main/delegation/selectedAccountSnapshot')|null}));
vi.mock('../../src/main/delegation/selectedAccountSnapshot',async importOriginal=>{const actual=await importOriginal<typeof import('../../src/main/delegation/selectedAccountSnapshot')>();snapshotModule.actual=actual;return {...actual,exportSelectedAccountRecord:vi.fn(actual.exportSelectedAccountRecord)};});
const pair:StoredPairing={endpoint:'https://worker.example.test',workspaceId:'ws',pairingId:'11111111-1111-4111-8111-111111111111',credential:'a'.repeat(43),emergencyCredential:'b'.repeat(43),generation:0,scopes:['commands:write','events:read']};
it('normal local runtime is inactive without pairing and never touches HTTP',async()=>{
 const f=await createPmFixture();let calls=0;
 const runtime=createDelegationRuntime({databaseGate:{withDatabase:async fn=>fn(f.db)},pairing:null,clock:{now:()=>PM_NOW},fetch:async()=>{calls++;throw Error('forbidden');}});
 try{expect(await runtime.status()).toMatchObject({state:'unconfigured',workspaceId:null});expect(calls).toBe(0);await expect(runtime.sync()).rejects.toThrow('pairing');}finally{await runtime.dispose();f.close();}
});
it('captures paired identity immutably and persists configuration under actual SQL CAS',async()=>{
 const f=await createPmFixture();const mutable={...pair};let leases=0;
 const runtime=createDelegationRuntime({databaseGate:{withDatabase:async fn=>{leases++;try{return await fn(f.db);}finally{leases--;}}},pairing:mutable,clock:{now:()=>PM_NOW},fetch:async()=>{throw Error('forbidden');}});
 mutable.workspaceId='other';
 try{expect(await runtime.status()).toMatchObject({workspaceId:'ws',state:'paused'});await runtime.configure({expectedRevision:0,configuration:{version:1,state:'paused',research:null}});expect(await runtime.status()).toMatchObject({configuration:{revision:1}});expect(leases).toBe(0);runtime.invalidate(true);await expect(runtime.configure({expectedRevision:1,configuration:{version:1,state:'paused',research:null}})).rejects.toThrow('inactive');expect(leases).toBe(0);}finally{await runtime.dispose();f.close();}
});

it('bootstraps one actual selected account through C2 HTTP and acknowledges explicit research baseline without grants',async()=>{
 const f=await createPmFixture();
 const {ConditionalCommandHarness}=await import('../../cloud/lambdas/delegated-worker/test/sdkHarness');
 const {WorkerAuth}=await import('../../cloud/lambdas/delegated-worker/src/workerAuth');
 const {createWorkerHandler}=await import('../../cloud/lambdas/delegated-worker/src/handler');
 const auth=new WorkerAuth({dynamo:new ConditionalCommandHarness(),tableName:'fictional',workspaceId:'ws',clock:{now:()=>PM_NOW}});
 const redeemed=await auth.redeemPairing((await auth.issuePairing({scopes:['commands:write','events:read'],expiresInSeconds:300})).code,'fictional');
 const handler=createWorkerHandler({auth,host:'worker.example.test'});
 const http:typeof fetch=async(input,init)=>{const u=new URL(String(input));const reply=await handler({version:'2.0',rawPath:u.pathname,rawQueryString:u.search.slice(1),headers:{host:u.host,'x-forwarded-proto':'https',authorization:new Headers(init?.headers).get('authorization')??''},body:init?.body,requestContext:{domainName:u.host,http:{method:init?.method??'GET',sourceIp:'fictional'}}});return new Response(reply.body,{status:reply.statusCode});};
 const {FoundationRuntime}=await import('../../src/main/foundation/foundationRuntime');
 const {DomainRuntime}=await import('../../src/main/domain/domainRuntime');
 const {migrateToLatest}=await import('../../src/main/db/migrate');
 const {randomUUID}=await import('node:crypto');let closed=false;
 const foundation=new FoundationRuntime({appVersion:'fixture',backupDirectory:'fictional-backups',databasePath:'fictional-encrypted',databaseExists:true,keyEnvelopePath:'fictional-key'}, {loadWorkspaceKey:async()=>({bytes:Buffer.alloc(32,7),version:1}),prepareEncryptedDatabase:async()=>undefined,openDatabase:()=>f.db,migrateToLatest,createDomainRuntime:database=>new DomainRuntime({database,clock:{now:()=>PM_NOW},ids:{next:randomUUID},expectedWorkspaceId:'ws'}),createHealthService:()=>({getHealth:async()=>({})}),closeDatabase:()=>{f.close();closed=true;}});
 const runtime=createDelegationRuntime({databaseGate:foundation,pairing:{...redeemed,endpoint:pair.endpoint},clock:{now:()=>PM_NOW},fetch:http});
 try{
  const account=f.repo.create({commandId:'33333333-3333-4333-8333-333333333333',name:'Selected Fictional PM',domain:null});
  const receipt=await runtime.bootstrap({commandId:'22222222-2222-4222-8222-222222222222',accountId:account.id});
  expect(receipt.status).toBe('applied');
  expect((await auth.store.list('ACCOUNT#'))).toHaveLength(1);
  expect((await auth.store.get<{authority:{owner:string;state:string}}> (`AUTH#${account.id}`))?.data.authority).toMatchObject({owner:'local',state:'local'});
  expect(f.db.raw.prepare("SELECT aggregate_version FROM delegated_event_cursors WHERE workspace_id='ws' AND account_id=? AND stream='research'").get(account.id)).toEqual({aggregate_version:1});
  expect(await auth.store.list('GOOGLE_GRANT#')).toEqual([]);
  await runtime.submit({commandId:randomUUID(),workspaceId:'ws',accountId:account.id,expectedAuthorityGeneration:0,expectedVersion:1,kind:'delegate',payload:{delegationId:'explicit',approvedAt:PM_NOW}});await runtime.sync();
  await runtime.submit({commandId:randomUUID(),workspaceId:'ws',accountId:account.id,expectedAuthorityGeneration:1,expectedVersion:2,kind:'configure-owner',payload:{expectedConfigurationRevision:0,configuration:{version:1,workspaceId:'ws',accountId:account.id,pairingId:redeemed.pairingId,revision:1,state:'active',mailboxSubject:null,calendarId:null,research:null},mailScope:null}});await runtime.sync();
  await runtime.configure({expectedRevision:0,configuration:{version:1,state:'active',research:null}});
  const subject={kind:'account' as const,id:account.id};const checking=new AbortController();const proof=await runtime.adapter.synchronize(subject,checking.signal);checking.abort();
  expect(runtime.adapter.isAppliedCurrent(subject,proof.revision)).toBe(true);
  runtime.invalidate(true);expect(runtime.adapter.isAppliedCurrent(subject,proof.revision)).toBe(false);
  runtime.invalidate(false);vi.useFakeTimers();const expiry=await runtime.adapter.synchronize(subject,new AbortController().signal);expect(runtime.adapter.isAppliedCurrent(subject,expiry.revision)).toBe(true);await vi.advanceTimersByTimeAsync(5001);expect(runtime.adapter.isAppliedCurrent(subject,expiry.revision)).toBe(false);vi.useRealTimers();
  const finalProof=await runtime.adapter.synchronize(subject,new AbortController().signal);await runtime.dispose();await foundation.shutdown();expect(closed).toBe(true);expect(runtime.adapter.isAppliedCurrent(subject,finalProof.revision)).toBe(false);

 }finally{vi.useRealTimers();await runtime.dispose();await foundation.shutdown();if(!closed)f.close();}
});

it('refuses scoped handoff readiness when initialized registry omits the actual owner adapter',async()=>{
 const runtime=createDelegationRuntime({databaseGate:{withDatabase:async()=>{throw Error('unexpected lease');}},pairing:pair,clock:{now:()=>PM_NOW},inboundRegistry:{snapshot:()=>({initialized:true,revision:1,adapters:[]})},fetch:async()=>{throw Error('forbidden');}});
 try{expect(await runtime.readinessForHandoff('missing').checkSubject({kind:'account',id:'account'},new AbortController().signal)).toMatchObject({kind:'blocked'});}finally{await runtime.dispose();}
});

it('proves local subjects independently of paired worker accounts and invalidates local proof on delegation',async()=>{
 const f=await createPmFixture();const {DelegationRepository}=await import('../../src/main/delegation/delegationRepository');const {createInboundReadiness}=await import('../../src/main/communications/inboundReadiness');
 const repository=new DelegationRepository({database:f.db,workspaceId:'ws',clock:{now:()=>PM_NOW}});
 const local=f.repo.create({commandId:'44444444-4444-4444-8444-444444444444',name:'Local PM',domain:null});const worker=f.repo.create({commandId:'55555555-5555-4555-8555-555555555555',name:'Worker PM',domain:null});
 repository.initializeLocalAuthority(local.id);repository.initializeLocalAuthority(worker.id);
 const delegate={commandId:'66666666-6666-4666-8666-666666666666',workspaceId:'ws',accountId:worker.id,expectedAuthorityGeneration:0,expectedVersion:0,kind:'delegate' as const,payload:{delegationId:'selected',approvedAt:PM_NOW}};repository.queueCommand(delegate);
 const receipt={commandId:delegate.commandId,status:'applied' as const,authorityGeneration:1,aggregateVersion:1,reason:null as null};
 repository.applyWorkerEvent({id:'worker-owned',workspaceId:'ws',accountId:worker.id,authorityGeneration:1,aggregateVersion:1,kind:'authority.changed',payload:{authority:{accountId:worker.id,owner:'worker',state:'active',generation:1},receipt}});
 let http=0;const runtime=createDelegationRuntime({databaseGate:{withDatabase:async fn=>fn(f.db)},pairing:pair,clock:{now:()=>PM_NOW},fetch:async()=>{http++;throw Error('fictional owner unavailable');}});
 const readiness=createInboundReadiness({snapshot:()=>({initialized:true,revision:1,adapters:[runtime.adapter]})});
 try{
  const proof=await readiness.checkSubject({kind:'account',id:local.id},new AbortController().signal);expect(proof.kind).toBe('ready');
  const historical=await readiness.checkSubject({kind:'person',id:'historical-person'},new AbortController().signal);expect(historical.kind).toBe('ready');expect(http).toBe(0);
  f.repo.admitEvidence({commandId:'99999999-9999-4999-8999-999999999999',accountId:local.id,expectedVersion:1,sources:[{id:'local-source',url:'https://example.invalid/team',fetchedAt:PM_NOW,sha256:'b'.repeat(64),excerpt:'Fictional local contact',permitted:true}],claims:[],routes:[{id:'local-route',accountId:local.id,personId:'historical-person',channel:'phone',value:'+12025550124',purpose:'business',evidenceIds:['local-source'],verification:'published'}]});
  if(historical.kind==='ready')expect(()=>readiness.assertCurrent(historical.proof)).toThrow();
  const localPerson=await readiness.checkSubject({kind:'person',id:'historical-person'},new AbortController().signal);expect(localPerson.kind).toBe('ready');expect(http).toBe(0);
  f.repo.admitEvidence({commandId:'88888888-8888-4888-8888-888888888888',accountId:worker.id,expectedVersion:1,sources:[{id:'actual-source',url:'https://example.invalid/team',fetchedAt:PM_NOW,sha256:'a'.repeat(64),excerpt:'Fictional business contact',permitted:true}],claims:[],routes:[{id:'linked-route',accountId:worker.id,personId:'historical-person',channel:'phone',value:'+12025550123',purpose:'business',evidenceIds:['actual-source'],verification:'published'}]});
  if(historical.kind==='ready')expect(()=>readiness.assertCurrent(historical.proof)).toThrow();
  if(localPerson.kind==='ready')expect(()=>readiness.assertCurrent(localPerson.proof)).toThrow();
  expect((await readiness.checkSubject({kind:'person',id:'historical-person'},new AbortController().signal)).kind).toBe('blocked');
  expect((await readiness.checkSubject({kind:'account',id:'missing'},new AbortController().signal)).kind).toBe('blocked');
  await runtime.configure({expectedRevision:0,configuration:{version:1,state:'active',research:null}});
  expect((await readiness.checkSubject({kind:'account',id:worker.id},new AbortController().signal)).kind).toBe('blocked');expect(http).toBeGreaterThan(0);
  const current=await readiness.checkSubject({kind:'account',id:local.id},new AbortController().signal);expect(current.kind).toBe('ready');
  repository.queueCommand({...delegate,accountId:local.id,commandId:'77777777-7777-4777-8777-777777777777'});
  if(current.kind==='ready')expect(()=>readiness.assertCurrent(current.proof)).toThrow();
  expect((await readiness.checkSubject({kind:'account',id:local.id},new AbortController().signal)).kind).toBe('blocked');
 }finally{await runtime.dispose();f.close();}
});

it('resubmits the saved record to the owning worker with one live command per account, reusing the same id after a lost response',async()=>{
 const f=await createPmFixture();
 const {ConditionalCommandHarness}=await import('../../cloud/lambdas/delegated-worker/test/sdkHarness');
 const {WorkerAuth}=await import('../../cloud/lambdas/delegated-worker/src/workerAuth');
 const {createWorkerHandler}=await import('../../cloud/lambdas/delegated-worker/src/handler');
 const {AccountRepository}=await import('../../src/main/domain/accounts/accountRepository');
 const {accountFingerprint}=await import('../../src/main/domain/accounts/accountEvidence');
 const {randomUUID}=await import('node:crypto');
 let now=PM_NOW;const clock={now:()=>now};
 const auth=new WorkerAuth({dynamo:new ConditionalCommandHarness(),tableName:'fictional',workspaceId:'ws',clock});
 const redeemed=await auth.redeemPairing((await auth.issuePairing({scopes:['commands:write','events:read'],expiresInSeconds:300})).code,'fictional');
 const handler=createWorkerHandler({auth,host:'worker.example.test'});
 let hold=false;const sent:string[]=[];
 const http:typeof fetch=async(input,init)=>{
  const u=new URL(String(input));
  if(u.pathname==='/commands'&&init?.body){const raw=JSON.parse(String(init.body));if(raw.kind==='refresh-selected-account-record'){sent.push(raw.commandId);if(hold)throw Error('fictional owner unavailable');}}
  const reply=await handler({version:'2.0',rawPath:u.pathname,rawQueryString:u.search.slice(1),headers:{host:u.host,'x-forwarded-proto':'https',authorization:new Headers(init?.headers).get('authorization')??''},body:init?.body,requestContext:{domainName:u.host,http:{method:init?.method??'GET',sourceIp:'fictional'}}});
  return new Response(reply.body,{status:reply.statusCode});
 };
 const runtime=createDelegationRuntime({databaseGate:{withDatabase:async fn=>fn(f.db)},pairing:{...redeemed,endpoint:pair.endpoint},clock,fetch:http});
 const accounts=new AccountRepository({database:f.db,clock,ids:{next:randomUUID},sourcePolicy:{attest:source=>source.url==='https://example.invalid/team'}});
 const ids=['a1','a2','a3','a4'].map(suffix=>`aaaaaaaa-aaaa-4aaa-8aaa-${suffix.padEnd(12,'0')}`);
 try{
  const account=accounts.create({commandId:randomUUID(),name:'Selected Fictional PM',domain:null});
  const workerRecord=async()=>(await auth.store.get<{routes:{id:string}[];sources:{id:string}[];researchRevision:number;account:{version:number}}>(`ACCOUNT#${account.id}`))!.data;
  const researchCursor=()=>f.db.raw.prepare("SELECT aggregate_version FROM delegated_event_cursors WHERE workspace_id='ws' AND account_id=? AND stream='research'").get(account.id);
  // Before any copy exists the freshness is honestly unknown; before the worker owns the company nothing is sent.
  expect(await runtime.getSelectedAccountFreshness({accountId:account.id})).toMatchObject({accountId:account.id,state:'unknown',sentFingerprint:null,sentAt:null});
  expect((await runtime.bootstrap({commandId:randomUUID(),accountId:account.id})).status).toBe('applied');
  await expect(runtime.refreshSelectedAccount({commandId:ids[0]!,accountId:account.id})).rejects.toThrow('refresh_owner_inactive');
  expect(sent).toEqual([]);
  await runtime.submit({commandId:randomUUID(),workspaceId:'ws',accountId:account.id,expectedAuthorityGeneration:0,expectedVersion:1,kind:'delegate',payload:{delegationId:'explicit',approvedAt:PM_NOW}});await runtime.sync();
  expect(await runtime.getSelectedAccountFreshness({accountId:account.id})).toMatchObject({state:'current',sentAt:PM_NOW});
  // A local admission changes the saved record; the worker's copy is now behind.
  now='2026-09-08T12:01:00.000Z';
  accounts.admitEvidence({commandId:randomUUID(),accountId:account.id,expectedVersion:1,sources:[{id:'local-source',url:'https://example.invalid/team',fetchedAt:now,sha256:'a'.repeat(64),excerpt:'Fictional published phone',permitted:true}],claims:[],routes:[{id:'local-route',accountId:account.id,personId:null,channel:'phone',value:'+12025550123',purpose:'business',evidenceIds:['local-source'],verification:'published'}]});
  const stale=await runtime.getSelectedAccountFreshness({accountId:account.id});
  expect(stale).toMatchObject({state:'stale',sentAt:PM_NOW});expect(stale.localFingerprint).not.toBe(stale.sentFingerprint);
  expect((await workerRecord()).routes).toEqual([]);
  // Lost response: the command stays pending under its own id; a different id is a conflict, the same id is reused.
  hold=true;
  expect(await runtime.refreshSelectedAccount({commandId:ids[1]!,accountId:account.id})).toMatchObject({commandId:ids[1],status:'pending'});
  await expect(runtime.refreshSelectedAccount({commandId:ids[2]!,accountId:account.id})).rejects.toThrow('refresh_command_conflict');
  await expect(runtime.refreshSelectedAccount({commandId:ids[1]!,accountId:'other-account'})).rejects.toThrow('refresh_command_conflict');
  hold=false;
  const applied=await runtime.refreshSelectedAccount({commandId:ids[1]!,accountId:account.id});
  expect(applied).toMatchObject({commandId:ids[1],status:'applied',authorityGeneration:1});
  expect(new Set(sent)).toEqual(new Set([ids[1]]));expect(sent.length).toBeGreaterThanOrEqual(2);
  expect((await workerRecord()).routes.map(route=>route.id)).toEqual(['local-route']);
  expect(await workerRecord()).toMatchObject({researchRevision:1,account:{version:2}});
  const current=await runtime.getSelectedAccountFreshness({accountId:account.id});
  expect(current).toMatchObject({state:'current',sentAt:now});expect(current.sentFingerprint).toBe(current.localFingerprint);
  const {DelegationRepository}=await import('../../src/main/delegation/delegationRepository');
  const stored=new DelegationRepository({database:f.db,workspaceId:'ws',clock}).getCommand(ids[1]!);
  if(stored?.kind!=='refresh-selected-account-record')throw Error('stored refresh command missing');
  expect(stored).toMatchObject({expectedAuthorityGeneration:1,expectedVersion:2,payload:{expectedResearchRevision:1,asOf:now}});
  expect(accountFingerprint(stored.payload.record)).toBe(current.sentFingerprint);
  // The research cursor is untouched: a refresh is bound to it, never a second bootstrap.
  expect(researchCursor()).toEqual({aggregate_version:1});
  // Sending an unchanged record again is applied with duplicate semantics and keeps the freshness current.
  expect(await runtime.refreshSelectedAccount({commandId:ids[3]!,accountId:account.id})).toMatchObject({commandId:ids[3],status:'applied'});
  expect(await runtime.getSelectedAccountFreshness({accountId:account.id})).toMatchObject({state:'current'});
  // A saved record over 64 KiB rides the gateway's saved-record allowance (204096-byte body, 200000-byte payload): applied, not refused.
  now='2026-09-08T12:02:00.000Z';
  accounts.admitEvidence({commandId:randomUUID(),accountId:account.id,expectedVersion:2,claims:[],routes:[],sources:['b','c','d','e','f','0'].map(digit=>({id:`large-${digit}`,url:'https://example.invalid/team',fetchedAt:now,sha256:digit.repeat(64),excerpt:digit.repeat(11000),permitted:true}))});
  expect(await runtime.getSelectedAccountFreshness({accountId:account.id})).toMatchObject({state:'stale'});
  const largeId='aaaaaaaa-aaaa-4aaa-8aaa-a50000000000';
  expect(await runtime.refreshSelectedAccount({commandId:largeId,accountId:account.id})).toMatchObject({commandId:largeId,status:'applied'});
  const repository=new DelegationRepository({database:f.db,workspaceId:'ws',clock});
  expect(Buffer.byteLength(JSON.stringify(repository.getCommand(largeId)),'utf8')).toBeGreaterThan(65536);
  expect((await workerRecord()).sources.map(source=>source.id).sort()).toEqual(['large-0','large-b','large-c','large-d','large-e','large-f','local-source']);
  expect(await runtime.getSelectedAccountFreshness({accountId:account.id})).toMatchObject({state:'current'});
  // A record the gateway would refuse on every retry (payload over 200000 bytes) is never queued: no stuck identity, no HTTP.
  const attempts=sent.length;const tooLargeId='aaaaaaaa-aaaa-4aaa-8aaa-a60000000000';
  vi.mocked(exportSelectedAccountRecord).mockImplementationOnce(input=>{const record=snapshotModule.actual!.exportSelectedAccountRecord(input);return {...record,sources:[...record.sources,...Array.from({length:12},(_,index)=>({id:`over-${index}`,url:'https://example.invalid/team',fetchedAt:now,sha256:'d'.repeat(64),excerpt:'y'.repeat(12000),permitted:true}))]};});
  await expect(runtime.refreshSelectedAccount({commandId:tooLargeId,accountId:account.id})).rejects.toThrow('refresh_record_too_large');
  expect(repository.pendingCommands()).toEqual([]);expect(repository.getCommand(tooLargeId)).toBeNull();expect(sent).toHaveLength(attempts);
  expect(await auth.store.list('GOOGLE_GRANT#')).toEqual([]);
 }finally{await runtime.dispose();f.close();}
});

it('refuses a resubmission the worker gateway could never admit, on the payload limit or the whole-body limit, counting UTF-8 bytes',()=>{
 expect(REFRESH_COMMAND_LIMITS).toEqual({maxBodyBytes:204096,maxPayloadBytes:200000});
 const payload=(length:number)=>({record:'a'.repeat(length)});
 const within={commandId:'x',payload:payload(REFRESH_COMMAND_LIMITS.maxPayloadBytes-13)};
 expect(Buffer.byteLength(JSON.stringify(within.payload),'utf8')).toBe(REFRESH_COMMAND_LIMITS.maxPayloadBytes);
 expect(()=>assertRefreshCommandTransportable(within)).not.toThrow();
 expect(()=>assertRefreshCommandTransportable({commandId:'x',payload:payload(REFRESH_COMMAND_LIMITS.maxPayloadBytes-12)})).toThrow('refresh_record_too_large');
 const bodyOver={commandId:'x'.repeat(4200),payload:within.payload};
 expect(Buffer.byteLength(JSON.stringify(bodyOver),'utf8')).toBeGreaterThan(REFRESH_COMMAND_LIMITS.maxBodyBytes);
 expect(()=>assertRefreshCommandTransportable(bodyOver)).toThrow('refresh_record_too_large');
 // 70000 three-byte characters are 210000 bytes although the string is well under the limit in characters.
 expect(()=>assertRefreshCommandTransportable({commandId:'x',payload:{record:'界'.repeat(70000)}})).toThrow('refresh_record_too_large');
});
