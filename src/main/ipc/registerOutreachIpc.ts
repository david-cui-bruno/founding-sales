import { getAccountPreparationSchema, accountPreparationReplySchema, accountPreparationReadResultSchema, AccountPreparationReadFailure } from '../../shared/contracts/accountPreparationContract';
import { reconcileReplyDraftSchema, editReplyDraftSchema, replyDraftResultSchema, boundReplyDraftResult } from '../../shared/contracts/mailThreadContract';
import { admitReplyFirstDraftSchema, replyFirstDraftResultSchema, boundReplyFirstDraftResult, approveReplySchema, submitApprovedReplySchema,
  replyApprovalStatusSchema, boundReplyApprovalStatus, suppressionListSchema } from '../../shared/contracts/replyFirstDraftContract';
import { delegatedPhoneStateRequestSchema, delegatedPhoneStateSchema, delegatedPhoneStateReplySchema } from '../../shared/contracts/delegatedPhoneStateContract';
import {googleConnectionSelectorSchema,googleConsentOpenedSchema,googleConnectionStatusResultSchema,GoogleConnectionStatusFailure} from '../../shared/contracts/remoteGoogleConnectionsContract';
import {researchSetupApproveInputSchema,researchSetupSetStateInputSchema,researchSetupReceiptSchema,researchSetupStatusSchema} from '../../shared/contracts/researchSetupContract';
import {remoteGoogleGrantBeginSchema,remoteGoogleGrantDisclosureSchema,remoteGoogleGrantStatusSchema} from '../../shared/contracts/remoteGoogleGrantContract';
import {policyImportConfirmSchema,policyImportResumeSchema,policyImportStatusSchema,policyImportPreviewSchema,policyImportReportSchema} from '../../shared/contracts/accountRoutePolicyImportContract';
import {prepareRequestedFollowupSchema,getRequestedFollowupSchema,editRequestedFollowupSchema,approveRequestedFollowupSchema,savedRequestedFollowupSchema,requestedApprovalStatusSchema} from '../../shared/contracts/requestedFollowupContract';
import {workerPolicyRequestSchema,workerPolicyReceiptSchema} from '../../shared/contracts/workerPolicyContract';
import {configureAccountIntakeSchema,accountIntakeConfigureStatusSchema,boundAccountIntakeConfigureStatus} from '../../shared/contracts/accountIntakeConfigureContract';
import {territoryCallPolicyRequestSchema,territoryCallPolicyStatusSchema} from '../../shared/contracts/territoryCallPolicyContract';
import {saveAccountCallbackSchema,closeAccountCallbackSchema,readAccountCallbacksSchema,accountCallbackListSchema,neverCallAccountSchema,neverCallReceiptSchema,type SaveAccountCallback,type CloseAccountCallback,type ReadAccountCallbacks,type NeverCallAccount,type NeverCallReceipt} from '../../shared/contracts/accountCallbackContract';
import type {AccountCallback} from '../../shared/contracts/dailyContract';
import type { DelegationRuntime } from '../delegation/delegationRuntime';
import type { PairingStore } from '../delegation/pairingStore';
import { delegatedPhoneHandoffRequestSchema,bootstrapSelectedAccountSchema,refreshSelectedAccountRecordSchema,selectedAccountFreshnessRequestSchema,selectedAccountFreshnessSchema,configureResearchSourceSchema,ownerResearchSourceSchema,configureLocalDelegationSchema,localDelegationStatusSchema,localDelegationConfigurationRecordSchema,redeemLocalPairingSchema,redeemedLocalPairingSchema,delegationSyncReportSchema } from '../../shared/contracts/ownerCommandContract';
import {delegatedPhoneHandoffResultSchema,publicDelegationCommandSchema,commandReceiptSchema} from '../../shared/contracts/delegationContract';
import type { z } from 'zod';
import { configureOutreachSchema,draftRevisionSchema,emailDraftSchema,localEmailAuthorityReadSchema,openDraftSchema,outreachStatusSchema,
  saveDraftSchema,sendDraftSchema,type OutreachApi } from '../../shared/contracts/outreachContract';
import { registerValidatedIpc } from './registerValidatedIpc';

