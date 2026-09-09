import {createDelegatedPhoneHandoff} from './executionRouter';
import {createInboundReadiness,type InboundRegistry,type InboundAdapter,type OutboundSubject} from '../communications/inboundReadiness';
import {createRuntimeLinkedInApi} from '../linkedin/linkedInService';
import {exportSelectedAccountRecord} from './selectedAccountSnapshot';
import { randomUUID } from 'node:crypto';
import {accountFingerprint} from '../domain/accounts/accountEvidence';
import type {AppDatabase} from '../db/database';
import type {StoredPairing} from './pairingStore';
import {DelegationRepository} from './delegationRepository';
import {SqlDelegationConfiguration,SqlDelegationTransport} from './delegationSync';
import {ExecutionClient} from './executionClient';
import {delegatedPhoneHandoffRequestSchema,bootstrapSelectedAccountSchema,bootstrapSelectedAccountCommandSchema,configureLocalDelegationSchema,localDelegationStatusSchema} from '../../shared/contracts/ownerCommandContract';
import {delegationCommandSchema,type DelegatedPhoneHandoffResult} from '../../shared/contracts/delegationContract';
/** Every repository belongs to a live FoundationRuntime operation lease. No DB
 * handle survives its callback. Local lock aborts work, never revokes the owner. */
