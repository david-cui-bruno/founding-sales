import { getAccountPreparationSchema, accountPreparationReadReplySchema, AccountPreparationReadFailure, type GetAccountPreparation } from '../shared/contracts/accountPreparationContract';
import { reconcileReplyDraftSchema, editReplyDraftSchema, boundReplyDraftResult, type ReconcileReplyDraft, type EditReplyDraft } from '../shared/contracts/mailThreadContract';
import { delegatedPhoneStateRequestSchema, delegatedPhoneStateReplySchema, type GetPhoneHandoffStateRequest } from '../shared/contracts/delegatedPhoneStateContract';
import { createRemoteGoogleConnectionsApi } from './apis/remoteGoogleConnectionsApi';
import { createResearchSetupApi } from './apis/researchSetupApi';
import type { ResearchSetupApi } from '../shared/contracts/researchSetupContract';
import type { RemoteGoogleConnectionsApi } from '../shared/contracts/remoteGoogleConnectionsContract';
import { createLocalWorkspaceApi } from './apis/localWorkspaceApi';
import { createDailyApi } from './apis/dailyApi';
import {policyImportConfirmSchema,policyImportResumeSchema,policyImportStatusSchema,policyImportPreviewSchema,policyImportReportSchema} from '../shared/contracts/accountRoutePolicyImportContract';
import {prepareRequestedFollowupSchema,getRequestedFollowupSchema,editRequestedFollowupSchema,approveRequestedFollowupSchema,savedRequestedFollowupSchema,requestedApprovalStatusSchema} from '../shared/contracts/requestedFollowupContract';
import {workerPolicyRequestSchema,workerPolicyReceiptSchema} from '../shared/contracts/workerPolicyContract';
import {configureAccountIntakeSchema,boundAccountIntakeConfigureStatus,type ConfigureAccountIntake,type AccountIntakeConfigureStatus} from '../shared/contracts/accountIntakeConfigureContract';
import {territoryCallPolicyRequestSchema,territoryCallPolicyStatusSchema,type TerritoryCallPolicyRequest,type TerritoryCallPolicyStatus} from '../shared/contracts/territoryCallPolicyContract';
import {createLinkedInApi} from './apis/linkedInApi';
import { delegatedPhoneHandoffRequestSchema,bootstrapSelectedAccountSchema,refreshSelectedAccountRecordSchema,selectedAccountFreshnessRequestSchema,selectedAccountFreshnessSchema,configureResearchSourceSchema,ownerResearchSourceSchema,configureLocalDelegationSchema,localDelegationStatusSchema,localDelegationConfigurationRecordSchema,redeemLocalPairingSchema,redeemedLocalPairingSchema,delegationSyncReportSchema,type RefreshSelectedAccountRecord,type SelectedAccountFreshnessRequest,type SelectedAccountFreshness } from '../shared/contracts/ownerCommandContract';
import {delegatedPhoneHandoffResultSchema,publicDelegationCommandSchema,commandReceiptSchema,type CommandReceipt,type PublicDelegationCommand} from '../shared/contracts/delegationContract';
import type {z} from 'zod';
import { createPhoneSetupApi } from './apis/phoneSetupApi';
import { createOutreachApi } from './apis/outreachApi';
import { createRecoveryApi } from './apis/recoveryApi';
import { appHealthSchema, type AppHealth } from '../shared/healthContract';
import { createLeadDetailApi } from './apis/leadDetailApi';
import { createLeadsApi } from './apis/leadsApi';
import { createShellApi } from './apis/shellApi';
import { createIpcClient, type IpcInvoker } from './ipcClient';

/**
 * The complete narrow renderer API: one validated client per feature slice
 * plus the health probe. Every request and response crosses a Zod schema
 * before it reaches renderer code.
 */
