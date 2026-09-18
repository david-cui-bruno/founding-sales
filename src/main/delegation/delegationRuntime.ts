import { getAccountPreparationSchema } from '../../shared/contracts/accountPreparationContract';
import { reconcileReplyDraftSchema, editReplyDraftSchema, boundReplyDraftResult, type ReconcileReplyDraft, type EditReplyDraft } from '../../shared/contracts/mailThreadContract';
import { SqlThreadIntakeRepository } from '../outreach/threadIntakeRepository';
import { delegatedPhoneStateRequestSchema, type GetPhoneHandoffStateRequest } from '../../shared/contracts/delegatedPhoneStateContract';
import { readDelegatedPhoneHandoffState } from './delegatedPhoneState';
import { z } from 'zod';
import {googleConnectionSelectorSchema,googleConsentOpenedSchema,selectedGooglePurpose,type RemoteGoogleConnectionsApi} from '../../shared/contracts/remoteGoogleConnectionsContract';
import {remoteGoogleGrantBeginSchema} from '../../shared/contracts/remoteGoogleGrantContract';
import {createAccountRoutePolicyImport,type AccountRoutePolicyImportDependencies} from './accountRoutePolicyImport';
import {SqlRequestedFollowupRepository} from '../outreach/requestedFollowupRepository';
import {createRequestedFollowupService} from '../outreach/requestedFollowupService';
import {prepareRequestedFollowupSchema,getRequestedFollowupSchema,editRequestedFollowupSchema,approveRequestedFollowupSchema,requestedFollowupDraftSchema,requestedApprovalStatusSchema,type PrepareRequestedFollowup,type GetRequestedFollowup,type EditRequestedFollowup,type ApproveRequestedFollowup,type RequestedFollowupDraft} from '../../shared/contracts/requestedFollowupContract';
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
import {ExecutionClient,SYNC_BUDGET_MS,createResearchSetupTransport,createAccountPreparationTransport} from './executionClient';
import {createResearchSetupService,awaitResearchSetupOperation} from './researchSetupService';
import type {ResearchSetupRequestStore} from './researchSetupRequestStore';
import type {ResearchSetupApi} from '../../shared/contracts/researchSetupContract';
import {approveRequestedFollowupCommandSchema,configureOwnerCommandSchema,ownerSourceConfigurationSchema,delegatedPhoneHandoffRequestSchema,bootstrapSelectedAccountSchema,bootstrapSelectedAccountCommandSchema,refreshSelectedAccountRecordSchema,refreshSelectedAccountRecordCommandSchema,selectedAccountFreshnessRequestSchema,selectedAccountFreshnessSchema,configureLocalDelegationSchema,localDelegationStatusSchema,territoryPolicyCommandSchema} from '../../shared/contracts/ownerCommandContract';
import {configureAccountIntakeSchema,accountIntakeConfigureStatusSchema,type ConfigureAccountIntake,type AccountIntakeHoldReason} from '../../shared/contracts/accountIntakeConfigureContract';
import {googleScopes} from '../../shared/contracts/googleGrantCapabilities';
import {publicDelegationCommandSchema,type DelegatedPhoneHandoffResult,type DelegationCommand} from '../../shared/contracts/delegationContract';
import {DEFAULT_TERRITORY_CALL_POLICY_DEFINITION,TERRITORY_CALL_POLICY_SUBJECT,territoryCallPolicyRequestSchema,territoryCallPolicyStatusSchema,type TerritoryCallPolicyCommandPayload} from '../../shared/contracts/territoryCallPolicyContract';
/** What the worker gateway (cloud/lambdas/delegated-worker/src/handler.ts) admits on POST /commands for a saved-record
 * command: the whole body up to 204096 bytes and the payload up to 200000 bytes, both counted in UTF-8. */
export const REFRESH_COMMAND_LIMITS=Object.freeze({maxBodyBytes:204096,maxPayloadBytes:200000});
/** A resubmission the gateway would refuse on every retry is never queued, so no unsendable identity can hold the company. */
export function assertRefreshCommandTransportable(command:{commandId:string;payload:unknown}):void{
 if(Buffer.byteLength(JSON.stringify(command.payload),'utf8')>REFRESH_COMMAND_LIMITS.maxPayloadBytes||Buffer.byteLength(JSON.stringify(command),'utf8')>REFRESH_COMMAND_LIMITS.maxBodyBytes)throw Error('refresh_record_too_large');
}
type ConfigureOwnerCommand=Extract<DelegationCommand,{kind:'configure-owner'}>;
/** The founder-visible binding of one intake change: the revision read, the target state, mailbox,
 * calendar and mail start. The same binding reuses the live command; a different binding against a
 * pending change is refused, never a second command. Research and the scope envelope are bound by the runtime. */
