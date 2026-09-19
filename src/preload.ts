import { contextBridge, ipcRenderer } from 'electron';

import { createCallieApi } from './preload/createCallieApi';

/**
 * D3: the main process sends `daily:changed` after a background sync applied worker events. The preload
 * turns it into a DOM event so Today re-reads; nothing from the message crosses into the renderer.
 */
ipcRenderer.on('daily:changed', () => {
  window.dispatchEvent(new Event('callie:daily-changed'));
});

contextBridge.exposeInMainWorld('callie', {
  ...createCallieApi(ipcRenderer),
});
