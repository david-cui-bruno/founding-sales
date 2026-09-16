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
import {ExecutionClient,createResearchSetupTransport,createAccountPreparationTransport} from './executionClient';
import {createResearchSetupService,awaitResearchSetupOperation} from './researchSetupService';
import type {ResearchSetupRequestStore} from './researchSetupRequestStore';
import type {ResearchSetupApi} from '../../shared/contracts/researchSetupContract';
import {approveRequestedFollowupCommandSchema,approveMeetingCommandSchema,delegatedPhoneHandoffRequestSchema,bootstrapSelectedAccountSchema,bootstrapSelectedAccountCommandSchema,configureLocalDelegationSchema,localDelegationStatusSchema} from '../../shared/contracts/ownerCommandContract';
import {publicDelegationCommandSchema,type DelegatedPhoneHandoffResult,type DelegationCommand} from '../../shared/contracts/delegationContract';
import {approveMeetingFromReplySchema,getMeetingApprovalSchema,meetingApprovalStatusSchema,schedulingEvidence,type ApproveMeetingFromReply} from '../../shared/contracts/meetingContract';
import {resolveLocalTime} from '../../shared/meetings/schedulingRules';
type ApproveMeetingCommand=Extract<DelegationCommand,{kind:'approve-meeting'}>;
/** The founder-visible binding of one approval. The same binding reuses the live
 * command; a different binding against a live approval is a conflict, never a second command. */