function intakeBinding(value:ConfigureOwnerCommand|ConfigureAccountIntake):string{
 if('kind' in value){const p=value.payload;return accountFingerprint({expectedConfigurationRevision:p.expectedConfigurationRevision,state:p.configuration.state,mailboxSubject:p.configuration.mailboxSubject,calendarId:p.configuration.calendarId,mailSince:p.mailScope?.since??null});}
 return accountFingerprint({expectedConfigurationRevision:value.expectedConfigurationRevision,state:value.state,mailboxSubject:value.mailboxSubject,calendarId:value.calendarId,mailSince:value.mailSince});
}
function intakeStatus(repository:DelegationRepository,command:ConfigureOwnerCommand){
 const receipt=repository.commandStatus(command.commandId);if(!receipt)throw Error('intake_receipt_missing');const p=command.payload;
 return accountIntakeConfigureStatusSchema.parse({status:'queued',accountId:command.accountId,commandId:command.commandId,expectedConfigurationRevision:p.expectedConfigurationRevision,configuration:p.configuration,mailScope:p.mailScope,receipt});
}
/** Every repository belongs to a live FoundationRuntime operation lease. No DB
 * handle survives its callback. Local lock aborts work, never revokes the owner. */
export function createDelegationRuntime(input:{databaseGate:{withDatabase<T>(fn:(database:AppDatabase)=>T|Promise<T>):Promise<T>};pairing:StoredPairing|null;clock:{now():string};fetch?:typeof globalThis.fetch;phone?:Parameters<typeof createDelegatedPhoneHandoff>[0]['phone'];inboundRegistry?:InboundRegistry;linkedIn?:Pick<Parameters<typeof createRuntimeLinkedInApi>[0],'provider'|'productFacts'|'shell'|'clipboard'>;policyImportNative?:AccountRoutePolicyImportDependencies['native'];requestedModel?:()=>Promise<NonNullable<Parameters<typeof createRequestedFollowupService>[0]['model']>|undefined>;configurationChanged?:()=>void|Promise<void>;openGoogleConsent?:(url:string)=>Promise<void>;researchSetupStore?:ResearchSetupRequestStore}) {
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
 // Google reads never synchronize/configure delegation or acquire sending authority.
 function googleRun<T>(fn:(client:ExecutionClient,signal:AbortSignal)=>Promise<T>):Promise<T>{
  return run(async(database,signal)=>{
   const active=AbortSignal.any([signal,AbortSignal.timeout(15000)]);
   assertCurrent(active);const {client}=services(database,active);
   const value=await fn(client,active);assertCurrent(active);return value;
  });
 }
 // Native opening has no AbortSignal API. Bound our wait and lease, even if the
 // platform opener never settles. A late completion cannot publish success.
 async function openConsent(url:string,signal:AbortSignal):Promise<void>{
  assertCurrent(signal);
  let abort!:()=>void;
  const cancelled=new Promise<never>((_resolve,reject)=>{abort=()=>reject(Error('delegation_inactive'));signal.addEventListener('abort',abort,{once:true});});
  try{await Promise.race([input.openGoogleConsent!(url),cancelled]);assertCurrent(signal);}
  finally{signal.removeEventListener('abort',abort);}
 }
 const googleConnections:RemoteGoogleConnectionsApi={
  status:async raw=>{const request=googleConnectionSelectorSchema.parse(raw);return googleRun((client,signal)=>client.googleGrantStatus(request.purpose,signal));},
  disclosure:async raw=>{const request=googleConnectionSelectorSchema.parse(raw);return googleRun((client,signal)=>client.googleGrantDisclosure(request.purpose,signal));},
  begin:async raw=>{
   const request=remoteGoogleGrantBeginSchema.parse(raw);
   if(!input.openGoogleConsent)throw Error('google_consent_opener_unavailable');
   invalidate();
   return googleRun(async(client,signal)=>{
    const result=await client.beginGoogleGrant(request,signal);
    assertCurrent(signal);await openConsent(result.authorizationUrl,signal);assertCurrent(signal);
    return googleConsentOpenedSchema.parse({state:'consent_opened',purpose:selectedGooglePurpose(request.purpose)});
   });
  },
  revoke:async raw=>{const request=googleConnectionSelectorSchema.parse(raw);invalidate();return googleRun((client,signal)=>client.revokeGoogleGrant(request.purpose,signal));},
 };
 const researchExtension:{researchSetup?:ResearchSetupApi}={researchSetup:createResearchSetupService({
  identity:pairing?{endpoint:pairing.endpoint,workspaceId:pairing.workspaceId,pairingId:pairing.pairingId}:null,
  store:input.researchSetupStore,clock:input.clock,
  transport:()=>{if(!pairing)throw Error('pairing_unconfigured');return createResearchSetupTransport({pairing:{endpoint:pairing.endpoint,workspaceId:pairing.workspaceId,pairingId:pairing.pairingId,credential:pairing.credential},fetch:input.fetch});},
  withOperation:operation=>run(async(_database,signal)=>{
   const active=AbortSignal.any([signal,AbortSignal.timeout(15000)]);assertCurrent(active);
   // No repository or database handle enters the abortable continuation.
   return awaitResearchSetupOperation(()=>operation(active),active);
  }),
 })};
 const contextInput=(draft:RequestedFollowupDraft):PrepareRequestedFollowup=>({accountId:draft.accountId,originalCall:draft.originalCall,recipientBinding:draft.recipientBinding,expectedAccountVersion:draft.accountVersion,mode:'manual'});
 function savedDraft(database:AppDatabase,accountId:string,draftId:string){
  const row=database.raw.prepare('SELECT draft_json FROM delegated_requested_followup_drafts WHERE workspace_id=? AND account_id=? AND id=?').get(pairing!.workspaceId,accountId,draftId) as {draft_json:string}|undefined;
  return row?requestedFollowupDraftSchema.parse(JSON.parse(row.draft_json)):null;
 }
 async function requestedServices(database:AppDatabase,signal:AbortSignal,request:PrepareRequestedFollowup){
  const current=services(database,signal), active=AbortSignal.any([signal,AbortSignal.timeout(15000)]);
  if(!(await current.client.sync(active)).ownerFresh)throw Error('requested_owner_unavailable');
  const proof=await current.client.requestedContext(request,active);
  if(!(await current.client.sync(active)).ownerFresh)throw Error('requested_owner_unavailable');
  const semantic=(value:PrepareRequestedFollowup)=>({accountId:value.accountId,originalCall:value.originalCall,recipientBinding:value.recipientBinding,expectedAccountVersion:value.expectedAccountVersion,mode:'manual'});
  const transport=accountFingerprint(current.transport.current()), binding=accountFingerprint(semantic(request));
  const store=new SqlRequestedFollowupRepository({database,workspaceId:pairing!.workspaceId,clock:input.clock,mailbox:()=>proof.mailbox,ownerContext:actual=>{
   assertCurrent(active);
   if(accountFingerprint(semantic(actual))!==binding||accountFingerprint(current.transport.current())!==transport||current.repository.hasPendingStop(request.accountId))throw Error('requested_context_changed');
   return {...proof,cursor:proof.cursor??null};
  }});
  // Fail before generation or mutation. The same synchronous closure is checked again by every SQL reader.
  store.readContext(request);
  const editStore={readContext:store.readContext.bind(store),get:store.get.bind(store),save:async(draft:RequestedFollowupDraft,expectedRevision:number|null)=>{
   const previous=expectedRevision===null?null:savedDraft(database,draft.accountId,draft.id);
   if(expectedRevision!==null&&(!previous||previous.revision!==expectedRevision))throw Error('stale_requested_draft');
   const canonical=previous?await current.client.requestedDraft(previous,draft,active):draft;
   assertCurrent(active);return store.save(canonical,expectedRevision);
  }};
  return {store,current,service:createRequestedFollowupService({store:editStore,clock:input.clock,id:randomUUID,model:request.mode==='model'?await input.requestedModel?.():undefined})};
 }
 function ordinaryReply(raw: ReconcileReplyDraft | EditReplyDraft, editing: boolean) {
  const editRequest = editing ? editReplyDraftSchema.parse(raw) : null;
  const request = editRequest ?? reconcileReplyDraftSchema.parse(raw);
  return run(async (database, signal) => {
   const active = AbortSignal.any([signal, AbortSignal.timeout(15000)]), current = services(database, active);
   const store = new SqlThreadIntakeRepository({ database, workspaceId: pairing!.workspaceId, clock: input.clock });
   const saved = store.getReplyDraft(request.accountId, request.draftId);
   if (!saved) throw Error('reply_draft_missing');
   const prior = saved.draft, authority = current.repository.authority(prior.accountId);
   const configuration = accountFingerprint(current.configuration.read());
   const assertOwner = () => {
    assertCurrent(active);
    const owner = current.repository.authority(prior.accountId);
    if (!authority || owner?.owner !== 'worker' || owner.state !== 'active' || owner.generation !== authority.generation || current.repository.hasPendingStop(prior.accountId) || accountFingerprint(current.configuration.read()) !== configuration) throw Error('reply_owner_changed');
   };
   assertOwner();
   let edit: { subject: string; body: string } | undefined;
   if (editRequest) {
    const request = editRequest;
    if (prior.threadRevision !== request.expectedThreadRevision || prior.contextRevision !== request.expectedContextRevision) throw Error('stale_thread');
    if (prior.revision === request.expectedRevision) edit = { subject: request.subject, body: request.body };
    else if (prior.revision !== request.expectedRevision + 1 || prior.subject !== request.subject || prior.body !== request.body || prior.generation !== 'edited') throw Error('stale_draft');
   }
   const result = await current.client.replyDraft({ workspaceId: pairing!.workspaceId, expectedAuthorityGeneration: authority!.generation, previousDraft: prior, ...(edit ? { edit } : {}) }, active);
   assertOwner();
   // Bind the requested revision/text before any local acknowledgement mutation.
   boundReplyDraftResult(editRequest ?? request).parse(result);
   const canonical = store.reconcileReplyDraft(prior, result.draft, assertOwner);
   return boundReplyDraftResult(editRequest ?? request).parse({ ...canonical, stale: canonical.stale || result.stale, capability: 'held' });
  });
 }
 function createAdapter(handoffId?:string):InboundAdapter{return {id:'delegated-worker-mail',relevant:()=>pairing!==null,
  synchronize:(subject:OutboundSubject,external:AbortSignal)=>new Promise<{revision:string}>((resolve,reject)=>{
   const active=AbortSignal.any([lifetime.signal,external,AbortSignal.timeout(15000)]);
   void run(async(database,signal)=>{
    assertCurrent(active);const current=services(database,signal);
    // Applicability is resolved under this live lease, not by caching a SQL
    // handle in A1's synchronous relevant(). Local proof is never HTTP fallback.
    const accountIds=()=>subject.kind==='account'?[subject.id]:(database.raw.prepare('SELECT DISTINCT account_id FROM pm_account_routes WHERE person_id=? ORDER BY account_id LIMIT 11').all(subject.id) as {account_id:string}[]).map(row=>row.account_id);
    const person=()=>subject.kind==='person'?database.raw.prepare('SELECT id FROM persons WHERE id=?').get(subject.id)??null:null;
    const accounts=accountIds();if(accounts.length>10||(subject.kind==='person'&&!person()))throw Error('subject_scope_unavailable');
    const workerAccounts:string[]=[];
    for(const accountId of accounts){
      if(!database.raw.prepare('SELECT id FROM pm_accounts WHERE id=?').get(accountId))throw Error('subject_scope_unavailable');
      const owner=current.repository.authority(accountId);
      if(owner?.owner==='local'&&owner.state==='local'){
        if(current.repository.pendingCommands().some(command=>command.accountId===accountId)||current.repository.hasPendingStop(accountId))throw Error('owner_not_current');
      }else if(owner?.owner==='worker'&&owner.state==='active'&&!current.repository.hasPendingStop(accountId))workerAccounts.push(accountId);
      else throw Error('owner_not_current');
    }
    const localScope=()=>accountFingerprint({accounts:accountIds(),person:person(),local:accounts.filter(id=>!workerAccounts.includes(id)).map(id=>({authority:current.repository.authority(id),pending:current.repository.pendingCommands().filter(command=>command.accountId===id)}))});
    const initialLocalScope=localScope();
    const handoff=handoffId?current.repository.getManualHandoff(handoffId):null;
    if(handoffId&&(!handoff||handoff.consumedAt!==null||accounts.length!==1||workerAccounts.length!==1||accounts[0]!==handoff.accountId||Date.parse(handoff.expiresAt)<=Date.parse(input.clock.now())))throw Error('handoff_not_current');
    let expires=Math.min(Date.parse(input.clock.now())+5000,handoff?Date.parse(handoff.expiresAt):Infinity);
    if(workerAccounts.length){
      const configuration=current.configuration.read();if(!configuration||configuration.configuration.state!=='active')throw Error('delegation_inactive');
      if(!(await current.client.sync(active)).ownerFresh)throw Error('owner_not_current');
      const checkpoints:Awaited<ReturnType<ExecutionClient['checkpoint']>>[]=[];
      for(const accountId of workerAccounts){const checkpoint=await current.client.checkpoint(accountId,active,handoffId);expires=Math.min(expires,checkpoint.validUntil);checkpoints.push(checkpoint);}
      if(!(await current.client.sync(active)).ownerFresh)throw Error('owner_not_current');
      for(const checkpoint of checkpoints){const authority=current.repository.authority(checkpoint.accountId);if(authority?.generation!==checkpoint.generation||current.repository.executionVersion(checkpoint.accountId)!==checkpoint.version)throw Error('checkpoint_changed');}
      for(const accountId of workerAccounts){const owner=current.repository.authority(accountId);if(!owner||owner.owner!=='worker'||owner.state!=='active'||current.repository.hasPendingStop(accountId))throw Error('owner_not_current');}
    }
    const snapshot=()=>accountFingerprint({subjectAccounts:accountIds(),person:person(),handoff:handoffId?current.repository.getManualHandoff(handoffId):null,configuration:current.configuration.read(),transport:current.transport.current(),accounts:accounts.map(accountId=>({exists:database.raw.prepare('SELECT id FROM pm_accounts WHERE id=?').get(accountId)??null,authority:current.repository.authority(accountId),version:current.repository.executionVersion(accountId),pending:current.repository.pendingCommands().filter(c=>c.accountId===accountId),suppressed:database.raw.prepare('SELECT 1 FROM pm_account_suppression_tombstones WHERE account_id=?').get(accountId)??null}))});
    if(localScope()!==initialLocalScope)throw Error('subject_scope_changed');
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
  ...researchExtension,
  googleConnections,
  reconcileReplyDraft:(raw:ReconcileReplyDraft)=>ordinaryReply(raw,false),
  editReplyDraft:(raw:EditReplyDraft)=>ordinaryReply(raw,true),
  prepareRequestedFollowup:(raw:PrepareRequestedFollowup)=>{const request=prepareRequestedFollowupSchema.parse(raw);return run(async(database,signal)=>{const {service}=await requestedServices(database,signal,request);return service.prepareRequestedFollowup(request,signal);});},
  getRequestedFollowup:(raw:GetRequestedFollowup)=>{const request=getRequestedFollowupSchema.parse(raw);return run(async(database,signal)=>{
   if(!pairing)throw Error('pairing_unconfigured');const draft=savedDraft(database,request.accountId,request.draftId);if(!draft)return null;
   try{return (await requestedServices(database,signal,contextInput(draft))).store.get(request.accountId,request.draftId);}catch{
    assertCurrent(signal);return new SqlRequestedFollowupRepository({database,workspaceId:pairing.workspaceId,clock:input.clock,mailbox:()=>({subject:draft.mailboxSubject,sender:draft.sender})}).get(request.accountId,request.draftId);
   }
  });},
  editRequestedFollowup:(raw:EditRequestedFollowup)=>{const request=editRequestedFollowupSchema.parse(raw);return run(async(database,signal)=>{
   if(!pairing)throw Error('pairing_unconfigured');const draft=savedDraft(database,request.accountId,request.draftId);if(!draft)throw Error('requested_draft_missing');
   return (await requestedServices(database,signal,contextInput(draft))).service.editRequestedFollowup(request);
  });},
  approveRequestedFollowup:(raw:ApproveRequestedFollowup)=>{const request=approveRequestedFollowupSchema.parse(raw);return run(async(database,signal)=>{
   const current=services(database,signal);const draft=savedDraft(database,request.draft.accountId,request.draft.id);
   if(!draft||accountFingerprint(draft)!==accountFingerprint(request.draft))throw Error('requested_saved_content_mismatch');
   const previous=(database.raw.prepare("SELECT command_json FROM delegated_commands WHERE workspace_id=? AND account_id=? AND json_extract(command_json,'$.kind')='approve-requested-followup' AND json_extract(command_json,'$.payload.approvalId')=?").all(pairing!.workspaceId,draft.accountId,request.approvalId) as {command_json:string}[]).map(row=>approveRequestedFollowupCommandSchema.parse(JSON.parse(row.command_json)));
   if(previous.length>1||previous[0]&&accountFingerprint(previous[0].payload)!==accountFingerprint(request))throw Error('requested_approval_conflict');
   const authority=current.repository.authority(draft.accountId);if(!authority||authority.owner!=='worker'||authority.state!=='active'||current.repository.hasPendingStop(draft.accountId))throw Error('requested_owner_inactive');
   const command=previous[0]??approveRequestedFollowupCommandSchema.parse({commandId:randomUUID(),workspaceId:pairing!.workspaceId,accountId:draft.accountId,expectedAuthorityGeneration:authority.generation,expectedVersion:current.repository.executionVersion(draft.accountId),kind:'approve-requested-followup',payload:{...request,draft}});
   await current.client.submit(command);await current.client.sync(signal);
   return requestedApprovalStatusSchema.parse(current.repository.requestedApprovalStatus(command.commandId));
  });},
  // Migration 24 and the importer require UUID workspaces. Other paired capabilities accept opaque IDs.
  policyImport:pairing&&input.policyImportNative&&z.uuid().safeParse(pairing.workspaceId).success?createAccountRoutePolicyImport({workspaceId:pairing.workspaceId,clock:input.clock,databaseGate:{withDatabase:run},native:input.policyImportNative}):null,
  adapter,
  readinessForHandoff,
  getPhoneHandoffState:(raw:GetPhoneHandoffStateRequest)=>{const request=delegatedPhoneStateRequestSchema.parse(raw);return run(database=>{if(!pairing)throw Error('pairing_unconfigured');return readDelegatedPhoneHandoffState(database,{...request,workspaceId:pairing.workspaceId,generatedAt:input.clock.now()});});},
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
  /** Explicit resubmission of the current saved record to the worker that already owns the company. One live command
   * per company: the same id reuses its stored command, a different id against a pending send is a conflict. Generation
   * and version are the real local mirror values, the record is bound to the local research cursor, and the button is
   * the only producer. Nothing here changes ownership, campaigns, mail or calendar. */
  refreshSelectedAccount:(raw:unknown)=>{const request=refreshSelectedAccountRecordSchema.parse(raw);invalidate();return run(async(database,signal)=>{
    const current=services(database,signal);if(!pairing)throw Error('pairing_unconfigured');const repository=current.repository;
    const previous=repository.getCommand(request.commandId);
    if(previous&&(previous.kind!=='refresh-selected-account-record'||previous.accountId!==request.accountId))throw Error('refresh_command_conflict');
    const live=repository.selectedAccountRecordCommands(request.accountId).filter(command=>command.kind==='refresh-selected-account-record'&&repository.commandStatus(command.commandId)?.status==='pending');
    if(live.some(command=>command.commandId!==request.commandId))throw Error('refresh_command_conflict');
    let command=previous;
    if(!command){
      const authority=repository.authority(request.accountId);const version=repository.executionVersion(request.accountId);
      if(!authority||authority.owner!=='worker'||authority.state!=='active'||version===null||repository.hasPendingStop(request.accountId))throw Error('refresh_owner_inactive');
      if(repository.pendingCommands().some(pending=>pending.accountId===request.accountId))throw Error('refresh_owner_pending');
      const cursor=database.raw.prepare("SELECT aggregate_version FROM delegated_event_cursors WHERE workspace_id=? AND account_id=? AND stream='research'").get(pairing.workspaceId,request.accountId) as {aggregate_version:number}|undefined;
      if(!cursor)throw Error('refresh_research_cursor_missing');
      const asOf=input.clock.now();
      const record=exportSelectedAccountRecord({database,workspaceId:pairing.workspaceId,accountId:request.accountId,asOf,researchRevision:cursor.aggregate_version});
      command=refreshSelectedAccountRecordCommandSchema.parse({...request,workspaceId:pairing.workspaceId,expectedAuthorityGeneration:authority.generation,expectedVersion:version,kind:'refresh-selected-account-record',payload:{record,asOf,expectedResearchRevision:cursor.aggregate_version}});
      assertRefreshCommandTransportable(command);
    }
    await current.client.submit(command);await current.client.sync(signal);const receipt=repository.commandStatus(request.commandId);if(!receipt)throw Error('refresh_receipt_missing');return receipt;
  });},
  /** Local comparison of the saved record with the copy the worker last applied (bootstrap or refresh). No worker call. */
  getSelectedAccountFreshness:(raw:unknown)=>{const request=selectedAccountFreshnessRequestSchema.parse(raw);return run((database,signal)=>{
    if(!pairing)throw Error('pairing_unconfigured');const repository=services(database,signal).repository;
    const sent=repository.selectedAccountRecordCommands(request.accountId).filter(command=>repository.commandStatus(command.commandId)?.status==='applied').at(-1);
    const cursor=database.raw.prepare("SELECT aggregate_version FROM delegated_event_cursors WHERE workspace_id=? AND account_id=? AND stream='research'").get(pairing.workspaceId,request.accountId) as {aggregate_version:number}|undefined;
    const local=exportSelectedAccountRecord({database,workspaceId:pairing.workspaceId,accountId:request.accountId,asOf:input.clock.now(),researchRevision:cursor?.aggregate_version??1});
    const localFingerprint=accountFingerprint(local);const sentFingerprint=sent?accountFingerprint(sent.payload.record):null;
    return selectedAccountFreshnessSchema.parse({accountId:request.accountId,state:sentFingerprint===null?'unknown':sentFingerprint===localFingerprint?'current':'stale',localFingerprint,sentFingerprint,sentAt:sent?.payload.asOf??null});
  });},
  submit:(raw:unknown)=>{const command=publicDelegationCommandSchema.parse(raw);invalidate();return run((database,signal)=>services(database,signal).client.submit(command));},
  /** The launch sync, the five-minute background sync and both Sync buttons all arrive here and all get
   * the same whole-run budget. Each worker request inside the run keeps its own 15 s. */
  sync:()=>run((database,signal)=>services(database,signal).client.sync(signal,SYNC_BUDGET_MS)),
  /** Explicit intake configuration for one company: pause or resume, relevant mail on for the first
   * time with a start date, or the grant's owned calendar. Queues exactly one configure-owner command
   * with the revision the founder read bound; the worker's admission is mirrored first so nothing stale
   * is queued. Pairing, research and the scope envelope are never typed. Nothing here reads mail, sends or books. */
  configureIntake:(raw:unknown)=>{const request=configureAccountIntakeSchema.parse(raw);return run(async(database,signal)=>{
   if(!pairing)throw Error('pairing_unconfigured');
   const active=AbortSignal.any([signal,AbortSignal.timeout(15000)]);const current=services(database,active);const repository=current.repository;
   const held=(reason:AccountIntakeHoldReason)=>accountIntakeConfigureStatusSchema.parse({status:'held',accountId:request.accountId,expectedConfigurationRevision:request.expectedConfigurationRevision,reason});
   // Command identity outlives lost responses and remounts: the identical change reuses its live command.
   const commands=repository.intakeConfigureCommands(request.accountId),receiptOf=(command:ConfigureOwnerCommand)=>repository.commandStatus(command.commandId)?.status;
   const same=commands.filter(command=>receiptOf(command)!=='rejected'&&intakeBinding(command)===intakeBinding(request));
   if(same.length>1)throw Error('intake_configuration_conflict');
   let command=same[0];
   if(!command){
    if(commands.some(command=>receiptOf(command)==='pending'))return held('intake_configuration_conflict');
    const authority=repository.authority(request.accountId);const version=repository.executionVersion(request.accountId);
    if(!authority||authority.owner!=='worker'||!['active','paused'].includes(authority.state)||version===null||repository.hasPendingStop(request.accountId))return held('intake_owner_inactive');
    if(repository.pendingCommands().some(pending=>pending.accountId===request.accountId))return held('intake_command_pending');
    // The stored configuration is read from the owner now, bound to the same authority and version the command expects.
    const preparation=await createAccountPreparationTransport({pairing:{endpoint:pairing.endpoint,workspaceId:pairing.workspaceId,pairingId:pairing.pairingId,credential:pairing.credential},fetch:input.fetch}).read({accountId:request.accountId},active);
    assertCurrent(active);
    if(preparation.authority.owner!=='worker'||!['active','paused'].includes(preparation.authority.state)||preparation.authority.generation!==authority.generation||preparation.executionVersion!==version)return held('intake_owner_stale');
    const config=preparation.configuration,mailbox=config?.mailboxSubject??null,mailOn=request.state==='active'&&request.mailboxSubject!==null;
    if((config?.revision??0)!==request.expectedConfigurationRevision)return held('stale_source_configuration');
    // Worker admission mirrored before anything is queued, its codes verbatim. A mailbox is never switched or re-scoped here.
    if(mailbox!==null&&(request.mailboxSubject!==mailbox||request.mailSince!==null))return held('intake_mailbox_mismatch');
    if(request.state==='active'&&request.mailboxSubject===null&&(request.mailSince!==null||request.calendarId!==null))return held('no_mail_configuration_conflict');
    if(request.state==='paused'&&request.mailSince!==null)return held('inactive_scope_change');
    const calendarChanged=request.calendarId!==null&&request.calendarId!==(config?.calendarId??null);
    if(mailOn||calendarChanged){
     const grant=await current.client.googleGrantStatus('permitted_correspondence',active);assertCurrent(active);
     if(mailOn&&(grant.state!=='ready'||grant.grant?.subject!==request.mailboxSubject||!grant.grant.grantedScopes.includes(googleScopes.relevant_read)))return held('source_grant_unavailable');
     const owned=grant.state==='ready'&&grant.grant?.purpose==='permitted_correspondence'?grant.grant.calendars?.ownedCalendarId??null:null;
     if(calendarChanged&&owned!==request.calendarId)return held('intake_calendar_unavailable');
    }
    if(mailOn&&request.mailSince===null&&!preparation.mailCursor?.scope)return held('selected_scope_incomplete');
    if(repository.authority(request.accountId)?.generation!==authority.generation||repository.executionVersion(request.accountId)!==version)return held('intake_owner_stale');
    const configuration=ownerSourceConfigurationSchema.parse({version:1,workspaceId:pairing.workspaceId,accountId:request.accountId,pairingId:pairing.pairingId,revision:request.expectedConfigurationRevision+1,state:request.state,mailboxSubject:request.mailboxSubject,calendarId:request.calendarId,research:config?.research??null});
    command=configureOwnerCommandSchema.parse({commandId:randomUUID(),workspaceId:pairing.workspaceId,accountId:request.accountId,expectedAuthorityGeneration:authority.generation,expectedVersion:version,kind:'configure-owner',
     payload:{expectedConfigurationRevision:request.expectedConfigurationRevision,configuration,mailScope:request.mailSince===null?null:{expectedEnvelopeRevision:preparation.mailCursor?.envelopeRevision??null,since:request.mailSince}}});
   }
   await current.client.submit(command);await current.client.sync(active);
   return intakeStatus(repository,command);
  });},
  getAccountPreparation:(raw:unknown)=>{
    const request=Object.freeze(getAccountPreparationSchema.parse(raw));
    return run((_database,signal)=>{
      if(!pairing)throw Error('pairing_unconfigured');
      // Never construct services(database): the detached HTTP/body continuation
      // owns only this frozen pairing and fetch, not repository/DB handles.
      return createAccountPreparationTransport({pairing:{endpoint:pairing.endpoint,workspaceId:pairing.workspaceId,
        pairingId:pairing.pairingId,credential:pairing.credential},fetch:input.fetch}).read(request,signal);
    });
  },
  configurePolicy:(raw:unknown)=>run((database,signal)=>services(database,signal).client.configurePolicy(raw,signal)),
  /** The standing territory call policy (D1): read it from the owner, approve the fixed default definition once, pause or
   * resume. The renderer names the command identity so a retry resends the identical command; main supplies the
   * definition, the workspace and the fixed policy subject. No account row, no outbox, nothing dials or sends. */
  territoryPolicy:(raw:unknown)=>{const request=territoryCallPolicyRequestSchema.parse(raw);return run(async(database,signal)=>{
   if(!pairing)throw Error('pairing_unconfigured');
   const active=AbortSignal.any([signal,AbortSignal.timeout(15000)]);
   const payload:TerritoryCallPolicyCommandPayload=request.kind==='read'?{kind:'policy.read'}:request.kind==='approve'?{kind:'policy.approve',expectedRevision:request.expectedRevision,definition:DEFAULT_TERRITORY_CALL_POLICY_DEFINITION}:{kind:'policy.set-state',expectedRevision:request.expectedRevision,state:request.state};
   const command=territoryPolicyCommandSchema.parse({commandId:request.kind==='read'?randomUUID():request.commandId,workspaceId:pairing.workspaceId,accountId:TERRITORY_CALL_POLICY_SUBJECT,expectedAuthorityGeneration:0,expectedVersion:0,kind:'territory-policy',payload});
   const result=await services(database,active).client.territoryPolicy(command,active);assertCurrent(active);
   return territoryCallPolicyStatusSchema.parse({workspaceId:pairing.workspaceId,policy:result.policy,definition:DEFAULT_TERRITORY_CALL_POLICY_DEFINITION,receipt:request.kind==='read'?null:result.receipt});
  });},
  configureResearch:(raw:unknown)=>run((database,signal)=>services(database,signal).client.configureResearch(raw,signal)),
  async dispose(){closed=true;invalidate(true);await Promise.allSettled([...flights]);},
 };
}
export type DelegationRuntime=ReturnType<typeof createDelegationRuntime>;
