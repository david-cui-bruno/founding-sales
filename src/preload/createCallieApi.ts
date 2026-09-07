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
