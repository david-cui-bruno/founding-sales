import { contextBridge, ipcRenderer } from 'electron';
import { createClientApi } from './preload/clientApi';

/**
 * `window.callie = { status, pair, get, command, unpair }`, validated on both sides with the contract's
 * zod schemas (see `preload/clientApi.ts`). The renderer never sees the IPC channel names or the token.
 */
contextBridge.exposeInMainWorld('callie', createClientApi((channel, ...args) => ipcRenderer.invoke(channel, ...args)));
