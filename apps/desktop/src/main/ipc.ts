/**
 * The four channels the preload bridge exposes, as a closed set.
 *
 * They are named here rather than spelled out in three files, so the main process,
 * the preload script and the renderer cannot drift apart silently: a channel that is
 * not in this list does not typecheck on either side of the bridge.
 */
export const IPC_CHANNELS = {
  state: 'callie:state',
  signIn: 'callie:sign-in',
  signOut: 'callie:sign-out',
  refreshToday: 'callie:refresh-today',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
