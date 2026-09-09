import {expect,it,vi} from 'vitest';
import {createPmFixture,PM_NOW} from '../fixtures/pmAccounts';
import {createDelegationRuntime} from '../../src/main/delegation/delegationRuntime';
import type {StoredPairing} from '../../src/main/delegation/pairingStore';
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
  expect(runtime.linkedIn).not.toBeNull();
  await expect(runtime.linkedIn!.recover({draftId:'missing-fictional-draft',expectedRevision:1})).rejects.toThrow('draft_missing');
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
