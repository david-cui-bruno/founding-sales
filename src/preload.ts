import { contextBridge, ipcRenderer } from 'electron';

import { appHealthSchema } from './shared/healthContract';

contextBridge.exposeInMainWorld('callie', {
  health: {
    get: async () =>
      appHealthSchema.parse(await ipcRenderer.invoke('health:get')),
  },
});
