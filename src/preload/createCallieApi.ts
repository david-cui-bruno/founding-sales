import {workerPolicyRequestSchema,workerPolicyReceiptSchema} from '../shared/contracts/workerPolicyContract';
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
  return {
    health: {
      get: (): Promise<AppHealth> =>
        client.requestNoInput('health:get', appHealthSchema),
    },
    delegation: {
      beginPhone:(input:z.infer<typeof delegatedPhoneHandoffRequestSchema>)=>client.request('outreach:delegation-begin-phone',delegatedPhoneHandoffRequestSchema,delegatedPhoneHandoffResultSchema,input),
      bootstrap:(input:z.infer<typeof bootstrapSelectedAccountSchema>)=>client.request('outreach:delegation-bootstrap',bootstrapSelectedAccountSchema,commandReceiptSchema,input),
      configurePolicy:(input:z.infer<typeof workerPolicyRequestSchema>)=>client.request('outreach:delegation-policy',workerPolicyRequestSchema,workerPolicyReceiptSchema,input),
      configureResearch:(input:z.infer<typeof configureResearchSourceSchema>)=>client.request('outreach:delegation-research',configureResearchSourceSchema,ownerResearchSourceSchema,input),
      status:()=>client.requestNoInput('outreach:delegation-status',localDelegationStatusSchema),
      pair:(input:z.infer<typeof redeemLocalPairingSchema>)=>client.request('outreach:delegation-pair',redeemLocalPairingSchema,redeemedLocalPairingSchema,input),
      configure:(input:z.infer<typeof configureLocalDelegationSchema>)=>client.request('outreach:delegation-configure',configureLocalDelegationSchema,localDelegationConfigurationRecordSchema,input),
      submit:(input:PublicDelegationCommand)=>client.request('outreach:delegation-submit',publicDelegationCommandSchema,commandReceiptSchema,input),
      sync:()=>client.requestNoInput('outreach:delegation-sync',delegationSyncReportSchema),
    },
    linkedin: createLinkedInApi(client),
    phoneSetup: createPhoneSetupApi(client),
    outreach: createOutreachApi(client),
    leads: createLeadsApi(client),
    leadDetail: createLeadDetailApi(client),
    today: createTodayApi(client),
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
