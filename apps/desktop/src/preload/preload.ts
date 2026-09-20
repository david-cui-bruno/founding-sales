import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../main/ipc.ts';
import { desktopStateSchema, type DesktopBridge, type DesktopState } from '../shared/contract.ts';

/**
 * The bridge, and the whole of what the renderer can reach
 * (specification 14.2).
 *
 * Four methods, each returning the same parsed `DesktopState`. Parsing on this side
 * as well as on the main side is not paranoia about our own code: it is what makes
 * the renderer's type a guarantee rather than a hope, and it means a state that grew
 * a field it should not have — a token, a body — fails here instead of reaching the
 * page. `desktopStateSchema` is `strictObject`, so an extra field is an error.
 */

const invoke = async (channel: string, argument?: unknown): Promise<DesktopState> => {
  const answer: unknown = await ipcRenderer.invoke(channel, argument);
  return desktopStateSchema.parse(answer);
};

const bridge: DesktopBridge = {
  state: async () => await invoke(IPC_CHANNELS.state),
  signIn: async input => await invoke(IPC_CHANNELS.signIn, input),
  signOut: async () => await invoke(IPC_CHANNELS.signOut),
  refreshToday: async () => await invoke(IPC_CHANNELS.refreshToday),
};

contextBridge.exposeInMainWorld('callie', bridge);