/** Purely local callback storage. Nothing here dials, sends, books or queues an owner command. */
export type AccountCallbackApi = {
  list(request:ReadAccountCallbacks):Promise<AccountCallback[]>;
  save(request:SaveAccountCallback):Promise<AccountCallback>;
  close(request:CloseAccountCallback):Promise<AccountCallback>;
  /** Writes the existing account tombstone only. Never dials, prepares a handoff or records an outcome. */
  neverCall(request:NeverCallAccount):Promise<NeverCallReceipt>;
};
export function registerOutreachIpc(options:{provider:OutreachApi;delegation?:DelegationRuntime;callbacks?:AccountCallbackApi;pairingStore?:Pick<PairingStore,'redeem'>;isTrustedRendererUrl?:(url:string)=>boolean}):()=>void {
  const removers:(()=>void)[]=[];
  const add=<Request,Response>(name:string,requestSchema:z.ZodType<Request>|null,responseSchema:z.ZodType<Response>,handler:(request:Request)=>Promise<Response>)=>{
    removers.push(registerValidatedIpc({channel:`outreach:${name}`,requestSchema,responseSchema,handler,
      safeErrorCode:'OUTREACH_REQUEST_FAILED',isTrustedRendererUrl:options.isTrustedRendererUrl}));
  };
  try {
    const p=options.provider;
    add('status',null,outreachStatusSchema,()=>p.status());
    add('configure',configureOutreachSchema,outreachStatusSchema,input=>p.configure(input));
    add('connect-gmail',null,outreachStatusSchema,()=>p.connectGmail());
    add('disconnect-gmail',null,outreachStatusSchema,()=>p.disconnectGmail());
    add('open-draft',openDraftSchema,emailDraftSchema,input=>p.openDraft(input));
    add('save-draft',saveDraftSchema,emailDraftSchema,input=>p.saveDraft(input));
    add('generate-draft',draftRevisionSchema,emailDraftSchema,input=>p.generateDraft(input));
    add('send-draft',sendDraftSchema,emailDraftSchema,input=>p.sendDraft(input));
    removers.push(registerValidatedIpc({channel:'outreach:inspect-local-authority',requestSchema:draftRevisionSchema,
      responseSchema:localEmailAuthorityReadSchema,safeErrorCode:'EMAIL_AUTHORITY_READ_FAILED',
      isTrustedRendererUrl:options.isTrustedRendererUrl,handler:async input=>{
        const result=localEmailAuthorityReadSchema.parse(await p.inspectLocalAuthority(input));
        if(result.draftId!==input.draftId||result.expectedRevision!==input.expectedRevision)throw new Error('email_authority_binding_changed');
        return result;
      }}));
    if(options.delegation){
      const d=options.delegation;
      add('reply-reconcile', reconcileReplyDraftSchema, replyDraftResultSchema, async request => boundReplyDraftResult(request).parse(await d.reconcileReplyDraft(request)));
      add('reply-edit', editReplyDraftSchema, replyDraftResultSchema, async request => boundReplyDraftResult(request).parse(await d.editReplyDraft(request)));
      // D9: the first draft is written in main with the founder's own key; the renderer never sees the key
      // and never calls a model. Approving records the approval, submitting is the one step that sends.
      add('reply-admit-first-draft', admitReplyFirstDraftSchema, replyFirstDraftResultSchema, async request => boundReplyFirstDraftResult(request).parse(await d.admitReplyFirstDraft(request)));
      add('reply-approve', approveReplySchema, replyApprovalStatusSchema, async request => boundReplyApprovalStatus(request).parse(await d.approveReply(request)));
      add('reply-submit-approved', submitApprovedReplySchema, replyApprovalStatusSchema, async request => boundReplyApprovalStatus(request).parse(await d.submitApprovedReply(request)));
      // Settings → Suppressed: a local read with no undo. It writes nothing and queues no command.
      add('suppression-read', null, suppressionListSchema, () => d.readSuppression());
      if(d.researchSetup){
        const research=d.researchSetup;
        add('research-setup-status',null,researchSetupStatusSchema,()=>research.status());
        add('research-setup-approve',researchSetupApproveInputSchema,researchSetupReceiptSchema,input=>research.approve(input));
        add('research-setup-set-state',researchSetupSetStateInputSchema,researchSetupReceiptSchema,input=>research.setState(input));
        add('research-setup-retry',null,researchSetupReceiptSchema,()=>research.retry());
        add('research-setup-cancel-pending',null,researchSetupReceiptSchema,()=>research.cancelPending());
      }
      if(d.googleConnections){
        const google=d.googleConnections;
        // Only the transport's allowlisted worker reason crosses, as a reply field; every other cause stays the fixed safe code.
        add('google-connection-status',googleConnectionSelectorSchema,googleConnectionStatusResultSchema,async input=>{
          try{return await google.status(input);}
          catch(error){if(error instanceof GoogleConnectionStatusFailure)return {unavailable:error.reason};throw error;}
        });
        add('google-connection-disclosure',googleConnectionSelectorSchema,remoteGoogleGrantDisclosureSchema,input=>google.disclosure(input));
        add('google-connection-begin',remoteGoogleGrantBeginSchema,googleConsentOpenedSchema,input=>google.begin(input));
        add('google-connection-revoke',googleConnectionSelectorSchema,remoteGoogleGrantStatusSchema,input=>google.revoke(input));
      }
      if(d.policyImport){
        const p=d.policyImport;
        add('policy-import-select-preview',null,policyImportPreviewSchema.nullable(),()=>p.selectAndPreview());
        add('policy-import-confirm',policyImportConfirmSchema,policyImportReportSchema,input=>p.confirm(input));
        add('policy-import-resume',policyImportResumeSchema,policyImportReportSchema,input=>p.resume(input));
        add('policy-import-status',policyImportStatusSchema,policyImportReportSchema,input=>p.status(input));
      }
      add('requested-followup-prepare',prepareRequestedFollowupSchema,savedRequestedFollowupSchema,input=>d.prepareRequestedFollowup(input));
      add('requested-followup-get',getRequestedFollowupSchema,savedRequestedFollowupSchema.nullable(),input=>d.getRequestedFollowup(input));
      add('requested-followup-edit',editRequestedFollowupSchema,savedRequestedFollowupSchema,input=>d.editRequestedFollowup(input));
      add('requested-followup-approve',approveRequestedFollowupSchema,requestedApprovalStatusSchema,input=>d.approveRequestedFollowup(input));
      add('delegation-get-phone-handoff-state',delegatedPhoneStateRequestSchema,delegatedPhoneStateSchema,async request=>delegatedPhoneStateReplySchema(request).parse(await d.getPhoneHandoffState(request)));
      add('delegation-begin-phone',delegatedPhoneHandoffRequestSchema,delegatedPhoneHandoffResultSchema,input=>d.beginPhone(input));
      add('delegation-bootstrap',bootstrapSelectedAccountSchema,commandReceiptSchema,input=>d.bootstrap(input));
      add('delegation-policy',workerPolicyRequestSchema,workerPolicyReceiptSchema,input=>d.configurePolicy(input));
      add('delegation-research',configureResearchSourceSchema,ownerResearchSourceSchema,input=>d.configureResearch(input));
      add('delegation-status',null,localDelegationStatusSchema,()=>d.status());
      add('delegation-configure',configureLocalDelegationSchema,localDelegationConfigurationRecordSchema,input=>d.configure(input));
      add('delegation-submit',publicDelegationCommandSchema,commandReceiptSchema,input=>d.submit(input));
      add('delegation-sync',null,delegationSyncReportSchema,()=>d.sync());
      // Only the transport's allowlisted worker reason crosses, as a reply field; every other cause stays the fixed safe code.
      add('delegation-get-account-preparation',getAccountPreparationSchema,accountPreparationReadResultSchema,async request=>{
        try{return accountPreparationReplySchema(request).parse(await d.getAccountPreparation(request));}
        catch(error){if(error instanceof AccountPreparationReadFailure)return {unavailable:error.reason};throw error;}
      });
      add('delegation-configure-intake',configureAccountIntakeSchema,accountIntakeConfigureStatusSchema,async request=>boundAccountIntakeConfigureStatus(request).parse(await d.configureIntake(request)));
      // The renderer names only the command and the company; the trusted exporter builds the record in main.
      add('delegation-refresh-selected-account',refreshSelectedAccountRecordSchema,commandReceiptSchema,async request=>{
        const receipt=await d.refreshSelectedAccount(request);
        if(receipt.commandId!==request.commandId)throw new Error('refresh_receipt_identity_mismatch');
        return receipt;
      });
      add('delegation-selected-account-freshness',selectedAccountFreshnessRequestSchema,selectedAccountFreshnessSchema,async request=>{
        const freshness=await d.getSelectedAccountFreshness(request);
        if(freshness.accountId!==request.accountId)throw new Error('selected_account_freshness_identity_mismatch');
        return freshness;
      });
      // One workspace-level policy command or read; the reply's receipt must name the request's command.
      add('delegation-territory-policy',territoryCallPolicyRequestSchema,territoryCallPolicyStatusSchema,async request=>{
        const status=await d.territoryPolicy(request);
        if(request.kind==='read'?status.receipt!==null:status.receipt?.commandId!==request.commandId)throw new Error('territory_policy_receipt_identity_mismatch');
        return status;
      });
    }
    if(options.callbacks){
      const callbacks=options.callbacks;
      // Local record only: saving a promised callback never dials, sends, books or queues an owner command.
      add('callback-list',readAccountCallbacksSchema,accountCallbackListSchema,request=>callbacks.list(request));
      add('callback-save',saveAccountCallbackSchema,accountCallbackListSchema.element,async request=>{
        const saved=await callbacks.save(request);
        if(saved.accountId!==request.accountId||saved.sourceCommandId!==request.sourceCommandId||saved.dueOn!==request.dueOn)throw new Error('account_callback_identity_mismatch');
        return saved;
      });
      add('callback-close',closeAccountCallbackSchema,accountCallbackListSchema.element,async request=>{
        const closed=await callbacks.close(request);
        if(closed.id!==request.id||closed.state!==request.state||closed.revision!==request.expectedRevision+1)throw new Error('account_callback_identity_mismatch');
        return closed;
      });
      // Never call: the same suppression the opt-out outcome writes, after the renderer's two confirmations. No dial, no handoff.
      add('never-call',neverCallAccountSchema,neverCallReceiptSchema,async request=>{
        const receipt=await callbacks.neverCall(request);
        if(receipt.accountId!==request.accountId)throw new Error('never_call_identity_mismatch');
        return receipt;
      });
    }
    if(options.pairingStore)add('delegation-pair',redeemLocalPairingSchema,redeemedLocalPairingSchema,input=>options.pairingStore!.redeem(input,AbortSignal.timeout(15000)));

  }catch(error){removers.reverse().forEach(remove=>remove());throw error;}
  let disposed=false;
  return ()=>{if(disposed)return;disposed=true;removers.reverse().forEach(remove=>remove());};
}
