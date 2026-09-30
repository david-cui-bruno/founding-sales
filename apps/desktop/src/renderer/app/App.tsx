import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type { DesktopState } from '../../shared/contract.ts';
import { FirmsRoute } from '../firms/FirmsRoute.tsx';
import { buildHomeView } from '../homeView.ts';
import { RepliesRoute } from '../replies/RepliesRoute.tsx';
import { SequencesRoute } from '../sequences/SequencesRoute.tsx';
import { SettingsView } from '../settings/SettingsView.tsx';
import { buildTodayView } from '../todayView.ts';
import { TodayColumn } from '../today/TodayColumn.tsx';
import { useToday } from '../today/useToday.ts';
import { holdInert } from '../busy.ts';
import { routeText, type Route } from '../routes.ts';
import { buildScreenView } from '../viewModel.ts';
import { Alert } from '../ui/alert.tsx';
import { DraftsProvider, useHasDrafts } from './drafts.tsx';
import { Sidebar } from './Sidebar.tsx';
import { SignedOutScreen, type SignInDraft } from './SignedOutScreen.tsx';
import { ThisMac } from './ThisMac.tsx';
import { operations, updateBridge } from './bridges.ts';
import { useHomeAdmin } from './useHomeAdmin.ts';
import { useRoute } from './useRoute.ts';
import { useSession, type Session } from './useSession.ts';

/**
 * The one window (wave 1), in React since 1.0.12.
 *
 * Signed out, it is the sign-in form; below the minimum version, the upgrade instruction
 * and nothing to press. Signed in, it is the **shell**: the sidebar on the left — the
 * views with their keys, the system's status, Settings at the foot and "This Mac" — and
 * one view in the column on the right. The route says which view; the sidebar sets it,
 * and so do the Window menu and a deep link through `callie:navigate`.
 *
 * Every view is React since 1.0.13, and every one of them reaches the main process
 * through the same closed list of operations.
 *
 * Everything held for the person signed in — the Query cache and every draft — hangs
 * under `identity`, so a sign-out, another workspace or a changed role drops all of it
 * without a list of things somebody has to remember to clear.
 */

/** The key the column's view is mounted under. The same route again is a fresh view. */
function viewKeyOf(route: Route, epoch: number): string {
  // Today is the exception: its lanes may hold a half-typed snooze reason, and ⌘1 or
  // the sidebar row must not throw that away.
  if (route.name === 'today') return 'today';
  // The board, the firms and a firm's page are one view, so the CRM bridge opening a
  // firm from either list does not remount it — and nor does the way back.
  if (route.name === 'pipeline' || route.name === 'firms' || route.name === 'firm') return `crm:${String(epoch)}`;
  // Settings chooses its own tab; the tab is not in the key for the same reason.
  if (route.name === 'settings') return `settings:${String(epoch)}`;
  return `${routeText(route)}:${String(epoch)}`;
}

function Column({
  route,
  epoch,
  session,
  desktop,
  onNavigate,
}: {
  readonly route: Route;
  readonly epoch: number;
  readonly session: Session;
  readonly desktop: DesktopState;
  onNavigate(next: Route): void;
}): JSX.Element {
  const home = useHomeAdmin(session.identity, session.generation, session.guard);
  const [thisMacOpen, setThisMacOpen] = useState(false);
  // A page built without the preload has no operations at all; the views say so where a
  // control would have been rather than throwing.
  const hasOperations = operations() !== undefined;
  const typed = useHasDrafts('today:');
  const isTyping = useCallback((): boolean => {
    const lanes = document.querySelector('[data-region="today"]');
    const active = document.activeElement;
    const focused =
      lanes instanceof HTMLElement && active instanceof HTMLElement && lanes.contains(active) && active.matches('input, textarea, select');
    return focused || typed;
  }, [typed]);
  const today = useToday(session.identity, session.generation, session.guard, isTyping);

  const todayView = today.state === null ? null : buildTodayView(today.state);
  const view = buildHomeView(
    {
      desktop,
      hasOperations,
      today: today.state,
      todayView,
      mailbox: session.mailbox,
      mailboxWaiting: session.mailboxWaiting,
      admin: home.admin,
      figures: home.figures,
      callsToday: home.callsToday,
      update: session.update,
    },
    // The session's own lines — offline, stale, a refusal — above Today's.
    buildScreenView(desktop).banners,
  );

  const refreshAll = useCallback((): void => {
    today.refresh();
    home.refresh();
    void session.refreshMailbox();
    void session.reread();
  }, [today, home, session]);

  const key = viewKeyOf(route, epoch);
  const columnRef = useRef<HTMLElement>(null);
  useEffect(() => {
    // A new view starts at the top, as it did when each was its own window.
    const column = columnRef.current;
    if (column !== null) column.scrollTop = 0;
  }, [key]);

  return (
    <>
      <Sidebar
        view={view}
        route={route}
        thisMacOpen={thisMacOpen}
        onToggleThisMac={setThisMacOpen}
        onNavigate={onNavigate}
        onRestartToUpdate={session.restartToUpdate}
        thisMac={
          (
            <ThisMac
              desktop={desktop}
              mailbox={session.mailbox}
              mailboxWaiting={session.mailboxWaiting}
              hasMailboxBridge={hasOperations}
              onConnect={() => {
                void session.connectMailbox();
              }}
              onSignOut={() => {
                void session.signOut();
              }}
              opened={thisMacOpen}
              onListDevices={() => {
                void session.listDevices();
              }}
              onRevokeDevice={deviceId => {
                void session.revokeDevice(deviceId);
              }}
            />
          )
        }
      />
      <main
        ref={columnRef}
        data-region="column"
        data-testid="column"
        data-route={routeText(route)}
        className="h-screen overflow-y-auto"
      >
        {route.name === 'today' ? (
          <TodayColumn
            key={key}
            home={view}
            today={today.state}
            todayView={todayView}
            pending={today.pending}
            refreshAnswered={today.refreshAnswered}
            now={today.now}
            hasTodayBridge={hasOperations}
            actions={today.actions}
            onRefresh={refreshAll}
            onConnectMailbox={() => {
              void session.connectMailbox();
            }}
          />
        ) : route.name === 'settings' ? (
          <SettingsView
            key={key}
            route={route}
            identity={session.identity}
            generation={session.generation}
            guard={session.guard}
            mailbox={session.mailbox}
            mailboxWaiting={session.mailboxWaiting}
            hasMailboxBridge={hasOperations}
            onSwitchMailbox={switchTo => {
              void session.switchMailbox(switchTo);
            }}
          />
        ) : route.name === 'replies' ? (
          <RepliesRoute key={key} column={columnRef} />
        ) : route.name === 'sequences' ? (
          <SequencesRoute key={key} identity={session.identity} generation={session.generation} guard={session.guard} />
        ) : (
          <FirmsRoute
            key={key}
            route={route}
            identity={session.identity}
            generation={session.generation}
            guard={session.guard}
          />
        )}
      </main>
    </>
  );
}