function meetingApprovalBinding(value:ApproveMeetingCommand|ApproveMeetingFromReply):string{
 if('kind' in value){const i=value.payload.intent;return accountFingerprint({agreementEvidenceId:i.agreementEvidenceId,attendeeEmail:i.attendeeEmails[0],quote:i.agreement?.kind==='explicit_slot'?i.agreement.quote:null,calendarId:value.payload.calendarId,rulesRevision:i.rulesRevision,timezone:i.timezone,durationMinutes:(Date.parse(i.end)-Date.parse(i.start))/60000,localStart:i.localStart,summary:i.summary,inviteAttendees:i.inviteAttendees,threadRevision:i.threadRevision,contextRevision:i.contextRevision});}
 return accountFingerprint({agreementEvidenceId:value.agreementEvidenceId,attendeeEmail:value.attendeeEmail,quote:value.quote,calendarId:value.calendarId,rulesRevision:value.rulesRevision,timezone:value.timezone,durationMinutes:value.durationMinutes,localStart:value.localStart,summary:value.summary,inviteAttendees:value.inviteAttendees,threadRevision:value.expectedThreadRevision,contextRevision:value.expectedContextRevision});
}
function meetingApprovalStatus(repository:DelegationRepository,command:ApproveMeetingCommand){
 const receipt=repository.commandStatus(command.commandId);if(!receipt)throw Error('meeting_receipt_missing');const i=command.payload.intent;
 return meetingApprovalStatusSchema.parse({commandId:command.commandId,accountId:command.accountId,threadId:i.threadId,agreementEvidenceId:i.agreementEvidenceId,meetingId:i.meetingId,calendarId:command.payload.calendarId,attendeeEmail:i.attendeeEmails[0],start:i.start,end:i.end,timezone:i.timezone,localStart:i.localStart,summary:i.summary,receipt});
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
  submit:(raw:unknown)=>{const command=publicDelegationCommandSchema.parse(raw);invalidate();return run((database,signal)=>services(database,signal).client.submit(command));},
  sync:()=>run((database,signal)=>services(database,signal).client.sync(AbortSignal.any([signal,AbortSignal.timeout(15000)]))),
  /** Explicit founder approval of one explicit slot. Queues exactly one approve-meeting
   * owner command per saved thread; the worker's existing poller reserves. Nothing here
   * reads or writes a calendar, and no revision, version or attendee is ever invented. */
  approveMeeting:(raw:unknown)=>{const request=approveMeetingFromReplySchema.parse(raw);return run(async(database,signal)=>{
   if(!pairing)throw Error('pairing_unconfigured');
   const active=AbortSignal.any([signal,AbortSignal.timeout(15000)]);const current=services(database,active);const repository=current.repository;
   // Command identity outlives lost responses and remounts: at most one live approval per saved thread.
   const live=repository.meetingApprovalCommands(request.accountId,request.threadId).filter(command=>repository.commandStatus(command.commandId)?.status!=='rejected');
   if(live.length>1||(live[0]&&meetingApprovalBinding(live[0])!==meetingApprovalBinding(request)))throw Error('meeting_approval_conflict');
   let command=live[0];
   if(!command){
    const thread=repository.getThread(request.accountId,request.threadId);if(!thread)throw Error('thread_missing');
    if(thread.revision!==request.expectedThreadRevision||thread.contextRevision!==request.expectedContextRevision)throw Error('stale_thread');
    const evidence=schedulingEvidence(thread);if(evidence.kind!=='available')throw Error(evidence.reason);
    if(evidence.message.id!==request.agreementEvidenceId||evidence.attendeeEmail!==request.attendeeEmail||!evidence.quotes.includes(request.quote))throw Error('agreement_evidence_mismatch');
    const authority=repository.authority(request.accountId);const version=repository.executionVersion(request.accountId);
    if(!authority||authority.owner!=='worker'||authority.state!=='active'||version===null||repository.hasPendingStop(request.accountId))throw Error('meeting_owner_inactive');
    if(repository.pendingCommands().some(pending=>pending.accountId===request.accountId))throw Error('meeting_owner_pending');
    // The rules revision is read from the owner now, bound to the same authority and version the command expects.
    const preparation=await createAccountPreparationTransport({pairing:{endpoint:pairing.endpoint,workspaceId:pairing.workspaceId,pairingId:pairing.pairingId,credential:pairing.credential},fetch:input.fetch}).read({accountId:request.accountId},active);
    assertCurrent(active);
    if(preparation.authority.owner!=='worker'||preparation.authority.state!=='active'||preparation.authority.generation!==authority.generation||preparation.executionVersion!==version)throw Error('meeting_owner_stale');
    const config=preparation.configuration;
    if(!config||config.state!=='active'||config.calendarId===null||config.mailboxSubject===null)throw Error('meeting_calendar_unconfigured');
    if(config.mailboxSubject!==thread.thread.mailboxSubject)throw Error('meeting_mailbox_mismatch');
    const rules=preparation.meetingRules;
    if(rules===undefined)throw Error('meeting_rules_unreadable');if(rules===null)throw Error('meeting_rules_unconfigured');
    if(config.calendarId!==request.calendarId||rules.revision!==request.rulesRevision||rules.timezone!==request.timezone||rules.durationMinutes!==request.durationMinutes)throw Error('meeting_rules_changed');
    const resolved=resolveLocalTime(request.localStart,rules.timezone,null);if(resolved.kind!=='resolved')throw Error('time_clarification_required');
    const start=resolved.instant,end=new Date(Date.parse(start)+rules.durationMinutes*60000).toISOString(),commandId=randomUUID();
    if(repository.authority(request.accountId)?.generation!==authority.generation||repository.executionVersion(request.accountId)!==version)throw Error('meeting_owner_stale');
    command=approveMeetingCommandSchema.parse({commandId,workspaceId:pairing.workspaceId,accountId:request.accountId,expectedAuthorityGeneration:authority.generation,expectedVersion:version,kind:'approve-meeting',payload:{calendarId:config.calendarId,intent:{
     workspaceId:pairing.workspaceId,accountId:request.accountId,commandId,meetingId:randomUUID(),operation:'create',expectedAuthorityGeneration:authority.generation,expectedVersion:version+1,rulesRevision:rules.revision,
     threadId:request.threadId,threadRevision:thread.revision,contextRevision:thread.contextRevision,mailboxSubject:config.mailboxSubject,pairingId:pairing.pairingId,start,end,localStart:request.localStart,offset:null,timezone:rules.timezone,
     agreementEvidenceId:evidence.message.id,agreement:{kind:'explicit_slot',start,end,quote:request.quote},mixedReply:evidence.mixed,approvalId:commandId,attendeeEmails:[evidence.attendeeEmail],inviteAttendees:request.inviteAttendees,summary:request.summary,etag:null}}});
   }
   await current.client.submit(command);await current.client.sync(active);
   return meetingApprovalStatus(repository,command);
  });},
  /** Local read of the newest live (else newest) approval for one saved thread. No owner call. */
  getMeetingApproval:(raw:unknown)=>{const request=getMeetingApprovalSchema.parse(raw);return run((database,signal)=>{
   const repository=services(database,signal).repository;const commands=repository.meetingApprovalCommands(request.accountId,request.threadId);
   if(!commands.length)return null;
   const live=commands.filter(command=>repository.commandStatus(command.commandId)?.status!=='rejected');
   return meetingApprovalStatus(repository,(live.length?live:commands).at(-1)!);
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
  configureResearch:(raw:unknown)=>run((database,signal)=>services(database,signal).client.configureResearch(raw,signal)),
  async dispose(){closed=true;invalidate(true);await Promise.allSettled([...flights]);},
 };
}
export type DelegationRuntime=ReturnType<typeof createDelegationRuntime>;
