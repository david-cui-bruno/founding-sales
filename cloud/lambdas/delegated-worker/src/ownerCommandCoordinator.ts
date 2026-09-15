import {validateRequestedDraftRevision} from '../../../../src/main/outreach/requestedFollowupService';
import {requestedFollowupDraftSchema} from '../../../../src/shared/contracts/requestedFollowupContract';
import {DynamoRequestedFollowupRepository,requestedFollowupDraftKey} from './requestedFollowupRepository';
import {createRequestedApprovalRecord,requestedApprovalKey,loadRequestedApproval,requestedApprovalRecordSchema} from './requestedFollowupApproval';
import { createMailPoller } from './mailPoller';
import { offeredSlotText } from '../../../../src/shared/meetings/schedulingRules';
import { meetingReservationSchema, meetingOutcomeSchema } from '../../../../src/shared/contracts/meetingContract';
import { createHash } from 'node:crypto';
import { CampaignExecution } from './campaignExecution';
import { WorkerCampaignRepository, campaignReservationKey, campaignReservationSchema, campaignEnrollmentKey } from './workerCampaignRepository';
import { enrollmentSchema, campaignEventPayloadSchema } from '../../../../src/shared/contracts/campaignContract';
import { QueryCommand,type AttributeValue,type TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { ownerReplyDraftRequestSchema, accountReplyDraftSchema, assertReplyDraftLineage, replyDraftResultSchema, threadProjectionSchema, mailAccountScopeSchema } from '../../../../src/shared/contracts/mailThreadContract';
import { accountRecordSchema, accountKey } from './workerAccountRepository';
import { intakeRegistryKey, intakeRegistrySchema, createIntakeBarrier, validatePendingHandoff } from './intakeBarrier';
import type { WorkerAuth } from './workerAuth';
import type { RemoteGoogleAuthorization } from './remoteGoogleAuthorization';
import { requestedOwnerDraftRequestSchema, requestedOwnerContextRequestSchema, requestedOwnerContextSchema, ownerCheckpointRequestSchema, ownerCheckpointSchema, configureResearchSourceSchema, ownerResearchSourceKey, ownerResearchSourceSchema, ownerCommandSchema, ownerSourceConfigurationSchema, ownerSourceKey, manualHandoffSchema, type ManualHandoff, type ManualOutcome, type OwnerCommand } from '../../../../src/shared/contracts/ownerCommandContract';
import { delegationCommandSchema, commandReceiptSchema, workerEventSchema, type CommandReceipt, type WorkerEvent } from '../../../../src/shared/contracts/delegationContract';
import { DynamoStore, fingerprint, keyPart } from './dynamoStore';
import { authorityRecordSchema, executionAuthorityKey, executionAuthorityFields, createExecutionRepository } from './executionRepository';
import { DynamoThreadIntakeRepository, mailDraftKey, mailThreadKey, mailCursorKey, mailSuppressionKey } from './threadIntakeRepository';
import { DynamoDispatchRepository, dispatchApprovalKey, dispatchPermissionKey, dispatchIntentKey, dispatchApprovalSchema, type DispatchIntent } from './dispatchRepository';

/** Authenticated owner admission. No provider action is performed here. Partially
 * admitted immutable records cannot dispatch without a separate requested work item. */
export class OwnerCommandCoordinator {
  constructor(readonly input: { auth: WorkerAuth; authorization: RemoteGoogleAuthorization }) {}
  async reconcile(raw:unknown,authorization:string):Promise<CommandReceipt> {
    const command=delegationCommandSchema.parse(raw);const principal=await this.input.auth.authenticate(authorization,['commands:write']);this.input.auth.store.workspace(command.workspaceId);
    const store=new DynamoStore({...this.input.auth.options,dynamo:this.input.auth.fencedDynamo(principal)});const key=`COMMAND#${keyPart(command.commandId)}`;const fp=fingerprint(command);
    const previous=await store.get<{fingerprint:string;receipt:CommandReceipt;sequence:number}>(key);
    if(previous){if(previous.data.fingerprint!==fp)throw Error('command_fingerprint_conflict');await store.publish(previous.data.sequence);return commandReceiptSchema.parse(previous.data.receipt);}
    if(command.kind==='delegate'||command.kind==='complete-manual')throw Error('command_requires_explicit_reconciliation');
    const authKey=executionAuthorityKey(command.accountId);const row=await store.get<unknown>(authKey);if(!row)throw Error('authority_missing');const current=authorityRecordSchema.parse(row.data);
    if(current.authority.owner!=='worker'||command.expectedAuthorityGeneration>current.authority.generation||command.expectedVersion>current.version||command.expectedAuthorityGeneration===current.authority.generation&&command.expectedVersion===current.version)throw Error('command_not_proven_stale');
    const next={...current,version:current.version+1};const receipt:CommandReceipt={commandId:command.commandId,status:'rejected',authorityGeneration:current.authority.generation,aggregateVersion:next.version,reason:'Stale owner command; explicit fresh action required'};
    const event=workerEventSchema.parse({id:`command-${fingerprint([command.workspaceId,command.commandId])}`,workspaceId:command.workspaceId,accountId:command.accountId,authorityGeneration:current.authority.generation,aggregateVersion:next.version,kind:'authority.changed',payload:{authority:current.authority,receipt}});
    const outbox=await store.eventItems(event);await store.transact([store.put(authKey,next,row.rev,executionAuthorityFields(next),executionAuthorityFields(current)),store.put(key,{fingerprint:fp,receipt,sequence:outbox.sequence,command},null),...outbox.items]);await store.publish(outbox.sequence);return receipt;
  }
  async requestedContext(raw:unknown,authorization:string) {
    const request=requestedOwnerContextRequestSchema.parse(raw);
    const principal=await this.input.auth.authenticate(authorization,['events:read']);this.input.auth.store.workspace(request.workspaceId);
    const repository=new DynamoRequestedFollowupRepository({...this.input.auth.options,dynamo:this.input.auth.fencedDynamo(principal)});
    const sourceRow=await repository.store.get<unknown>(ownerSourceKey(request.input.accountId));
    const source=ownerSourceConfigurationSchema.parse(sourceRow?.data);
    if(source.workspaceId!==request.workspaceId||source.accountId!==request.input.accountId||source.pairingId!==principal.pairingId)throw Error('requested_source_identity');
    const plan=await repository.readContext(request.input);
    // Checking the original source revision also fences a concurrent pairing change.
    const sourceCheck=plan.checks.find(item=>item.ConditionCheck?.Key?.sk?.S===ownerSourceKey(request.input.accountId));
    if(!sourceCheck||fingerprint(sourceCheck)!==fingerprint(repository.store.check(ownerSourceKey(request.input.accountId),sourceRow!.rev)))throw Error('requested_source_changed');
    await repository.store.transact(plan.checks);
    return requestedOwnerContextSchema.parse({workspaceId:request.workspaceId,accountId:request.input.accountId,mailbox:plan.mailbox,mailContext:plan.mailContext,
      accountVersion:plan.account.account.version,researchRevision:plan.account.researchRevision,authorityGeneration:plan.authority.data.authority.generation,aggregateVersion:plan.authority.data.version,
      cursor:plan.cursor?{data:plan.cursor.data,rev:plan.cursor.rev}:null,expiresAt:new Date(Date.parse(repository.store.now())+30000).toISOString()});
  }
  async requestedDraft(raw:unknown,authorization:string) {
    const request=requestedOwnerDraftRequestSchema.parse(raw), draft=request.draft;
    validateRequestedDraftRevision(draft,request.previousDraft,request.previousDraft.revision);
    if(draft.generation!=='edited'||fingerprint(draft.evidenceIds)!==fingerprint(request.previousDraft.evidenceIds))throw Error('requested_edit_revision');
    const principal=await this.input.auth.authenticate(authorization,['commands:write']);this.input.auth.store.workspace(request.workspaceId);
    const repository=new DynamoRequestedFollowupRepository({...this.input.auth.options,dynamo:this.input.auth.fencedDynamo(principal)});
    const sourceKey=ownerSourceKey(draft.accountId), sourceRow=await repository.store.get<unknown>(sourceKey), source=ownerSourceConfigurationSchema.parse(sourceRow?.data);
    if(source.workspaceId!==request.workspaceId||source.accountId!==draft.accountId||source.pairingId!==principal.pairingId)throw Error('requested_source_identity');
    const plan=await repository.planCurrent(draft);
    if(plan.authority.data.authority.owner!=='worker'||plan.authority.data.authority.state!=='active'||!plan.checks.some(item=>fingerprint(item)===fingerprint(repository.store.check(sourceKey,sourceRow!.rev))))throw Error('requested_source_changed');
    const key=requestedFollowupDraftKey(draft.accountId,draft.id), row=await repository.store.get<unknown>(key);
    const previous=row?requestedFollowupDraftSchema.parse(row.data):null;
    // A lost acknowledgement may regenerate only updatedAt. Preserve the first
    // canonical saved timestamp; every identity/context/content field stays exact.
    if(previous?.revision===draft.revision&&fingerprint({...previous,updatedAt:draft.updatedAt})===fingerprint(draft)){
      await repository.store.transact([...plan.checks,repository.store.check(key,row!.rev)]);return previous;
    }
    if(previous&&fingerprint(previous)!==fingerprint(request.previousDraft))throw Error('stale_requested_draft');
    const write=await repository.planCaptureDraft(draft,previous?.revision??null);
    await repository.store.transact([...plan.checks,write]);return draft;
  }
  async replyDraft(raw: unknown, authorization: string) {
    const request = ownerReplyDraftRequestSchema.parse(raw), prior = request.previousDraft;
    const principal = await this.input.auth.authenticate(authorization, [request.edit ? 'commands:write' : 'events:read']);
    this.input.auth.store.workspace(request.workspaceId);
    const repository = new DynamoThreadIntakeRepository({ ...this.input.auth.options, dynamo: this.input.auth.fencedDynamo(principal) }), store = repository.store;
    const sourceKey = ownerSourceKey(prior.accountId), sourceRow = await store.get<unknown>(sourceKey), source = ownerSourceConfigurationSchema.parse(sourceRow?.data);
    if (source.state !== 'active' || source.workspaceId !== request.workspaceId || source.accountId !== prior.accountId || source.pairingId !== principal.pairingId || source.mailboxSubject !== prior.mailboxSubject) throw Error('reply_source_mismatch');
    const authKey = executionAuthorityKey(prior.accountId), authorityRow = await store.get<unknown>(authKey), authority = authorityRecordSchema.parse(authorityRow?.data);
    if (authority.authority.accountId !== prior.accountId || authority.authority.owner !== 'worker' || authority.authority.state !== 'active' || authority.authority.generation !== request.expectedAuthorityGeneration) throw Error('reply_owner_changed');
    const key = mailDraftKey(prior.accountId, prior.id), row = await store.get<unknown>(key);
    if (!row) throw Error('reply_draft_missing');
    const current = accountReplyDraftSchema.parse(row.data);
    assertReplyDraftLineage(prior, current);
    const threadKey = mailThreadKey(current.accountId, current.threadId), threadRow = await store.get<unknown>(threadKey), thread = threadProjectionSchema.parse(threadRow?.data);
    if (thread.thread.accountId !== current.accountId || thread.thread.providerThreadId !== current.threadId || thread.thread.mailboxSubject !== current.mailboxSubject || thread.revision < current.threadRevision || thread.revision === current.threadRevision && thread.contextRevision !== current.contextRevision) throw Error('reply_history_unavailable');
    const suppressionKey = mailSuppressionKey(current.accountId), suppression = await store.get(suppressionKey);
    const stale = thread.revision !== current.threadRevision || thread.contextRevision !== current.contextRevision || suppression !== null;
    // Historical canonical reads remain recoverable after opt-out. New saves still
    // use the normal repository suppression absence check and cannot rebase.
    const checks = [store.check(sourceKey, sourceRow!.rev), store.check(authKey, authorityRow!.rev, executionAuthorityFields(authority)), store.check(threadKey, threadRow!.rev), suppression ? store.check(suppressionKey, suppression.rev) : store.absent(suppressionKey)];
    if (!request.edit || current.revision === prior.revision + 1) {
      if (request.edit && (current.subject !== request.edit.subject || current.body !== request.edit.body || current.generation !== 'edited')) throw Error('stale_draft');
      // Exact retry is a read, including after inbound advances. Preserve first timestamp.
      await store.transact([...checks, store.check(key, row.rev)]);
      return replyDraftResultSchema.parse({ draft: current, stale, capability: 'held' });
    }
    const draft = accountReplyDraftSchema.parse({ ...current, ...request.edit, revision: current.revision + 1, generation: 'edited', updatedAt: store.now() });
    assertReplyDraftLineage(current, draft);
    const plan = await repository.planReplyDraftSave(draft, current.revision);
    if (plan.authority.rev !== authorityRow!.rev || plan.previous?.rev !== row.rev) throw Error('reply_owner_changed');
    // Plan re-reads CAS inputs. Bind the original draft and thread snapshots as well.
    if (!plan.items.some(item => fingerprint(item) === fingerprint(store.check(threadKey, threadRow!.rev)))) throw Error('reply_thread_changed');
    await store.transact([...plan.items, store.check(sourceKey, sourceRow!.rev)]);
    return replyDraftResultSchema.parse({ draft, stale: false, capability: 'held' });
  }
  async checkpoint(raw:unknown,authorization:string,signal:AbortSignal) {
    const target=ownerCheckpointRequestSchema.parse(raw); const principal=await this.input.auth.authenticate(authorization,['events:read']);this.input.auth.store.workspace(target.workspaceId);
    const store=new DynamoStore({...this.input.auth.options,dynamo:this.input.auth.fencedDynamo(principal)});
    const source=await this.activeSource(target,principal.pairingId,store,true);
    const initial=target.handoffId?authorityRecordSchema.parse((await store.get(executionAuthorityKey(target.accountId)))?.data):null;
    const scoped=target.handoffId&&initial?{handoffId:target.handoffId,pairingId:principal.pairingId,generation:initial.authority.generation}:null;
    let intake;
    if(source.config.mailboxSubject){
      const threads=new DynamoThreadIntakeRepository(this.input.auth.options);
      const poll=await createMailPoller({authorization:this.input.authorization,store:threads,fetch:this.input.authorization.input.fetch??globalThis.fetch}).pollOnce({accountId:target.accountId,pairingId:principal.pairingId,mailboxSubject:source.config.mailboxSubject},signal);
      if(!poll.complete||poll.suppressed)throw Error('intake_unavailable');
      const barrier=createIntakeBarrier(store);const subject={accountId:target.accountId,mailboxSubject:source.config.mailboxSubject};
      intake=scoped?await barrier.checkHandoff(subject,scoped,signal):await barrier.check(subject,signal);
    }else {const proof=scoped?await validatePendingHandoff(store,target.accountId,scoped):undefined;if(scoped&&!proof)throw Error('handoff_not_current');intake=await this.noMailIntake(target.accountId,store,proof??undefined);}
    if(intake.status!=='ready')throw new Error('intake_unavailable');
    const authKey=executionAuthorityKey(target.accountId);const row=await store.get<unknown>(authKey);const authority=authorityRecordSchema.parse(row?.data);
    if(authority.authority.owner!=='worker'||authority.authority.state!=='active'||scoped&&authority.authority.generation!==scoped.generation)throw new Error('authority_inactive');
    signal.throwIfAborted();if(Date.parse(store.now())>=intake.validUntil)throw Error('checkpoint_expired');const checks=[...source.checks,...intake.checks,store.check(authKey,row!.rev),store.absent(mailSuppressionKey(target.accountId))];await store.transact(checks.filter((item,index)=>checks.findIndex(other=>fingerprint(item)===fingerprint(other))===index));
    return ownerCheckpointSchema.parse({...target,generation:authority.authority.generation,version:authority.version,revision:fingerprint({authority,source:source.config,intake:intake.revisions}),validUntil:Math.min(intake.validUntil,Date.parse(store.now())+5000)});
  }
  async configureResearch(raw: unknown, authorization: string) {
    const command=configureResearchSourceSchema.parse(raw);
    const principal=await this.input.auth.authenticate(authorization,['commands:write']);
    this.input.auth.store.workspace(command.workspaceId);
    const config=command.configuration;
    if(command.pairingId!==principal.pairingId||config.pairingId!==principal.pairingId||config.workspaceId!==command.workspaceId||config.revision!==command.expectedRevision+1) throw new Error('research_configuration_mismatch');
    const store=new DynamoStore({...this.input.auth.options,dynamo:this.input.auth.fencedDynamo(principal)});
    if (await store.get('GUIDED_RESEARCH_SETUP')) throw new Error('research_guided_configuration_owned');
    const receiptKey=`RESEARCH_CONFIGURATION_COMMAND#${keyPart(command.commandId)}`;
    const fp=fingerprint(command); const prior=await store.get<{fingerprint:string;configuration:unknown}>(receiptKey);
    if(prior) {if(prior.data.fingerprint!==fp) throw new Error('command_fingerprint_conflict');return ownerResearchSourceSchema.parse(prior.data.configuration);}
    const key=ownerResearchSourceKey(); const current=await store.get<unknown>(key);
    if((current?ownerResearchSourceSchema.parse(current.data).revision:0)!==command.expectedRevision) throw new Error('research_configuration_conflict');
    await store.transact([store.put(key,config,current?.rev??null),store.put(receiptKey,{fingerprint:fp,configuration:config},null),store.absent('GUIDED_RESEARCH_SETUP')]);
    return config;
  }
  async apply(raw: unknown, authorization: string): Promise<CommandReceipt> {
    const command = ownerCommandSchema.parse(raw);
    const principal = await this.input.auth.authenticate(authorization, ['commands:write']);
    this.input.auth.store.workspace(command.workspaceId);
    const options = { ...this.input.auth.options, dynamo: this.input.auth.fencedDynamo(principal) };
    const store = new DynamoStore(options);
    const key = `COMMAND#${keyPart(command.commandId)}`;
    const fp = fingerprint(command);
    const previous = await store.get<{ fingerprint: string; receipt: CommandReceipt; sequence: number }>(key);
    if (previous) {
      if (previous.data.fingerprint !== fp) throw new Error('command_fingerprint_conflict');
      await store.publish(previous.data.sequence);
      return commandReceiptSchema.parse(previous.data.receipt);
    }
    if(command.kind==='bootstrap-selected-account')return this.bootstrap(command,store,fp,key);
    const authKey = executionAuthorityKey(command.accountId);
    const authorityRow = await store.get<unknown>(authKey);
    if (!authorityRow) throw new Error('authority_missing');
    const current = authorityRecordSchema.parse(authorityRow.data);
    if (current.authority.accountId !== command.accountId || current.authority.owner !== 'worker' || (current.authority.state !== 'active' && !((command.kind === 'configure-owner' && current.authority.state === 'paused') || (command.kind==='complete-manual' && ['paused','revoked'].includes(current.authority.state))))
      || (command.kind==='complete-manual' ? command.expectedAuthorityGeneration>current.authority.generation||command.expectedVersion>current.version : current.authority.generation !== command.expectedAuthorityGeneration || current.version !== command.expectedVersion)) throw new Error('stale_authority');
    const claimKey = `OWNER_COMMAND_CLAIM#${keyPart(command.commandId)}`;
    let claim = await store.get<{ fingerprint: string; pairingId: string; at: string }>(claimKey);
    if (!claim) {
      await store.transact([store.put(claimKey, { fingerprint: fp, pairingId: principal.pairingId, at: store.now() }, null), store.check(authKey, authorityRow.rev)]);
      claim = await store.get(claimKey);
    }
    if (!claim || claim.data.fingerprint !== fp || claim.data.pairingId !== principal.pairingId) throw new Error('owner_claim_conflict');
    const next = { authority: current.authority, version: current.version + 1 };
    let receipt: CommandReceipt = { commandId: command.commandId, status: 'applied', authorityGeneration: command.expectedAuthorityGeneration, aggregateVersion: next.version, reason: null };
    const base = { id: `command-${fingerprint([command.workspaceId, command.commandId])}`, workspaceId: command.workspaceId, accountId: command.accountId,
      authorityGeneration: command.expectedAuthorityGeneration, aggregateVersion: next.version };
    let proof: TransactWriteItem[];
    let finalize = (): TransactWriteItem[] => proof;
    let event: WorkerEvent;
    if(command.kind==='approve-requested-followup') {
      const repository=new DynamoRequestedFollowupRepository(store.options);
      const plan=await repository.planCurrent(command.payload.draft);
      const storedDraft=await store.get<unknown>(requestedFollowupDraftKey(command.accountId,command.payload.draft.id));
      const parsedDraft=storedDraft?requestedFollowupDraftSchema.parse(storedDraft.data):null;
      const exact=parsedDraft&&fingerprint(parsedDraft)===fingerprint(command.payload.draft);
      const draftItem=await repository.planCaptureDraft(command.payload.draft,exact?parsedDraft.revision:command.payload.expectedRemoteDraftRevision);
      const source=await this.activeSource(command,principal.pairingId,store);
      if(plan.authority.rev!==authorityRow.rev||fingerprint(plan.authority.data)!==fingerprint(current)||plan.mailbox.subject!==source.config.mailboxSubject)throw Error('requested_capture_changed');
      const authorityChecks=[...plan.checks,...source.checks].filter(item=>item.ConditionCheck&&fingerprint(item.ConditionCheck.Key)===fingerprint(store.key(authKey)));
      if(authorityChecks.length!==1||fingerprint(authorityChecks[0])!==fingerprint(store.check(authKey,authorityRow.rev,executionAuthorityFields(current))))throw Error('requested_capture_authority_condition');
      const record=createRequestedApprovalRecord(command,principal,claim.data.at);
      // AUTH is written by this enclosing transaction. Preserve every other C3
      // current-evidence condition and reject conflicting duplicate snapshots.
      const unique=new Map<string,TransactWriteItem>();
      for(const item of [...plan.checks,...source.checks]){
        const check=item.ConditionCheck;if(!check)throw Error('requested_capture_check_required');
        if(fingerprint(check.Key)===fingerprint(store.key(authKey)))continue;
        const identity=fingerprint(check.Key);const prior=unique.get(identity);
        if(prior&&fingerprint(prior)!==fingerprint(item))throw Error('requested_capture_changed');
        unique.set(identity,item);
      }
      proof=[...unique.values(),draftItem,store.check(claimKey,claim.rev),store.put(requestedApprovalKey(command.commandId),record,null)];
      event=workerEventSchema.parse({...base,kind:'requested_followup.status',payload:{commandId:command.commandId,draftId:record.draftSnapshot.id,status:{receipt,state:'pending_preflight',intentCommandId:null,reason:null}}});
    } else if(command.kind==='submit-approved-reply') {
      const source=await this.activeSource(command,principal.pairingId,store);
      const policy=new DynamoDispatchRepository(store.options,this.input.authorization);
      const intent=await policy.loadIntent(command.payload.intentCommandId);
      if(!intent||intent.kind!=='standalone_reply'||intent.action.accountId!==command.accountId||intent.action.workspaceId!==command.workspaceId||intent.action.expectedAuthorityGeneration!==command.expectedAuthorityGeneration||intent.pairingId!==principal.pairingId||intent.mailboxSubject!==source.config.mailboxSubject) throw new Error('approved_intent_mismatch');
      const intentKey=dispatchIntentKey(intent.commandId); const intentRow=await store.get(intentKey);
      const approvalKey=dispatchApprovalKey(intent.action.approvalId); const approvalRow=await store.get(approvalKey);
      const approval=dispatchApprovalSchema.parse(approvalRow?.data);
      if(approval.commandId!==intent.commandId||approval.intentHash!==fingerprint(intent)||approval.expiresAt<=store.now()) throw new Error('approval_not_current');
      const actionKey=`ACTION#${keyPart(command.accountId)}#${keyPart(intent.action.actionId)}`;
      const action=await store.get<{input:unknown;state:string}>(actionKey);
      if(!action||!['prepared','queued'].includes(action.data.state)||fingerprint(action.data.input)!==fingerprint(intent.action)||!intentRow||fingerprint(intentRow.data)!==fingerprint(intent)) throw new Error('action_not_current');
      proof=[...source.checks,store.check(intentKey,intentRow.rev),store.check(approvalKey,approvalRow!.rev),store.check(actionKey,action.rev),store.absent(`REVOKED#${intentKey}`),store.absent(`REVOKED#${approvalKey}`),store.absent(`REVOKED#${dispatchPermissionKey(command.accountId,approval.permissionEvidenceId)}`),store.absent(mailSuppressionKey(command.accountId))];
      event=workerEventSchema.parse({...base,kind:'authority.changed',payload:{authority:current.authority,receipt}});
    } else if (command.kind === 'report-acquisition-milestone') {
      const report=command.payload;
      if(Date.parse(report.occurredAt)>Date.parse(store.now())) throw new Error('future_milestone');
      const identity=report.kind==='meeting_attended'?report.meetingId:report.pilotId;
      proof=[store.put(`ACQUISITION_MILESTONE#${keyPart(command.accountId)}#${report.kind}#${keyPart(identity)}`,{report,commandId:command.commandId},null)];
      if(report.kind==='meeting_attended') {
        const key=`MEETING#${keyPart(report.meetingId)}`;
        const row=await store.get<{accountId:string;calendarId:string;commandId:string;outcome:unknown}>(key);
        if(!row || row.data.accountId!==command.accountId || row.data.calendarId!==report.calendarId) throw new Error('meeting_identity_unproven');
        const outcome=meetingOutcomeSchema.parse(row.data.outcome);
        const commandKey=`MEETING_COMMAND#${keyPart(row.data.commandId)}`; const reservationRow=await store.get<unknown>(commandKey);
        const reservation=meetingReservationSchema.parse(reservationRow?.data);
        if(outcome.status!=='booked'||outcome.providerEventId!==report.providerEventId||reservation.intent.accountId!==command.accountId
          ||reservation.identity.calendarId!==report.calendarId||reservation.identity.providerEventId!==report.providerEventId
          ||Date.parse(reservation.intent.end)>Date.parse(report.occurredAt)) throw new Error('meeting_not_elapsed');
        proof.push(store.check(key,row.rev),store.check(commandKey,reservationRow!.rev));
      }
      event=workerEventSchema.parse({...base,kind:'acquisition.milestone_reported',receipt,payload:{commandId:command.commandId,report,observedAt:store.now(),source:'owner_report'}});
    } else if (command.kind === 'campaign-command') {
      const plan = await new WorkerCampaignRepository(store.options).planCommand({ commandId: command.commandId, accountId: command.accountId, payload: command.payload });
      proof = plan.items; event = workerEventSchema.parse({ ...base, kind: 'campaign.changed', payload: plan.payload, receipt });
    } else if (command.kind === 'prepare-manual') {
      const plan = await this.prepareManual(command, principal.pairingId, claim.data.at, store);
      proof = []; finalize = plan.finalize;
      event = workerEventSchema.parse({ ...base, kind: 'manual.handoff', payload: plan.handoff, campaign: plan.campaign, receipt });
    } else if (command.kind === 'complete-manual') {
      const plan = await this.completeManual(command, principal.pairingId, store);
      receipt={...receipt,authorityGeneration:plan.generation};
      proof = plan.items; event = workerEventSchema.parse({ ...base, authorityGeneration:plan.generation, kind: 'manual.outcome', payload: command.payload.outcome, campaign: plan.campaign, receipt });
    } else {
      proof = command.kind === 'configure-owner' ? await this.configure(command, principal.pairingId, claim.data.at, store) : await this.approveReply(command, principal.pairingId, claim.data.at, store);
      event = workerEventSchema.parse({ ...base, kind: 'authority.changed', payload: { authority: current.authority, receipt } });
    }
    const outbox = await store.eventItems(event);
    await store.transact([store.put(authKey, next, authorityRow.rev, executionAuthorityFields(next), executionAuthorityFields(current)),
      store.put(key, { fingerprint: fp, receipt, sequence: outbox.sequence, command }, null), ...finalize(), ...outbox.items]);
    await store.publish(outbox.sequence);
    return receipt;
  }
  private async bootstrap(command:Extract<OwnerCommand,{kind:'bootstrap-selected-account'}>,store:DynamoStore,fp:string,key:string):Promise<CommandReceipt> {
    const p=command.payload;const record=p.record;
    if(command.expectedVersion!==0||command.expectedAuthorityGeneration!==0||record.account.id!==command.accountId||p.asOf>store.now()||Buffer.byteLength(JSON.stringify(p))>200000||record.history.length>200||record.sources.length>100||record.claims.length>500||record.routes.length>500)throw Error('bootstrap_identity_conflict');
    const sources=new Set(record.sources.map(source=>source.id));
    if(record.history.some(item=>item.account.id!==command.accountId||item.at>p.asOf||item.routes.some(route=>route.accountId!==command.accountId||route.evidenceIds.some(id=>!sources.has(id))))||record.routes.some(route=>route.accountId!==command.accountId||route.evidenceIds.some(id=>!sources.has(id)))||record.sources.some(source=>source.fetchedAt>p.asOf)||p.suppression.some(item=>item.observedAt>p.asOf))throw Error('bootstrap_evidence_conflict');
    const aKey=accountKey(command.accountId);const previous=await store.get(aKey);
    if(previous ? p.expectedResearchRevision!==record.researchRevision||fingerprint(accountRecordSchema.parse(previous.data))!==fingerprint(record) : p.expectedResearchRevision!==null||record.researchRevision!==1)throw Error('bootstrap_record_conflict');
    const authKey=executionAuthorityKey(command.accountId);const prior=await store.get<unknown>(authKey);
    if(prior){const parsed=authorityRecordSchema.parse(prior.data);if(parsed.version!==0||parsed.authority.owner!=='local'||parsed.authority.state!=='local'||parsed.authority.generation!==0)throw Error('bootstrap_authority_conflict');}
    const next={authority:{accountId:command.accountId,owner:'local' as const,state:'local' as const,generation:0},version:1};
    const receipt:CommandReceipt={commandId:command.commandId,status:'applied',authorityGeneration:0,aggregateVersion:1,reason:null};
    const event=workerEventSchema.parse({id:`command-${fingerprint([command.workspaceId,command.commandId])}`,workspaceId:command.workspaceId,accountId:command.accountId,authorityGeneration:0,aggregateVersion:1,kind:'account.bootstrap',receipt,payload:{commandId:command.commandId,recordFingerprint:fingerprint(record),researchRevision:record.researchRevision}});
    const outbox=await store.eventItems(event);const suppressionKey=mailSuppressionKey(command.accountId);const suppression=await store.get(suppressionKey);
    await store.transact([previous?store.check(aKey,previous.rev):store.put(aKey,record,null,{accountId:command.accountId,version:record.account.version}),store.put(authKey,next,prior?.rev??null,executionAuthorityFields(next)),store.put(key,{fingerprint:fp,receipt,sequence:outbox.sequence,command},null),...(p.suppression.length&&!suppression?[store.put(suppressionKey,{accountId:command.accountId,source:'selected_owner_bootstrap',evidence:p.suppression},null)]:[]),...outbox.items]);
    await store.publish(outbox.sequence);return receipt;
  }
  private async noMailIntake(accountId:string,store:DynamoStore,scoped?:NonNullable<Awaited<ReturnType<typeof validatePendingHandoff>>>){
    const account=await store.get<unknown>(accountKey(accountId));const key=intakeRegistryKey(accountId);const row=await store.get<unknown>(key);
    if(!account||!row||accountRecordSchema.parse(account.data).routes.some(route=>route.channel==='email')||(await store.list(`MAIL_THREAD#${keyPart(accountId)}#`)).length)throw Error('relevant_mail_requires_reader');
    const registry=intakeRegistrySchema.parse(row.data);if(registry.accountId!==accountId||registry.adapters.some(adapter=>adapter.relevant))throw Error('relevant_mail_requires_reader');
    const checks=[store.check(accountKey(accountId),account.rev),store.check(key,row.rev)];const revisions=[{key,revision:row.rev},{key:accountKey(accountId),revision:account.rev}];
    if(scoped){checks.push(...scoped.checks);revisions.push(...scoped.revisions);}
    for(const dependency of registry.manualDependencies){
      if(scoped&&fingerprint(dependency)===fingerprint(scoped.dependency))continue;
      const commandKey=`COMMAND#${keyPart(dependency.commandId)}`;const command=await store.get<{receipt:CommandReceipt;sequence:number}>(commandKey);if(!command)throw Error('manual_outcome_pending');
      const eventKey=store.eventKey(command.data.sequence);const eventRow=await store.get<{event:unknown}>(eventKey);const event=workerEventSchema.parse(eventRow?.data.event);
      if(commandReceiptSchema.parse(command.data.receipt).status!=='applied'||event.kind!=='manual.outcome'||event.accountId!==accountId||event.workspaceId!==store.options.workspaceId||event.receipt.commandId!==dependency.commandId||event.payload.actionId!==dependency.actionId||event.payload.channel!==dependency.channel||event.payload.outcome!==dependency.outcome||['unknown','reply','opt_out'].includes(dependency.outcome))throw Error('manual_outcome_pending');
      checks.push(store.check(commandKey,command.rev),store.check(eventKey,eventRow!.rev));revisions.push({key:commandKey,revision:command.rev},{key:eventKey,revision:eventRow!.rev});
    }
    return {status:'ready' as const,checks,revisions,validUntil:Math.min(Date.parse(store.now())+5000,scoped?.validUntil??Infinity)};
  }
  private async activeSource(command: Pick<OwnerCommand,'accountId'|'workspaceId'>, pairingId: string, store: DynamoStore, allowNoMail=false) {
    const key = ownerSourceKey(command.accountId); const row = await store.get<unknown>(key);
    if (!row) throw new Error('source_setup_required');
    const config = ownerSourceConfigurationSchema.parse(row.data);
    if (config.state !== 'active' || config.workspaceId !== command.workspaceId || config.accountId !== command.accountId || config.pairingId !== pairingId || (!config.mailboxSubject&&!allowNoMail)) throw new Error('source_paused_or_mismatched');
    if(!config.mailboxSubject)return {config,checks:[store.check(key,row.rev)]};
    const grant = await this.input.authorization.status(pairingId);
    const grantKey = `GOOGLE_GRANT#${keyPart(pairingId)}`; const grantRow = await store.get(grantKey);
    if (grant.state !== 'ready' || grant.grant?.subject !== config.mailboxSubject || !grantRow) throw new Error('source_grant_unavailable');
    return { config, checks: [store.check(key,row.rev), store.check(grantKey,grantRow.rev)] };
  }
  private async prepareManual(command: Extract<OwnerCommand,{kind:'prepare-manual'}>, pairingId: string, at: string, store: DynamoStore) {
    const p = command.payload; const source = await this.activeSource(command,pairingId,store,true);
    const repo = new WorkerCampaignRepository(store.options);
    const route = await repo.accountRoute(command.accountId,p.routeId);
    if (route.route.version !== p.routeVersion || route.route.channel !== (p.channel === 'call' ? 'phone' : 'linkedin')
      || createHash('sha256').update(route.route.value).digest('hex') !== p.targetHash || route.route.verification === 'unverified') throw new Error('manual_target_mismatch');
    const record = accountRecordSchema.parse(route.row.data);
    if (!route.route.evidenceIds.length || route.route.evidenceIds.some(id => !record.sources.some(source => source.id === id && source.permitted))) throw new Error('manual_target_unproven');
    const input = { workspaceId: command.workspaceId, accountId: command.accountId, ...p.campaign, actionId:p.actionId, channel:p.channel,
      authorityGeneration:command.expectedAuthorityGeneration,selectedRouteId:p.routeId,contextRevision:p.contextRevision,contentHash:p.contentHash,targetHash:p.targetHash };
    const expiresAt = new Date(Date.parse(at)+60000).toISOString();
    const plan = await new CampaignExecution(repo).prepareManualChecks(input);
    const intake = source.config.mailboxSubject?await createIntakeBarrier(store).check({accountId:command.accountId,mailboxSubject:source.config.mailboxSubject},new AbortController().signal):await this.noMailIntake(command.accountId,store);
    if (intake.status !== 'ready') throw new Error('manual_intake_unavailable');
    if (await store.get(mailSuppressionKey(command.accountId))) throw new Error('manual_account_suppressed');
    const handoff = manualHandoffSchema.parse({...p,handoffId:`handoff-${fingerprint([command.workspaceId,command.commandId])}`,expiresAt});
    const registryKey = intakeRegistryKey(command.accountId); const registryRow = await store.get<unknown>(registryKey);
    if (!registryRow || intake.revisions.find(row=>row.key===registryKey)?.revision!==registryRow.rev) throw new Error('manual_intake_changed');
    const registry = intakeRegistrySchema.parse(registryRow.data);
    const items = [...source.checks,...intake.checks.filter(item=>item.ConditionCheck?.Key?.sk?.S!==registryKey),store.absent(mailSuppressionKey(command.accountId)),
      store.put(registryKey,{...registry,manualDependencies:[...registry.manualDependencies,{commandId:command.commandId,actionId:p.actionId,channel:p.channel,outcome:'pending'}]},registryRow.rev),
      store.put(`MANUAL_HANDOFF#${keyPart(handoff.handoffId)}`,{handoff,accountId:command.accountId,pairingId,generation:command.expectedAuthorityGeneration,issuedAt:at,lastOutcome:null},null),
      store.put(`MANUAL_ACTION#${keyPart(command.accountId)}#${keyPart(p.actionId)}`,{handoffId:handoff.handoffId},null)];
    return {handoff,campaign:campaignEventPayloadSchema.parse({commandId:command.commandId,version:null,enrollment:null,evidence:null,cap:plan.cap}),finalize:()=>{ if(store.now()>=expiresAt||Date.parse(store.now())>=intake.validUntil) throw new Error('manual_proof_expired'); const all=[...items,...plan.finalize()];return all.filter((item,index)=>!item.ConditionCheck||all.findIndex(other=>fingerprint(other)===fingerprint(item))===index); }};
  }
  private async completeManual(command: Extract<OwnerCommand,{kind:'complete-manual'}>,pairingId:string,store:DynamoStore) {
    const p=command.payload; const key=`MANUAL_HANDOFF#${keyPart(p.handoffId)}`;
    const row=await store.get<{handoff:ManualHandoff;accountId:string;pairingId:string;generation:number;issuedAt:string;lastOutcome:ManualOutcome|null}>(key);
    if(!row) throw new Error('manual_handoff_missing');
    const handoff=manualHandoffSchema.parse(row.data.handoff); const outcome=p.outcome;
    if(row.data.accountId!==command.accountId||row.data.pairingId!==pairingId||row.data.generation>command.expectedAuthorityGeneration
      ||handoff.targetHash!==p.targetHash||handoff.actionId!==outcome.actionId||handoff.channel!==outcome.channel||outcome.observedAt<row.data.issuedAt||outcome.observedAt>store.now()) throw new Error('manual_outcome_identity');
    const repo=new WorkerCampaignRepository(store.options);
    const reservation=campaignReservationSchema.parse((await repo.required(campaignReservationKey(command.accountId,outcome.actionId))).data);
    if(reservation.input.authorityGeneration!==row.data.generation)throw Error('manual_original_generation_conflict');
    const enrollment=enrollmentSchema.parse((await repo.required(campaignEnrollmentKey(handoff.campaign.enrollmentId))).data);
    const actual=outcome.channel==='call' ? ['connected','no_answer','voicemail','busy','wrong_number'].includes(outcome.outcome) : outcome.outcome==='human_reported_sent';
    const definitiveNotSent=['not_sent','not_called'].includes(outcome.outcome);
    const contradiction=reservation.state==='cancelled'&&actual||reservation.state==='sent'&&definitiveNotSent;
    if(row.data.lastOutcome && (Date.parse(outcome.observedAt)<Date.parse(row.data.lastOutcome.observedAt) || row.data.lastOutcome.outcome==='opt_out' || !contradiction && (['unknown','cancelled'].includes(row.data.lastOutcome.outcome) ? outcome.outcome===row.data.lastOutcome.outcome : !['no_reply','reply','opt_out'].includes(outcome.outcome)))) throw new Error('manual_outcome_conflict');
    const state=definitiveNotSent?'cancelled' as const:actual||row.data.lastOutcome && reservation.state==='sent' ? 'human_reported_sent' as const : outcome.outcome==='cancelled'?'cancelled' as const:'unknown' as const;
    const plan=await repo.planCommand({commandId:command.commandId,accountId:command.accountId,payload:{kind:'campaign.outcome',enrollmentId:enrollment.id,expectedEnrollmentVersion:enrollment.version,
      evidence:{enrollmentId:reservation.input.enrollmentId,accountId:reservation.input.accountId,campaignVersionId:reservation.campaignVersionId,actionId:outcome.actionId,stepId:reservation.input.stepId,routeId:reservation.input.selectedRouteId,routeVersion:reservation.routeVersion,
        contextRevision:reservation.numericContextRevision,executionContextId:reservation.input.contextRevision,channel:outcome.channel,
        observedAt:outcome.observedAt,outcome:outcome.outcome,observation:outcome.outcome==='no_reply'?'no_reply':outcome.outcome==='reply'?'replied':'unknown',source:'human',state}}});
    const registryKey=intakeRegistryKey(command.accountId); const registryRow=await store.get<unknown>(registryKey);
    if(!registryRow) throw new Error('manual_intake_missing'); const registry=intakeRegistrySchema.parse(registryRow.data);
    const items=[...plan.items,store.put(key,{...row.data,lastOutcome:plan.payload.evidence?.conflict?row.data.lastOutcome:outcome},row.rev),store.put(registryKey,{...registry,manualDependencies:registry.manualDependencies.map(dependency=>dependency.actionId===outcome.actionId?{commandId:command.commandId,actionId:outcome.actionId,channel:outcome.channel,outcome:plan.payload.evidence?.conflict||outcome.outcome==='cancelled'?'unknown':outcome.outcome}:dependency)},registryRow.rev)];
    if(outcome.outcome==='opt_out' && !await store.get(mailSuppressionKey(command.accountId))) items.push(store.put(mailSuppressionKey(command.accountId),{accountId:command.accountId,observedAt:outcome.observedAt,evidence:outcome.evidenceRef},null));
    return {items,campaign:plan.payload,generation:row.data.generation};
  }
  private async configure(command: Extract<OwnerCommand, { kind: 'configure-owner' }>, pairingId: string, at: string, store: DynamoStore): Promise<TransactWriteItem[]> {
    const p = command.payload; const config = ownerSourceConfigurationSchema.parse(p.configuration);
    if (config.workspaceId !== command.workspaceId || config.accountId !== command.accountId || config.pairingId !== pairingId
      || config.revision !== p.expectedConfigurationRevision + 1 || config.research && config.research.workspaceId !== command.workspaceId) throw new Error('source_configuration_identity');
    const key = ownerSourceKey(command.accountId); const previous = await store.get<unknown>(key);
    if ((previous ? ownerSourceConfigurationSchema.parse(previous.data).revision : 0) !== p.expectedConfigurationRevision) throw new Error('stale_source_configuration');
    const checks: TransactWriteItem[] = [];
    if (config.state === 'active' && config.mailboxSubject !== null) {
      const grant = await this.input.authorization.status(pairingId);
      if (grant.state !== 'ready' || grant.grant?.subject !== config.mailboxSubject || !grant.grant.grantedScopes.includes('https://www.googleapis.com/auth/gmail.readonly')) throw new Error('source_grant_unavailable');
      const grantRow = await store.get(`GOOGLE_GRANT#${keyPart(pairingId)}`); if (!grantRow) throw new Error('source_grant_unavailable');
      checks.push(store.check(`GOOGLE_GRANT#${keyPart(pairingId)}`, grantRow.rev));
      const recordRow = await store.get<unknown>(accountKey(command.accountId)); if (!recordRow) throw new Error('selected_account_missing');
      const record = accountRecordSchema.parse(recordRow.data);
      if (record.account.id !== command.accountId) throw new Error('selected_account_mismatch');
      const routes = record.routes.filter(route => route.accountId === command.accountId && route.channel === 'email' && !record.routes.some(next => next.id === route.id && next.version > route.version));
      if (routes.some(route => route.evidenceIds.length === 0 || route.evidenceIds.some(id => !record.sources.some(source => source.id === id && source.permitted)))) throw new Error('selected_scope_provenance_missing');
      const threadRows = await store.list<unknown>(`MAIL_THREAD#${keyPart(command.accountId)}#`);
      const projections = threadRows.map(row => ({ ...row, projection: threadProjectionSchema.parse(row.stored.data) })).filter(row => row.projection.thread.mailboxSubject === config.mailboxSubject);
      if (projections.some(row => row.projection.thread.accountId !== command.accountId)) throw new Error('selected_scope_identity');
      const participants = [...new Set([...routes.map(route => route.value.toLowerCase()), ...projections.flatMap(row => row.projection.thread.messages.flatMap(message => [...message.from,...message.to,...message.cc]))]
        .filter(address => address !== grant.grant!.email.toLowerCase()))].sort();
      const knownThreadIds = [...new Set(projections.map(row => row.projection.thread.providerThreadId))].sort();
      const threads = new DynamoThreadIntakeRepository(store.options); let cursor = await threads.cursorState(command.accountId, config.mailboxSubject);
      const retained=cursor?.data.scope?.participantAddresses.filter(address=>!participants.includes(address))??[];
      if(retained.length){
        // Retain only already-admitted addresses grounded in an authentic capture.
        // Neither configure payload nor a bare cursor can manufacture a participant.
        if(retained.length>16)throw Error('requested_scope_proof_limit');
        const needed=new Set(retained),lookupSignal=AbortSignal.timeout(15000);let start:Record<string,AttributeValue>|undefined;
        do {
          lookupSignal.throwIfAborted();
          const page=await store.options.dynamo.send(new QueryCommand({TableName:store.options.tableName,ConsistentRead:true,Limit:100,
            KeyConditionExpression:'#pk = :pk AND begins_with(#sk, :prefix)',ExpressionAttributeNames:{'#pk':'pk','#sk':'sk'},
            ExpressionAttributeValues:{':pk':store.key('').pk,':prefix':{S:'REQUESTED_APPROVAL#'}},ExclusiveStartKey:start}));
          lookupSignal.throwIfAborted();
          for(const item of page.Items??[]){
            if(!item.data?.S)throw Error('corrupt_record');const candidate=requestedApprovalRecordSchema.parse(JSON.parse(item.data.S)),address=candidate.draftSnapshot.recipient;
            if(!needed.has(address)||candidate.accountId!==command.accountId||candidate.pairingId!==pairingId||candidate.mailboxSubject!==config.mailboxSubject||!candidate.scopePlan?.desiredScope.participantAddresses.includes(address))continue;
            const proof=await loadRequestedApproval(store,candidate.commandId);
            if(!proof||fingerprint(proof.record)!==fingerprint(candidate))throw Error('selected_scope_provenance_missing');
            participants.push(address);checks.push(...proof.checks);needed.delete(address);if(!needed.size)break;
          }
          start=page.LastEvaluatedKey;
        }while(needed.size&&start&&Object.keys(start).length);
        if(needed.size)throw Error('selected_scope_provenance_missing');
        participants.sort();
      }
      if (p.mailScope !== null) {
        const scope = mailAccountScopeSchema.parse({ version: 1, accountId: command.accountId, mailboxSubject: config.mailboxSubject, revision: (cursor?.data.scope?.revision ?? 0) + 1,
          participantAddresses: participants, knownThreadIds, since: p.mailScope.since, approvedAt: at });
        await threads.admitScope(scope, p.mailScope.expectedEnvelopeRevision);
        cursor = await threads.cursorState(command.accountId, config.mailboxSubject);
      }
      const scope = cursor?.data.scope;
      if (!scope || scope.participantAddresses.some(address => !participants.includes(address)) || participants.some(address => !scope.participantAddresses.includes(address))
        || knownThreadIds.some(id => !scope.knownThreadIds.includes(id))) throw new Error('selected_scope_incomplete');
      checks.push(store.check(accountKey(command.accountId), recordRow.rev), store.check(mailCursorKey(command.accountId, config.mailboxSubject), cursor!.rev),
        ...projections.map(row => store.check(row.key, row.stored.rev)));
      const intakeKey = intakeRegistryKey(command.accountId); const intake = await store.get<unknown>(intakeKey);
      const old = intake ? intakeRegistrySchema.parse(intake.data) : null;
      if (old && old.adapters.some(adapter => adapter.enabled && adapter.relevant && (adapter.kind !== 'gmail' || adapter.mailboxSubject !== config.mailboxSubject))) throw new Error('selected_intake_conflict');
      checks.push(store.put(intakeKey, { accountId: command.accountId, adapters: [{ id: 'configured-gmail', kind: 'gmail', enabled: true, relevant: true, mailboxSubject: config.mailboxSubject }], manualDependencies: old?.manualDependencies ?? [] }, intake?.rev ?? null));
    } else if(config.state==='active'&&config.mailboxSubject===null){
      if(p.mailScope!==null||config.calendarId!==null)throw Error('no_mail_configuration_conflict');
      const account=await store.get<unknown>(accountKey(command.accountId));if(!account||accountRecordSchema.parse(account.data).routes.some(route=>route.channel==='email')||(await store.list(`MAIL_THREAD#${keyPart(command.accountId)}#`)).length)throw Error('relevant_mail_requires_reader');
      const intakeKey=intakeRegistryKey(command.accountId);const prior=await store.get<unknown>(intakeKey);const registry=prior?intakeRegistrySchema.parse(prior.data):null;
      if(registry?.adapters.some(adapter=>adapter.relevant))throw Error('cannot_narrow_mail_scope');
      checks.push(store.check(accountKey(command.accountId),account.rev),store.put(intakeKey,{accountId:command.accountId,adapters:[],manualDependencies:registry?.manualDependencies??[]},prior?.rev??null));
    } else if (p.mailScope !== null) throw new Error('inactive_scope_change');
    return [...checks, store.put(key, config, previous?.rev ?? null)];
  }
  private async approveReply(command: Extract<OwnerCommand, { kind: 'approve-reply' }>, pairingId: string, at: string, store: DynamoStore) {
    const p = command.payload; const draft = p.draft;
    if(p.schedulingOffer) {
      const {offer,expectedRevision}=p.schedulingOffer;
      if(!offer.meeting||offer.accountId!==command.accountId||offer.threadId!==draft.threadId||offer.mailboxSubject!==draft.mailboxSubject||offer.sendCommandId!==p.intentCommandId||offer.revision!==(expectedRevision??0)+1||offer.expiresAt<=at||offer.slots.some(slot=>slot.end<=slot.start)||draft.body.trim()!==offer.slots.map(offeredSlotText).join('\n')) throw new Error('offer_content_conflict');
    }

    if (draft.accountId !== command.accountId || draft.updatedAt > at || p.expiresAt <= at || p.permission.expiresAt <= at
      || Date.parse(p.expiresAt) - Date.parse(at) > 86400000 || Date.parse(p.permission.expiresAt) - Date.parse(at) > 86400000) throw new Error('approval_not_current');
    const threads = new DynamoThreadIntakeRepository(store.options);
    const projection = await threads.getThread(command.accountId, draft.threadId);
    if (!projection || projection.revision !== draft.threadRevision || projection.contextRevision !== draft.contextRevision
      || projection.thread.mailboxSubject !== draft.mailboxSubject || projection.signals.some(signal => signal.kind === 'opt_out')) throw new Error('thread_not_current');
    const source = projection.thread.messages.find(message => message.id === p.permission.sourceMessageId);
    if (!source || !source.rfcMessageId || fingerprint(source) !== p.permission.sourceMessageHash) throw new Error('recipient_permission_unproven');
    const saved = await threads.getReplyDraft(command.accountId, draft.id);
    if (!saved || saved.stale) throw new Error('approval_not_current');
    if (fingerprint(saved.draft) !== fingerprint(draft)) await threads.saveReplyDraft(draft, p.expectedRemoteDraftRevision);
    const policy = new DynamoDispatchRepository(store.options, this.input.authorization);
    const message = { commandId: p.intentCommandId, from: draft.sender, to: draft.recipient, subject: draft.subject, body: draft.body,
      threadId: draft.threadId, inReplyTo: source.rfcMessageId, references: [...new Set([...source.references, source.rfcMessageId])] };
    const intent: DispatchIntent = { commandId: p.intentCommandId, kind: 'standalone_reply', action: { actionId: p.actionId, workspaceId: command.workspaceId,
      accountId: command.accountId, expectedAuthorityGeneration: command.expectedAuthorityGeneration, approvalId: p.approvalId,
      contentHash: fingerprint(message), targetHash: fingerprint({ sender: draft.sender, recipient: draft.recipient, threadId: draft.threadId }) },
      draftId: draft.id, draftRevision: draft.revision, pairingId, mailboxSubject: draft.mailboxSubject, frozenMessage: message, binding: p.binding };
    const permission = { ...p.permission, accountId: command.accountId, recipient: draft.recipient, sender: draft.sender, threadId: draft.threadId, recordedAt: at };
    const approval = { id: p.approvalId, commandId: p.intentCommandId, intentHash: fingerprint(intent), draft, permissionEvidenceId: permission.id, approvedAt: at, expiresAt: p.expiresAt };
    const immutable = async (key: string, value: unknown, admit: () => Promise<void>) => {
      const previous = await store.get(key);
      if (await store.get(`REVOKED#${key}`)) throw new Error('approval_revoked');
      if (previous) { if (fingerprint(previous.data) !== fingerprint(value)) throw new Error('approval_fingerprint_conflict'); }
      else await admit();
    };
    await immutable(dispatchPermissionKey(command.accountId, permission.id), permission, () => policy.admitPermission(permission));
    await immutable(dispatchApprovalKey(approval.id), approval, () => policy.admitApproval(approval));
    await immutable(dispatchIntentKey(intent.commandId), intent, () => policy.admitIntent(intent));
    const execution = createExecutionRepository(store.options);
    if (!await execution.readDispatch(command.accountId, p.actionId)) await execution.prepareAction({ ...intent.action, expectedVersion: command.expectedVersion });
    const keys = [dispatchPermissionKey(command.accountId, permission.id), dispatchApprovalKey(approval.id), dispatchIntentKey(intent.commandId),
      `MAIL_DRAFT#${keyPart(command.accountId)}#${keyPart(draft.id)}`, mailThreadKey(command.accountId, draft.threadId)];
    return Promise.all(keys.map(async key => {
      const row = await store.get(key); if (!row) throw new Error('approval_evidence_missing');
      return store.check(key, row.rev);
    }));
  }
}