export const createCallieApi = (invoker: IpcInvoker) => {
  const client = createIpcClient(invoker);
  // Optional in consumers for compatibility with older bridges. This bridge always supplies it.
  const googleExtension: { googleConnections?: RemoteGoogleConnectionsApi } = { googleConnections: createRemoteGoogleConnectionsApi(client) };
  const researchExtension: { researchSetup?: ResearchSetupApi } = { researchSetup: createResearchSetupApi(client) };
  // Optional for the same older-bridge compatibility. One explicit intake change queues one configure-owner
  // command and returns its receipt or an honest hold; it never reads mail, sends or books.
  const intakeExtension: { configureIntake?: (input: ConfigureAccountIntake) => Promise<AccountIntakeConfigureStatus> } = {
    configureIntake: async raw => { const request = Object.freeze(configureAccountIntakeSchema.parse(raw)); return client.request('outreach:delegation-configure-intake', configureAccountIntakeSchema, boundAccountIntakeConfigureStatus(request), request); },
  };
  // Optional for the same older-bridge compatibility. One explicit send resubmits the current saved company record
  // to the worker that already owns it and returns that command's receipt; the freshness read is local only.
  const recordExtension: { refreshSelectedAccount?: (input: RefreshSelectedAccountRecord) => Promise<CommandReceipt>; getSelectedAccountFreshness?: (input: SelectedAccountFreshnessRequest) => Promise<SelectedAccountFreshness> } = {
    refreshSelectedAccount: async raw => {
      const request = Object.freeze(refreshSelectedAccountRecordSchema.parse(raw));
      return client.request('outreach:delegation-refresh-selected-account', refreshSelectedAccountRecordSchema, commandReceiptSchema.refine(receipt => receipt.commandId === request.commandId, 'refresh_receipt_identity_mismatch'), request);
    },
    getSelectedAccountFreshness: async raw => {
      const request = Object.freeze(selectedAccountFreshnessRequestSchema.parse(raw));
      return client.request('outreach:delegation-selected-account-freshness', selectedAccountFreshnessRequestSchema, selectedAccountFreshnessSchema.refine(value => value.accountId === request.accountId, 'selected_account_freshness_identity_mismatch'), request);
    },
  };
  // Optional for the same older-bridge compatibility. One explicit territory policy read or command; the reply's receipt
  // must name the request's command. Approving is the one hold; nothing here dials, sends or books.
  const territoryExtension: { territoryPolicy?: (input: TerritoryCallPolicyRequest) => Promise<TerritoryCallPolicyStatus> } = {
    territoryPolicy: async raw => {
      const request = Object.freeze(territoryCallPolicyRequestSchema.parse(raw));
      return client.request('outreach:delegation-territory-policy', territoryCallPolicyRequestSchema,
        territoryCallPolicyStatusSchema.refine(status => request.kind === 'read' ? status.receipt === null : status.receipt?.commandId === request.commandId, 'territory_policy_receipt_identity_mismatch'), request);
    },
  };
  return {
    health: {
      get: (): Promise<AppHealth> =>
        client.requestNoInput('health:get', appHealthSchema),
    },
    delegation: {
      reconcileReplyDraft: async (raw: ReconcileReplyDraft) => { const request = reconcileReplyDraftSchema.parse(raw); return client.request('outreach:reply-reconcile', reconcileReplyDraftSchema, boundReplyDraftResult(request), request); },
      editReplyDraft: async (raw: EditReplyDraft) => { const request = editReplyDraftSchema.parse(raw); return client.request('outreach:reply-edit', editReplyDraftSchema, boundReplyDraftResult(request), request); },
      ...googleExtension,
      ...researchExtension,
      ...intakeExtension,
      ...recordExtension,
      ...territoryExtension,
      policyImport:{
        selectAndPreview:()=>client.requestNoInput('outreach:policy-import-select-preview',policyImportPreviewSchema.nullable()),
        confirm:(input:z.infer<typeof policyImportConfirmSchema>)=>client.request('outreach:policy-import-confirm',policyImportConfirmSchema,policyImportReportSchema,input),
        resume:(input:z.infer<typeof policyImportResumeSchema>)=>client.request('outreach:policy-import-resume',policyImportResumeSchema,policyImportReportSchema,input),
        status:(input:z.infer<typeof policyImportStatusSchema>)=>client.request('outreach:policy-import-status',policyImportStatusSchema,policyImportReportSchema,input),
      },
      prepareRequestedFollowup:(input:z.infer<typeof prepareRequestedFollowupSchema>)=>client.request('outreach:requested-followup-prepare',prepareRequestedFollowupSchema,savedRequestedFollowupSchema,input),
      getRequestedFollowup:(input:z.infer<typeof getRequestedFollowupSchema>)=>client.request('outreach:requested-followup-get',getRequestedFollowupSchema,savedRequestedFollowupSchema.nullable(),input),
      editRequestedFollowup:(input:z.infer<typeof editRequestedFollowupSchema>)=>client.request('outreach:requested-followup-edit',editRequestedFollowupSchema,savedRequestedFollowupSchema,input),
      approveRequestedFollowup:(input:z.infer<typeof approveRequestedFollowupSchema>)=>client.request('outreach:requested-followup-approve',approveRequestedFollowupSchema,requestedApprovalStatusSchema,input),
      getPhoneHandoffState:async(raw:GetPhoneHandoffStateRequest)=>{const request=Object.freeze(delegatedPhoneStateRequestSchema.parse(raw));return client.request('outreach:delegation-get-phone-handoff-state',delegatedPhoneStateRequestSchema,delegatedPhoneStateReplySchema(request),request);},
      beginPhone:(input:z.infer<typeof delegatedPhoneHandoffRequestSchema>)=>client.request('outreach:delegation-begin-phone',delegatedPhoneHandoffRequestSchema,delegatedPhoneHandoffResultSchema,input),
      bootstrap:(input:z.infer<typeof bootstrapSelectedAccountSchema>)=>client.request('outreach:delegation-bootstrap',bootstrapSelectedAccountSchema,commandReceiptSchema,input),
      configurePolicy:(input:z.infer<typeof workerPolicyRequestSchema>)=>client.request('outreach:delegation-policy',workerPolicyRequestSchema,workerPolicyReceiptSchema,input),
      configureResearch:(input:z.infer<typeof configureResearchSourceSchema>)=>client.request('outreach:delegation-research',configureResearchSourceSchema,ownerResearchSourceSchema,input),
      status:()=>client.requestNoInput('outreach:delegation-status',localDelegationStatusSchema),
      pair:(input:z.infer<typeof redeemLocalPairingSchema>)=>client.request('outreach:delegation-pair',redeemLocalPairingSchema,redeemedLocalPairingSchema,input),
      configure:(input:z.infer<typeof configureLocalDelegationSchema>)=>client.request('outreach:delegation-configure',configureLocalDelegationSchema,localDelegationConfigurationRecordSchema,input),
      submit:(input:PublicDelegationCommand)=>client.request('outreach:delegation-submit',publicDelegationCommandSchema,commandReceiptSchema,input),
      sync:()=>client.requestNoInput('outreach:delegation-sync',delegationSyncReportSchema),
      getAccountPreparation:async(...args:[GetAccountPreparation])=>{
        if(args.length!==1)throw Error('Preparation read requires one request.');
        const request=Object.freeze(getAccountPreparationSchema.parse(args[0]));
        // Success keeps its shape. One allowlisted worker reason arrives as a reply field and leaves as
        // the rejection message, which is all the context bridge preserves of an Error.
        const reply=await client.request('outreach:delegation-get-account-preparation',getAccountPreparationSchema,accountPreparationReadReplySchema(request),request);
        if('unavailable' in reply)throw new AccountPreparationReadFailure(reply.unavailable);
        return reply;
      },
    },
    linkedin: createLinkedInApi(client),
    phoneSetup: createPhoneSetupApi(client),
    outreach: createOutreachApi(client),
    leads: createLeadsApi(client),
    leadDetail: createLeadDetailApi(client),
    daily: createDailyApi(client),
    localWorkspace: createLocalWorkspaceApi(client),
    shell: createShellApi(client),
    recovery: createRecoveryApi(client),
  } as const;
};

export type CallieApi = ReturnType<typeof createCallieApi>;
