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
  /**
   * The workspace's other Macs, and signing one of them out (wave 3b, S7).
   *
   * The session's channels rather than operations of the registry, because revoking the
   * device this Mac is presenting *is* this Mac signing out, and the session manager is
   * the only thing allowed to end a registration.
   */
  devices: 'callie:devices',
  revokeDevice: 'callie:device-revoke',
  /**
   * Main to page (wave 1): go to one of the six routes. The Window menu's ⌘1–⌘6 and a
   * deep link send it; it carries a route name and nothing else.
   */
  navigate: 'callie:navigate',
  navigateAction:'callie:navigate-action',
  /**
   * Main to page (1.0.12): the person, the workspace or the role changed, or this Mac's
   * registration ended. It carries a generation and the new identity — never a token —
   * and the page empties everything it was holding the moment it arrives, rather than
   * when it next happens to read the session.
   */
  sessionChanged: 'callie:session-changed',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
