/**
 * The session's channels, as a closed set.
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
  /**
   * Main to page (wave 1): go to one of the six routes. The Window menu's ⌘1–⌘6 and a
   * deep link send it; it carries a route name and nothing else.
   */
  navigate: 'callie:navigate',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
