import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DesktopState, MailboxState } from '../../shared/contract.ts';
import type { UpdateStatus } from '../../shared/updateContract.ts';
import { desktopBridge, operations, updateBridge } from './bridges.ts';
import { useSessionGeneration, type Generation } from './generation.ts';

/**
 * The session, the Mailbox row and the update line: the three things the shell owns
 * whatever view is in the column.
 *
 * The state is the main process's, never a copy this file keeps current by itself. Every
 * call answers the whole `DesktopState`, so `online`, `stale`, `asOf` and `mayMutate`
 * follow every read and every command without anything here deciding them — which is
 * what makes "any HTTP response means online, only a network failure means offline" a
 * property of the session manager rather than a rule repeated in the renderer.
 */

export interface Session {
  readonly desktop: DesktopState | null;
  /** True from the press on Sign in until the main process answers it. */
  readonly signingIn: boolean;
  readonly mailbox: MailboxState | null;
  /** True from the press on Connect Gmail until the main process answers it. */
  readonly mailboxWaiting: boolean;
  readonly update: UpdateStatus | null;
  /**
   * Who is signed in, as one string. Everything held for a person is keyed on it, so a
   * sign-out, another workspace or a changed role drops it all without a list of things
   * to remember to clear. Null when nobody is signed in.
   */
  readonly identity: string | null;
  /**
   * How many session transitions the main process has reported (1.0.12).
   *
   * Everything a view has in flight was asked for under one of these. An answer that
   * arrives under an older one is dropped: a `/today` read started as one person must
   * not land in a window that now belongs to another, and a sign-out must empty the
   * window when it happens rather than when something next happens to be read.
   */
  readonly generation: number;
  /**
   * The guard every view writes what it read through. One per window: Today, the
   * sidebar's reads, the mailbox row and this file all drop an answer that belongs to
   * a session that has since ended.
   */
  readonly guard: Generation;
  signIn(input: { readonly workspaceId?: string | undefined; readonly deviceLabel?: string | undefined }): Promise<void>;
  signOut(): Promise<void>;
  /** The workspace's other Macs, read when "This Mac" is opened (wave 3b). */
  listDevices(): Promise<void>;
  /** Sign one of them out. This Mac's own id is this Mac signing out. */
  revokeDevice(deviceId: string): Promise<void>;
  /** Read the session again — after a command, so the banners follow what it found. */
  reread(): Promise<void>;
  connectMailbox(): Promise<void>;
  switchMailbox(switchTo: string): Promise<void>;
  refreshMailbox(): Promise<void>;
  restartToUpdate(): void;
  checkForUpdate(): Promise<UpdateStatus | null>;
}

const identityOf = (state: DesktopState | null): string | null =>
  state === null || state.device === null || state.screen !== 'today'
    ? null
    : `${state.device.workspaceId}/${state.device.deviceId}/${state.device.role}`;

