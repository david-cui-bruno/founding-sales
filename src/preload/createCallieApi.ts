import { appHealthSchema, type AppHealth } from '../shared/healthContract';
import { createFridayApi } from './apis/fridayApi';
import { createImportApi } from './apis/importApi';
import { createLeadDetailApi } from './apis/leadDetailApi';
import { createLeadsApi } from './apis/leadsApi';
import { createPipelineApi } from './apis/pipelineApi';
import { createReviewApi } from './apis/reviewApi';
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
    pipeline: createPipelineApi(client),
    review: createReviewApi(client),
    friday: createFridayApi(client),
    imports: createImportApi(client),
  } as const;
};

export type CallieApi = ReturnType<typeof createCallieApi>;
