import { dailySnapshotSchema, type DailyApi } from '../../shared/contracts/dailyContract';
import { registerValidatedIpc } from '../ipc/registerValidatedIpc';
export function registerDailyIpc(provider: DailyApi, isTrustedRendererUrl?: (url: string) => boolean): () => void {
  return registerValidatedIpc({ channel: 'daily:get', requestSchema: null, responseSchema: dailySnapshotSchema,
    safeErrorCode: 'DAILY_READ_FAILED', handler: () => provider.get(), isTrustedRendererUrl });
}
