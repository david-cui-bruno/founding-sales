import { ipcMain } from 'electron';

import { appHealthSchema } from '../../shared/healthContract';
import { validateSender } from '../ipc/validateSender';

export type HealthProvider = {
  getHealth(): unknown;
};

export function registerHealthIpc(
  health: HealthProvider,
  isTrustedRendererUrl?: (url: string) => boolean,
): () => void {
  ipcMain.handle('health:get', async (event, ...args: unknown[]) => {
    validateSender(event, isTrustedRendererUrl);

    if (args.length !== 0) {
      throw new Error('health:get does not accept request arguments.');
    }

    return appHealthSchema.parse(health.getHealth());
  });

  let registered = true;

  return () => {
    if (!registered) {
      return;
    }

    registered = false;
    ipcMain.removeHandler('health:get');
  };
}
