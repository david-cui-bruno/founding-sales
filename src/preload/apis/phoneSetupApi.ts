import { PHONE_SETUP_ERROR, confirmPhoneSetupSchema, phoneSetupStatusSchema, type PhoneSetupApi } from '../../shared/contracts/phoneSetupContract';
import type { IpcClient } from '../ipcClient';

const safe = async <T>(operation: () => Promise<T>): Promise<T> => {
  try { return await operation(); } catch { throw new Error(PHONE_SETUP_ERROR); }
};
export const createPhoneSetupApi = (client: IpcClient): PhoneSetupApi => ({
  status: (...args: []) => safe(() => {
    if (args.length !== 0) throw new Error(PHONE_SETUP_ERROR);
    return client.requestNoInput('phone-setup:status', phoneSetupStatusSchema);
  }),
  confirm: input => safe(() => client.request('phone-setup:confirm', confirmPhoneSetupSchema, phoneSetupStatusSchema, input)),
  clear: (...args: []) => safe(() => {
    if (args.length !== 0) throw new Error(PHONE_SETUP_ERROR);
    return client.requestNoInput('phone-setup:clear', phoneSetupStatusSchema);
  }),
});
