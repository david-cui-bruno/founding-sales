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
import {approveMeetingFromReplySchema,getMeetingApprovalSchema,meetingApprovalStatusSchema,boundMeetingApprovalStatus,type ApproveMeetingFromReply,type GetMeetingApproval,type MeetingApprovalStatus} from '../shared/contracts/meetingContract';
import {configureAccountIntakeSchema,boundAccountIntakeConfigureStatus,type ConfigureAccountIntake,type AccountIntakeConfigureStatus} from '../shared/contracts/accountIntakeConfigureContract';
import {createLinkedInApi} from './apis/linkedInApi';
import { delegatedPhoneHandoffRequestSchema,bootstrapSelectedAccountSchema,configureResearchSourceSchema,ownerResearchSourceSchema,configureLocalDelegationSchema,localDelegationStatusSchema,localDelegationConfigurationRecordSchema,redeemLocalPairingSchema,redeemedLocalPairingSchema,delegationSyncReportSchema } from '../shared/contracts/ownerCommandContract';
import {delegatedPhoneHandoffResultSchema,publicDelegationCommandSchema,commandReceiptSchema,type PublicDelegationCommand} from '../shared/contracts/delegationContract';
import type {z} from 'zod';
import { createPhoneSetupApi } from './apis/phoneSetupApi';
import { createOutreachApi } from './apis/outreachApi';
import { createDiscoveryApi } from './apis/discoveryApi';
import { createRecoveryApi } from './apis/recoveryApi';
import { appHealthSchema, type AppHealth } from '../shared/healthContract';
import { createConversationsApi } from './apis/conversationsApi';
import { createFridayApi } from './apis/fridayApi';
import { createImportApi } from './apis/importApi';
import { createLeadDetailApi } from './apis/leadDetailApi';
import { createLeadsApi } from './apis/leadsApi';
import { createLearningsApi } from './apis/learningsApi';
import { createPipelineApi } from './apis/pipelineApi';
import { createReviewApi } from './apis/reviewApi';
import { createShellApi } from './apis/shellApi';
import { createSourcingApi } from './apis/sourcingApi';
import { createTodayApi } from './apis/todayApi';
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
  // Optional in consumers for the same older-bridge compatibility. Approval queues one
  // owner command and returns its receipt; it never books, sends or reads a calendar.
  const meetingExtension: { approveMeeting?: (input: ApproveMeetingFromReply) => Promise<MeetingApprovalStatus>; getMeetingApproval?: (input: GetMeetingApproval) => Promise<MeetingApprovalStatus | null> } = {
    approveMeeting: async raw => { const request = Object.freeze(approveMeetingFromReplySchema.parse(raw)); return client.request('outreach:delegation-approve-meeting', approveMeetingFromReplySchema, boundMeetingApprovalStatus(request), request); },
    getMeetingApproval: async raw => {
      const request = Object.freeze(getMeetingApprovalSchema.parse(raw));
      return client.request('outreach:delegation-get-meeting-approval', getMeetingApprovalSchema, meetingApprovalStatusSchema.nullable().refine(status => !status || status.accountId === request.accountId && status.threadId === request.threadId, 'meeting_approval_identity_mismatch'), request);
    },
  };
  // Optional for the same older-bridge compatibility. One explicit intake change queues one configure-owner
  // command and returns its receipt or an honest hold; it never reads mail, sends or books.
  const intakeExtension: { configureIntake?: (input: ConfigureAccountIntake) => Promise<AccountIntakeConfigureStatus> } = {
    configureIntake: async raw => { const request = Object.freeze(configureAccountIntakeSchema.parse(raw)); return client.request('outreach:delegation-configure-intake', configureAccountIntakeSchema, boundAccountIntakeConfigureStatus(request), request); },
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
      ...meetingExtension,
      ...intakeExtension,
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
    today: createTodayApi(client),
    daily: createDailyApi(client),
    localWorkspace: createLocalWorkspaceApi(client),
    discovery: createDiscoveryApi(client),
    pipeline: createPipelineApi(client),
    review: createReviewApi(client),
    friday: createFridayApi(client),
    imports: createImportApi(client),
    conversations: createConversationsApi(client),
    learnings: createLearningsApi(client),
    sourcing: createSourcingApi(client),
    shell: createShellApi(client),
    recovery: createRecoveryApi(client),
  } as const;
};

export type CallieApi = ReturnType<typeof createCallieApi>;
