import {googleConnectionSelectorSchema,googleConsentOpenedSchema} from '../../shared/contracts/remoteGoogleConnectionsContract';
import {remoteGoogleGrantBeginSchema,remoteGoogleGrantDisclosureSchema,remoteGoogleGrantStatusSchema} from '../../shared/contracts/remoteGoogleGrantContract';
import {policyImportConfirmSchema,policyImportResumeSchema,policyImportStatusSchema,policyImportPreviewSchema,policyImportReportSchema} from '../../shared/contracts/accountRoutePolicyImportContract';
import {prepareRequestedFollowupSchema,getRequestedFollowupSchema,editRequestedFollowupSchema,approveRequestedFollowupSchema,savedRequestedFollowupSchema,requestedApprovalStatusSchema} from '../../shared/contracts/requestedFollowupContract';
import {workerPolicyRequestSchema,workerPolicyReceiptSchema} from '../../shared/contracts/workerPolicyContract';
import type { DelegationRuntime } from '../delegation/delegationRuntime';
import type { PairingStore } from '../delegation/pairingStore';
import { delegatedPhoneHandoffRequestSchema,bootstrapSelectedAccountSchema,configureResearchSourceSchema,ownerResearchSourceSchema,configureLocalDelegationSchema,localDelegationStatusSchema,localDelegationConfigurationRecordSchema,redeemLocalPairingSchema,redeemedLocalPairingSchema,delegationSyncReportSchema } from '../../shared/contracts/ownerCommandContract';
import {delegatedPhoneHandoffResultSchema,publicDelegationCommandSchema,commandReceiptSchema} from '../../shared/contracts/delegationContract';
import type { z } from 'zod';
import { configureOutreachSchema,draftRevisionSchema,emailDraftSchema,localEmailAuthorityReadSchema,openDraftSchema,outreachStatusSchema,
  saveDraftSchema,sendDraftSchema,type OutreachApi } from '../../shared/contracts/outreachContract';
import { registerValidatedIpc } from './registerValidatedIpc';

export function registerOutreachIpc(options:{provider:OutreachApi;delegation?:DelegationRuntime;pairingStore?:Pick<PairingStore,'redeem'>;isTrustedRendererUrl?:(url:string)=>boolean}):()=>void {
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
      if(d.googleConnections){
        const google=d.googleConnections;
        add('google-connection-status',googleConnectionSelectorSchema,remoteGoogleGrantStatusSchema,input=>google.status(input));
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
      add('delegation-begin-phone',delegatedPhoneHandoffRequestSchema,delegatedPhoneHandoffResultSchema,input=>d.beginPhone(input));
      add('delegation-bootstrap',bootstrapSelectedAccountSchema,commandReceiptSchema,input=>d.bootstrap(input));
      add('delegation-policy',workerPolicyRequestSchema,workerPolicyReceiptSchema,input=>d.configurePolicy(input));
      add('delegation-research',configureResearchSourceSchema,ownerResearchSourceSchema,input=>d.configureResearch(input));
      add('delegation-status',null,localDelegationStatusSchema,()=>d.status());
      add('delegation-configure',configureLocalDelegationSchema,localDelegationConfigurationRecordSchema,input=>d.configure(input));
      add('delegation-submit',publicDelegationCommandSchema,commandReceiptSchema,input=>d.submit(input));
      add('delegation-sync',null,delegationSyncReportSchema,()=>d.sync());
    }
    if(options.pairingStore)add('delegation-pair',redeemLocalPairingSchema,redeemedLocalPairingSchema,input=>options.pairingStore!.redeem(input,AbortSignal.timeout(15000)));

  }catch(error){removers.reverse().forEach(remove=>remove());throw error;}
  let disposed=false;
  return ()=>{if(disposed)return;disposed=true;removers.reverse().forEach(remove=>remove());};
}
