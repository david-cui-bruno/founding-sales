import {
  RECOVERY_ERROR, beginSetupRequestSchema, completeSetupRequestSchema, recoverySessionSchema,
  recoveryStatusSchema, restoreDrillRequestSchema, restoreDrillResultSchema, saveSetupRequestSchema,
  saveSetupResultSchema, type RecoveryProvider,
} from '../../shared/contracts/recoveryContract';
import type { IpcClient } from '../ipcClient';

const safe = async <T>(operation: () => Promise<T>): Promise<T> => {
  try { return await operation(); } catch { throw new Error(RECOVERY_ERROR); }
};
export const createRecoveryApi = (client: IpcClient): RecoveryProvider => ({
  status: (...args: []) => safe(() => {
    if (args.length !== 0) throw new Error(RECOVERY_ERROR);
    return client.requestNoInput('recovery:status', recoveryStatusSchema);
  }),
  beginSetup: (input) => safe(() => client.request('recovery:begin-setup', beginSetupRequestSchema, recoverySessionSchema, input)),
  saveSetupMaterial: (input) => safe(() => client.request('recovery:save-setup-material', saveSetupRequestSchema, saveSetupResultSchema, input)),
  completeSetup: (input) => safe(() => client.request('recovery:complete-setup', completeSetupRequestSchema, recoveryStatusSchema, input)),
  selectAndRunRestoreDrill: (input) => safe(() => client.request('recovery:select-and-run-restore-drill', restoreDrillRequestSchema, restoreDrillResultSchema, input)),
});
