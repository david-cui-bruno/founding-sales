import type { z } from 'zod';
import { researchSetupApproveInputSchema, researchSetupSetStateInputSchema, researchSetupReceiptSchema, researchSetupStatusSchema, type ResearchSetupApi } from '../../shared/contracts/researchSetupContract';
import type { IpcClient } from '../ipcClient';

export function createResearchSetupApi(client: IpcClient): ResearchSetupApi {
  const noInput = async <T>(name: string, schema: z.ZodType<T>, args: unknown[]): Promise<T> => {
    if (args.length !== 0) throw Error('Research setup request takes no arguments');
    return client.requestNoInput(`outreach:research-setup-${name}`, schema);
  };
  const request = async <T>(name: string, schema: z.ZodType<T>, args: [T]) => {
    if (args.length !== 1) throw Error('Research setup request requires one argument');
    // Parse/copy now, not after an asynchronous IPC boundary.
    const input = schema.parse(args[0]);
    return client.request(`outreach:research-setup-${name}`, schema, researchSetupReceiptSchema, input);
  };
  return {
    status: (...args) => noInput('status', researchSetupStatusSchema, args),
    approve: (...args) => request('approve', researchSetupApproveInputSchema, args),
    setState: (...args) => request('set-state', researchSetupSetStateInputSchema, args),
    retry: (...args) => noInput('retry', researchSetupReceiptSchema, args),
    cancelPending: (...args) => noInput('cancel-pending', researchSetupReceiptSchema, args),
  };
}