export function createDelegationRuntime(input:{databaseGate:{withDatabase<T>(fn:(database:AppDatabase)=>T|Promise<T>):Promise<T>};pairing:StoredPairing|null;clock:{now():string};fetch?:typeof globalThis.fetch;phone?:Parameters<typeof createDelegatedPhoneHandoff>[0]['phone'];inboundRegistry?:InboundRegistry;linkedIn?:Pick<Parameters<typeof createRuntimeLinkedInApi>[0],'provider'|'productFacts'|'shell'|'clipboard'>;configurationChanged?:()=>void|Promise<void>}) {
 const pairing=input.pairing?Object.freeze({...input.pairing,scopes:Object.freeze([...input.pairing.scopes])}):null;
 let lifetime=new AbortController();let locked=false;let closed=false;
 const flights=new Set<Promise<unknown>>();
 const proofs:{id:string;subject:string;check:()=>boolean;release:()=>void}[]=[];
 const invalidate=(lock?:boolean)=>{for(const proof of [...proofs])proof.release();lifetime.abort();lifetime=new AbortController();if(lock!==undefined)locked=lock;};
 function assertCurrent(signal:AbortSignal){if(closed||locked||signal.aborted)throw Error('delegation_inactive');}
 function run<T>(fn:(database:AppDatabase,signal:AbortSignal)=>T|Promise<T>):Promise<T>{
  const signal=lifetime.signal;
  const result=input.databaseGate.withDatabase(async database=>{assertCurrent(signal);const value=await fn(database,signal);assertCurrent(signal);return value;});
  flights.add(result);void result.finally(()=>flights.delete(result)).catch(():undefined=>undefined);return result;
 }
 function services(database:AppDatabase,signal:AbortSignal){
  if(!pairing)throw Error('pairing_unconfigured');
  const options={database,workspaceId:pairing.workspaceId,pairingId:pairing.pairingId,clock:input.clock};
  const configuration=new SqlDelegationConfiguration(options);
  const repository=new DelegationRepository({...options,sourcePolicy:{attest:source=>configuration.read()?.configuration.research?.permittedSources.includes(source.url)===true}});
  const transport=new SqlDelegationTransport(options);
  const client=new ExecutionClient({repository,transport,pairing:{endpoint:pairing.endpoint,workspaceId:pairing.workspaceId,credential:pairing.credential},fetch:input.fetch,signal});
  return {repository,transport,client,configuration};
 }
 function createAdapter(handoffId?:string):InboundAdapter{return {id:'delegated-worker-mail',relevant:()=>pairing!==null,
  synchronize:(subject:OutboundSubject,external:AbortSignal)=>new Promise<{revision:string}>((resolve,reject)=>{
   const active=AbortSignal.any([lifetime.signal,external,AbortSignal.timeout(15000)]);
   void run(async(database,signal)=>{
    assertCurrent(active);const current=services(database,signal);
    const accounts=subject.kind==='account'?[subject.id]:(database.raw.prepare('SELECT DISTINCT account_id FROM pm_account_routes WHERE person_id=? LIMIT 11').all(subject.id) as {account_id:string}[]).map(row=>row.account_id);
    if(accounts.length===0||accounts.length>10)throw Error('subject_scope_unavailable');
    const handoff=handoffId?current.repository.getManualHandoff(handoffId):null;
    if(handoffId&&(!handoff||handoff.consumedAt!==null||accounts.length!==1||accounts[0]!==handoff.accountId||Date.parse(handoff.expiresAt)<=Date.parse(input.clock.now())))throw Error('handoff_not_current');
    const configuration=current.configuration.read();if(!configuration||configuration.configuration.state!=='active')throw Error('delegation_inactive');
    if(!(await current.client.sync(active)).ownerFresh)throw Error('owner_not_current');
    const checkpoints:Awaited<ReturnType<ExecutionClient['checkpoint']>>[]=[];
    let expires=Math.min(Date.parse(input.clock.now())+5000,handoff?Date.parse(handoff.expiresAt):Infinity);
    for(const accountId of accounts){const checkpoint=await current.client.checkpoint(accountId,active,handoffId);expires=Math.min(expires,checkpoint.validUntil);checkpoints.push(checkpoint);}
    if(!(await current.client.sync(active)).ownerFresh)throw Error('owner_not_current');
    for(const checkpoint of checkpoints){const authority=current.repository.authority(checkpoint.accountId);if(authority?.generation!==checkpoint.generation||current.repository.executionVersion(checkpoint.accountId)!==checkpoint.version)throw Error('checkpoint_changed');}
    const snapshot=()=>accountFingerprint({handoff:handoffId?current.repository.getManualHandoff(handoffId):null,configuration:current.configuration.read(),transport:current.transport.current(),accounts:accounts.map(accountId=>({authority:current.repository.authority(accountId),version:current.repository.executionVersion(accountId),pending:current.repository.pendingCommands().filter(c=>c.accountId===accountId),suppressed:database.raw.prepare('SELECT 1 FROM pm_account_suppression_tombstones WHERE account_id=?').get(accountId)??null}))});
    for(const accountId of accounts){const owner=current.repository.authority(accountId);if(!owner||owner.owner!=='worker'||owner.state!=='active'||current.repository.hasPendingStop(accountId))throw Error('owner_not_current');}
    const before=snapshot();assertCurrent(active);const id=randomUUID();let release!:()=>void;const held=new Promise<void>(done=>{release=done;});
    // The check controller is intentionally disposed by A1 after synchronization.
    // Established proof belongs to the operation lease, not that completed check.
    let reader:(()=>boolean)|null=()=>{try{assertCurrent(signal);return Date.parse(input.clock.now())<expires&&snapshot()===before;}catch{return false;}};
    const proof={id,subject:accountFingerprint(subject),check:()=>reader?.()??false,release:()=>{reader=null;const index=proofs.indexOf(proof);if(index>=0)proofs.splice(index,1);if(timer)clearTimeout(timer);signal.removeEventListener('abort',proof.release);release();}};
    proofs.push(proof);signal.addEventListener('abort',proof.release,{once:true});const timer=setTimeout(proof.release,Math.max(0,Math.min(5000,expires-Date.parse(input.clock.now()))));timer.unref();
    if(active.aborted){proof.release();throw Error('delegation_inactive');}resolve({revision:id});await held;
   }).catch(reject);
  }),
  isAppliedCurrent:(subject,revision)=>proofs.find(proof=>proof.id===revision&&proof.subject===accountFingerprint(subject))?.check()??false,
 };}
 const adapter=createAdapter();
 const readinessForHandoff=(handoffId:string)=>{const scoped=createAdapter(handoffId);return createInboundReadiness({snapshot:()=>{const snapshot=input.inboundRegistry?.snapshot();if(!snapshot||!snapshot.adapters.includes(adapter))return {initialized:false,revision:snapshot?.revision??0,adapters:[]};return {...snapshot,adapters:snapshot.adapters.map(current=>current===adapter?scoped:current)};}});};
 return {
  adapter,
  readinessForHandoff,
  beginPhone:(raw:unknown):Promise<DelegatedPhoneHandoffResult>=>{const request=delegatedPhoneHandoffRequestSchema.parse(raw);return run((database,signal)=>{if(!input.phone||!pairing)return {status:'held',reason:'phone_unconfigured'};return createDelegatedPhoneHandoff({database,...services(database,signal),phone:input.phone,readinessForHandoff,clock:input.clock,signal,expectedWorkspaceId:pairing.workspaceId}).begin(request);});},
  linkedIn:pairing?createRuntimeLinkedInApi({...input.linkedIn,databaseGate:{withDatabase:run},workspaceId:pairing.workspaceId,clock:input.clock,ownerFactory:(database,signal)=>services(database,signal)}):null,
  invalidate,
  status:async()=>!pairing?localDelegationStatusSchema.parse({state:'unconfigured',workspaceId:null,endpoint:null,configuration:null}):locked||closed?localDelegationStatusSchema.parse({state:'locked',workspaceId:pairing.workspaceId,endpoint:pairing.endpoint,configuration:null}):run((database,signal)=>{
    const config=services(database,signal).configuration.read();return localDelegationStatusSchema.parse({state:locked?'locked':config?.configuration.state??'paused',workspaceId:pairing.workspaceId,endpoint:pairing.endpoint,configuration:config});
  }),
  configure:(raw:unknown)=>{const command=configureLocalDelegationSchema.parse(raw);invalidate();return run(async(database,signal)=>{const result=services(database,signal).configuration.configure(command);await input.configurationChanged?.();return result;});},
  bootstrap:(raw:unknown)=>{const request=bootstrapSelectedAccountSchema.parse(raw);invalidate();return run(async(database,signal)=>{
    const current=services(database,signal);if(!pairing)throw Error('pairing_unconfigured');
    const previous=current.repository.getCommand(request.commandId);
    if(previous&&(previous.kind!=='bootstrap-selected-account'||previous.accountId!==request.accountId))throw Error('bootstrap_command_conflict');
    const cursor=database.raw.prepare("SELECT aggregate_version FROM delegated_event_cursors WHERE workspace_id=? AND account_id=? AND stream='research'").get(pairing.workspaceId,request.accountId) as {aggregate_version:number}|undefined;
    const record=previous?.kind==='bootstrap-selected-account'?previous.payload.record:exportSelectedAccountRecord({database,workspaceId:pairing.workspaceId,accountId:request.accountId,asOf:input.clock.now(),researchRevision:cursor?.aggregate_version??1});
    if(!previous)current.repository.initializeLocalAuthority(request.accountId);
    const suppression=(database.raw.prepare('SELECT id,observed_at AS observedAt,source,evidence_ref AS evidenceRef FROM pm_account_suppression_tombstones WHERE account_id=? LIMIT 101').all(request.accountId));
    const command=previous??bootstrapSelectedAccountCommandSchema.parse({...request,workspaceId:pairing.workspaceId,expectedAuthorityGeneration:0,expectedVersion:0,kind:'bootstrap-selected-account',payload:{record,asOf:input.clock.now(),expectedResearchRevision:cursor?.aggregate_version??null,suppression}});
    await current.client.submit(command);await current.client.sync(signal);const receipt=current.repository.commandStatus(request.commandId);if(!receipt)throw Error('bootstrap_receipt_missing');return receipt;
  });},
  submit:(raw:unknown)=>{const command=delegationCommandSchema.parse(raw);invalidate();return run((database,signal)=>services(database,signal).client.submit(command));},
  sync:()=>run((database,signal)=>services(database,signal).client.sync(AbortSignal.any([signal,AbortSignal.timeout(15000)]))),
  configurePolicy:(raw:unknown)=>run((database,signal)=>services(database,signal).client.configurePolicy(raw,signal)),
  configureResearch:(raw:unknown)=>run((database,signal)=>services(database,signal).client.configureResearch(raw,signal)),
  async dispose(){closed=true;invalidate(true);await Promise.allSettled([...flights]);},
 };
}
export type DelegationRuntime=ReturnType<typeof createDelegationRuntime>;
