import { dailySnapshotSchema, type DailyApi } from '../../shared/contracts/dailyContract';
import type { IpcClient } from '../ipcClient';
export const createDailyApi = (client: IpcClient): DailyApi => ({ get: () => client.requestNoInput('daily:get', dailySnapshotSchema) });