export function useSession(): Session {
  const [desktop, setDesktop] = useState<DesktopState | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [mailbox, setMailbox] = useState<MailboxState | null>(null);
  const [mailboxWaiting, setMailboxWaiting] = useState(false);
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const { generation, guard, note } = useSessionGeneration();
  const identity = identityOf(desktop);
  const identityRef = useRef(identity);
  identityRef.current = identity;

  const reread = useCallback(async (): Promise<void> => {
    // The state of a session that has since ended is not this window's to draw.
    const keep = guard.keep(setDesktop);
    keep(await desktopBridge().state());
  }, [guard]);

  const loadMailbox = useCallback(async (): Promise<void> => {
    const api = operations();
    if (api === undefined || identityRef.current === null) return;
    // The address of a mailbox that was somebody else's is exactly the kind of answer
    // that used to arrive a moment after the window had been emptied.
    const keep = guard.keep(setMailbox);
    keep(await api.read('mailbox.state', {}));
  }, [guard]);

  const refreshMailbox = useCallback(async (): Promise<void> => {
    const api = operations();
    if (api === undefined || identityRef.current === null) return;
    setMailboxWaiting(false);
    const keep = guard.keep(setMailbox);
    keep(await api.read('mailbox.refresh', {}));
  }, [guard]);

  const connectMailbox = useCallback(async (): Promise<void> => {
    const api = operations();
    if (api === undefined) return;
    setMailboxWaiting(true);
    const keep = guard.keep(setMailbox);
    try {
      keep(await api.command('mailbox.connect', {}));
    } finally {
      setMailboxWaiting(false);
    }
  }, [guard]);

  const switchMailbox = useCallback(
    async (switchTo: string): Promise<void> => {
      const api = operations();
      if (api === undefined) return;
      setMailboxWaiting(true);
      const keep = guard.keep(setMailbox);
      try {
        keep(await api.command('mailbox.switch', { switchTo }));
      } finally {
        setMailboxWaiting(false);
      }
    },
    [guard],
  );

  const loadUpdate = useCallback(async (): Promise<void> => {
    const bridge = updateBridge();
    if (bridge === undefined) return;
    setUpdate(await bridge.state());
  }, []);

  const signIn = useCallback(
    async (input: { readonly workspaceId?: string | undefined; readonly deviceLabel?: string | undefined }): Promise<void> => {
      setSigningIn(true);
      try {
        setDesktop(await desktopBridge().signIn(input));
      } finally {
        setSigningIn(false);
      }
    },
    [],
  );

  const signOut = useCallback(async (): Promise<void> => {
    // The next person to sign in on this Mac must not see this one's mailbox, list,
    // numbers or figures. The Query cache goes with the identity, in `App`.
    setMailbox(null);
    setMailboxWaiting(false);
    setDesktop(await desktopBridge().signOut());
  }, []);

  const listDevices = useCallback(async (): Promise<void> => {
    setDesktop(await desktopBridge().listDevices());
  }, []);

  const revokeDevice = useCallback(async (deviceId: string): Promise<void> => {
    setDesktop(await desktopBridge().revokeDevice({ deviceId }));
  }, []);

  const restartToUpdate = useCallback((): void => {
    const bridge = updateBridge();
    if (bridge === undefined) return;
    void bridge.restart().then(setUpdate);
  }, []);

  const checkForUpdate = useCallback(async (): Promise<UpdateStatus | null> => {
    const bridge = updateBridge();
    if (bridge === undefined) return null;
    const next = await bridge.checkNow();
    setUpdate(next);
    return next;
  }, []);

  useEffect(() => {
    // The main process saw the session change: a sign-out, another workspace, a role the
    // renewal came back with, or a revoked device seen as an authenticated refusal. The
    // window empties itself now — `App` clears the request cache and the drafts on this
    // number changing — and reads the session again so the screen follows.
    desktopBridge().onSessionChange(change => {
      note(change.generation);
      setMailbox(null);
      setMailboxWaiting(false);
      void reread();
    });
    updateBridge()?.onChange(() => {
      void loadUpdate();
    });
    void (async () => {
      await reread();
      await loadUpdate();
    })();
  }, [loadUpdate, note, reread]);

  // Signed in: read the Mailbox row. Signed out: the row is not this person's any more.
  useEffect(() => {
    if (identity === null) {
      setMailbox(null);
      return;
    }
    void loadMailbox();
  }, [identity, loadMailbox]);

  useEffect(() => {
    // Coming back from the browser is when a grant has just landed, and when an update
    // may have been staged. Read both again.
    const onFocus = (): void => {
      void loadMailbox();
      void loadUpdate();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
    };
  }, [loadMailbox, loadUpdate]);

  return useMemo(
    () => ({
      desktop,
      signingIn,
      mailbox,
      mailboxWaiting,
      update,
      identity,
      generation,
      guard,
      signIn,
      signOut,
      listDevices,
      revokeDevice,
      reread,
      connectMailbox,
      switchMailbox,
      refreshMailbox,
      restartToUpdate,
      checkForUpdate,
    }),
    [
      desktop,
      signingIn,
      mailbox,
      mailboxWaiting,
      update,
      identity,
      generation,
      guard,
      signIn,
      signOut,
      listDevices,
      revokeDevice,
      reread,
      connectMailbox,
      switchMailbox,
      refreshMailbox,
      restartToUpdate,
      checkForUpdate,
    ],
  );
}