/** `#app` as the shell: the sidebar at a fixed width and the column taking the rest. */
const SHELL_LAYOUT = 'grid min-h-screen grid-cols-[220px_minmax(0,1fr)]';
/** `#app` as a single page: signing in, waiting for the browser, the upgrade notice. */
const PAGE_LAYOUT = 'mx-auto max-w-[520px] px-14 pt-[12vh] pb-20';

export function App(): JSX.Element {
  const session = useSession();
  const { route, epoch, navigate } = useRoute();
  const client = useQueryClient();
  const [signInDraft, setSignInDraft] = useState<SignInDraft | null>(null);
  const identity = session.identity;
  const installing = session.update?.kind === 'installing' ? session.update : null;
  const signedIn = session.desktop !== null && session.desktop.screen === 'today' && session.desktop.device !== null;

  const generation = session.generation;
  const lastGeneration = useRef(generation);
  const lastIdentity = useRef<string | null>(null);
  useEffect(() => {
    /*
     * Nothing one person read stays for the next.
     *
     * Two things can say so and both do. The main process **tells** the window, the
     * moment it knows: a sign-out, another workspace, a role the renewal came back
     * with, a device the server says is revoked — `session.generation` moves and the
     * cache goes at once, rather than when something next happens to be read. And the
     * identity is still watched, because a build without the session bridge (the
     * harness runs one on purpose) has no event to hear.
     *
     * The first sign-in is neither: there is nothing of anybody else's to throw away,
     * and clearing there would discard the reads the shell has only just started.
     */
    const beforeIdentity = lastIdentity.current;
    const beforeGeneration = lastGeneration.current;
    lastIdentity.current = identity;
    lastGeneration.current = generation;
    if (generation !== beforeGeneration || (beforeIdentity !== null && beforeIdentity !== identity)) client.clear();
  }, [client, identity, generation]);

  useEffect(() => {
    if (identity !== null) setSignInDraft(null);
  }, [identity]);

  useEffect(() => {
    const root = document.querySelector('#app');
    if (!(root instanceof HTMLElement)) return;
    // The window's own layout, on the one element React does not render: the shell is
    // the sidebar and the column, and every other screen is a narrow page. `data-view`
    // is what a spec and a bug report read; the classes are what draws it.
    root.className = signedIn ? SHELL_LAYOUT : PAGE_LAYOUT;
    root.dataset['view'] = signedIn ? 'shell' : 'single';
    // The launch update, while it is being put in place (wave 1): the whole window is
    // read-only and one line says why. It installs after the window opens — `confirmLaunch`
    // records this start first, and that order stays — so for those seconds the page is
    // on screen and nothing in it can be pressed.
    holdInert(root, 'updating', installing !== null);
  }, [signedIn, installing]);

  if (session.desktop === null) return <div data-testid="booting" />;

  return (
    <>
      {signedIn ? (
        // Everything typed and unsent is keyed on the person *and* the transition, so a
        // sign-out, another workspace, a changed role or a revocation empties it at once.
        <DraftsProvider key={`${identity ?? 'signed-out'}:${String(generation)}`}>
          <Column route={route} epoch={epoch} session={session} desktop={session.desktop} onNavigate={navigate} />
        </DraftsProvider>
      ) : (
        <SignedOutScreen
          desktop={session.desktop}
          update={session.update}
          busy={session.signingIn}
          draft={signInDraft}
          hasUpdateBridge={updateBridge() !== undefined}
          onDraft={setSignInDraft}
          onSignIn={input => {
            void session.signIn(input);
          }}
          onCheckForUpdate={session.checkForUpdate}
        />
      )}
      {installing === null ? null : (
        <Alert tone="info" data-testid="updating-banner" className="fixed inset-x-0 bottom-0 z-10 rounded-none border-t text-center">
          {`Updating Callie to ${installing.version}… Callie restarts by itself when it is done; until then nothing here can be changed.`}
        </Alert>
      )}
    </>
  );
}
