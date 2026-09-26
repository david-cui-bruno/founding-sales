import { holdInert } from './busy.ts';
import type { DesktopBridge, DesktopState, MailboxBridge, MailboxState } from '../shared/contract.ts';
import type { UpdateStatus } from '../shared/updateContract.ts';
import * as firmWorkspace from './firmWorkspace.ts';
import {
  autoRefreshToday,
  forgetHome,
  hasTodayBridge,
  loadHomeAdmin,
  loadHomeToday,
  mount as mountToday,
  renderHome,
  setHomeRedraw,
  startTodayTicker,
  unmount as unmountToday,
} from './homePage.ts';
import { updateLine } from './homeView.ts';
import * as replyPage from './replyPage.ts';
import { routeOf, routeText, setNavigator, type Route, type View } from './routes.ts';
import * as sequenceEditor from './sequenceEditor.ts';
import * as settingsPage from './settingsPage.ts';
import { buildMailboxView, buildScreenView, MAILBOX_ROW_LABEL } from './viewModel.ts';

/**
 * The one window (wave 1).
 *
 * Deliberately plain: no framework, no build step beyond a transpile, and every
 * value written to the page through `textContent` rather than `innerHTML`, so a firm
 * name that contains a tag is a firm name. The renderer holds no rule of its own —
 * it asks `buildScreenView` what to show and does that.
 *
 * Signed out, it is the sign-in form; below the minimum version, the upgrade
 * instruction and nothing to press. Signed in, it is the **shell**: the sidebar on the
 * left (`homePage.ts` draws it — the views with their keys, the system's status and
 * "This Mac") and one view in the column on the right. The route says which view:
 * Today, Replies, Firms or one firm, Sequences, Administration or the Dashboard. The
 * sidebar sets it, and so do the Window menu's ⌘1–⌘6 and a deep link, through
 * `callie:navigate`. Each view is a module with `mount(container, route)` and
 * `unmount()`; nothing boots when it is imported, and an answer that arrives after its
 * view was unmounted draws nothing. Until wave 1 each sidebar row opened a window of its
 * own, which is the "clicking on a tab opens a new page" the owner reported.
 *
 * "This Mac" carries the Mailbox row (release.md 8.0x): the second bridge,
 * `callieMailbox`, answers it, and `buildMailboxView` decides what it says. Connect
 * Gmail asks the main process to start the grant; the main process opens Google's
 * consent screen in the system browser and holds the call until the mailbox connects,
 * the grant expires or Refresh is pressed. The row is read again whenever the window
 * regains focus — which is the moment a person comes back from that browser. Home's
 * Needs-you list offers the same Connect Gmail while the mailbox is not connected.
 */

const bridge = (): DesktopBridge => {
  const value = globalThis.callie;
  if (value === undefined) throw new Error('the Callie bridge is not present');
  return value;
};

/** Absent only in a page built without the preload; the row then says so and offers nothing. */
const mailboxBridge = (): MailboxBridge | undefined => globalThis.callieMailbox;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: { readonly className?: string; readonly text?: string; readonly testId?: string } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className !== undefined) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.testId !== undefined) node.dataset['testid'] = options.testId;
  return node;
}

/**
 * What was typed into the sign-in fields, kept across the form being drawn again — the
 * waiting state, and an answer that did not sign in (offline, no membership) — so a
 * press that failed does not also empty the form. Forgotten once signed in.
 */
let signInDraft: { readonly workspaceId: string; readonly deviceLabel: string } | null = null;

/**
 * The sign-in form. A Mac that has signed in before remembers its workspace and its name
 * (wave 1, `workspace.json`), so the form is the one button; "Use another workspace"
 * shows the two fields for the rare other one. A first sign-in shows them from the start.
 */
function renderSignIn(
  root: HTMLElement,
  busy: boolean,
  enabled: boolean,
  remembered: DesktopState['rememberedWorkspace'],
): void {
  const form = element('form', { className: 'sign-in', testId: 'sign-in-form' });

  const fields = element('div', { className: 'sign-in-fields', testId: 'sign-in-fields' });
  const workspaceLabel = element('label', { text: 'Workspace' });
  const workspace = element('input');
  workspace.name = 'workspaceId';
  workspace.autocomplete = 'off';
  workspace.dataset['testid'] = 'workspace-id';
  workspace.value = signInDraft?.workspaceId ?? '';
  workspaceLabel.append(workspace);

  const labelLabel = element('label', { text: 'Name this Mac' });
  const deviceLabel = element('input');
  deviceLabel.name = 'deviceLabel';
  deviceLabel.value = signInDraft?.deviceLabel ?? remembered?.deviceLabel ?? 'This Mac';
  deviceLabel.dataset['testid'] = 'device-label';
  labelLabel.append(deviceLabel);
  fields.append(workspaceLabel, labelLabel);

  const showFields = (shown: boolean): void => {
    fields.hidden = !shown;
    workspace.required = shown;
    deviceLabel.required = shown;
  };
  showFields(remembered === null || signInDraft !== null);

  const submit = element('button', { text: busy ? 'Waiting for your browser…' : 'Sign in with Google' });
  submit.type = 'submit';
  submit.disabled = busy || !enabled;
  submit.dataset['testid'] = 'sign-in';
  submit.className = 'btn btn-primary';

  form.append(fields, submit);
  if (remembered !== null && fields.hidden) {
    const other = element('button', { className: 'btn btn-quiet', text: 'Use another workspace', testId: 'use-another-workspace' });
    other.type = 'button';
    other.disabled = busy;
    other.addEventListener('click', () => {
      showFields(true);
      other.remove();
      workspace.focus();
    });
    form.append(other);
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    // Hidden fields send nothing, and the main process signs in to the remembered one.
    const input = fields.hidden ? {} : { workspaceId: workspace.value.trim(), deviceLabel: deviceLabel.value.trim() };
    signInDraft = fields.hidden ? null : { workspaceId: workspace.value, deviceLabel: deviceLabel.value };
    void (async () => {
      render(await bridge().signIn(input));
      await enterHome();
    })();
    render(null, { busy: true });
  });
  root.append(form);
}

/** "This Mac": the device, the Mailbox row with its one control, and Sign out. Home puts it in the sidebar. */
function devicePanel(state: DesktopState): HTMLElement {
  const panel = element('section', { className: 'device', testId: 'device-panel' });
  if (state.device === null) return panel;
  const list = element('dl');
  for (const [term, value] of [
    ['Name', state.device.deviceLabel],
    ['Device', state.device.deviceId],
    ['Workspace', state.device.workspaceId],
    ['Role', state.device.role],
    ['Registered', state.device.registeredAt],
  ] as const) {
    list.append(element('dt', { text: term }), element('dd', { text: value }));
  }
  const mailbox =
    mailboxBridge() === undefined
      ? { text: 'Unavailable in this build', action: null, hint: null, notice: null }
      : buildMailboxView(lastMailbox, { waiting: mailboxWaiting });
  list.append(
    element('dt', { text: MAILBOX_ROW_LABEL }),
    element('dd', { text: mailbox.text, testId: 'mailbox-status' }),
  );
  panel.append(list);

  const controls = element('div', { className: 'device-controls' });
  if (mailbox.action !== null) {
    const connect = element('button', { className: 'btn', text: mailbox.action.label, testId: 'mailbox-connect' });
    connect.disabled = !mailbox.action.enabled;
    connect.addEventListener('click', () => {
      void connectMailbox();
    });
    controls.append(connect);
  }

  const signOut = element('button', { className: 'btn', text: 'Sign out' });
  signOut.dataset['testid'] = 'sign-out';
  signOut.addEventListener('click', () => {
    void (async () => {
      // The next person to sign in on this Mac must not see this one's mailbox, list,
      // numbers or figures.
      lastMailbox = null;
      mailboxWaiting = false;
      forgetHome();
      render(await bridge().signOut());
    })();
  });
  controls.append(signOut);
  panel.append(controls);
  // Plain text on the card: a refusal is read where the button was, never in a dialog
  // that blocks the window.
  if (mailbox.hint !== null) panel.append(element('p', { className: 'mailbox-hint', text: mailbox.hint, testId: 'mailbox-hint' }));
  if (mailbox.notice !== null) {
    panel.append(element('p', { className: 'mailbox-notice', text: mailbox.notice, testId: 'mailbox-notice' }));
  }
  return panel;
}

/**
 * Refresh: the list read again, the session's view of that read, the Mailbox row, and
 * Home's status and figures. Refresh is also how a person stops waiting for a consent
 * screen they abandoned.
 */
function refreshAll(): void {
  void refreshMailbox();
  void (async () => {
    if (hasTodayBridge()) {
      await loadHomeToday(true);
      render(await bridge().state());
    } else {
      render(await bridge().refreshToday());
    }
  })();
  void loadHomeAdmin({ figures: true, reread: true });
}

let lastState: DesktopState | null = null;
let lastMailbox: MailboxState | null = null;

// --- Lane g83: the update line -----------------------------------------------------
// What `callieUpdate` last said. It belongs to the Mac, not to the person signed in, so
// Sign out keeps it. Read at boot, when the window regains focus, and whenever the main
// process says it changed; Home draws it in the sidebar, the other screens as one line.
let lastUpdate: UpdateStatus | null = null;

/** What the current screen draws of an update: Home any line, the other screens only an install. */
const drawnUpdate = (status: UpdateStatus | null): string =>
  status === null || status.kind === 'none' || (!signedIn() && status.kind !== 'installing')
    ? ''
    : `${status.kind} ${status.version}`;

async function loadUpdate(): Promise<void> {
  const update = globalThis.callieUpdate;
  if (update === undefined) return;
  const next = await update.state();
  const before = drawnUpdate(lastUpdate);
  lastUpdate = next;
  // Drawn again only when the line changes: this runs on every focus, and redrawing the
  // sign-in screen would empty the form the person is typing into.
  if (drawnUpdate(next) !== before) render(null);
}

/** What the last Update now found, until the next press or a state change. */
let updateNowNote: string | null = null;
let updateNowPending = false;

export const UPDATE_NOW_LABEL = 'Update now';
export const NO_UPDATE_YET = 'No update is available yet. Callie checks again every six hours.';

function renderUpdateNow(root: HTMLElement): void {
  const update = globalThis.callieUpdate;
  if (update === undefined || lastUpdate?.kind === 'installing') return;
  const press = element('button', {
    className: 'btn btn-primary',
    text: updateNowPending ? 'Checking…' : UPDATE_NOW_LABEL,
    testId: 'update-now',
  });
  press.disabled = updateNowPending;
  press.addEventListener('click', () => {
    updateNowPending = true;
    updateNowNote = null;
    render(null);
    void (async () => {
      try {
        lastUpdate = await update.checkNow();
        updateNowNote = lastUpdate.kind === 'none' ? NO_UPDATE_YET : null;
      } catch {
        updateNowNote = 'Callie could not check for an update just now.';
      } finally {
        updateNowPending = false;
        render(null);
      }
    })();
  });
  root.append(press);
  if (updateNowNote !== null) root.append(element('p', { className: 'banner banner-info', text: updateNowNote, testId: 'update-now-note' }));
}

/**
 * The launch update, while it is being put in place (wave 1): the column is read-only and
 * one line says why. It installs after the window opens — `confirmLaunch` records this
 * start first, and that order stays — so for those seconds Home is on screen and nothing
 * in it can be pressed. Callie restarts by itself when the new build is in place.
 */
function showUpdating(root: HTMLElement, shell: Shell): void {
  const installing = lastUpdate?.kind === 'installing' ? lastUpdate : null;
  holdInert(shell.column, 'updating', installing !== null);
  let line = root.querySelector('[data-testid="updating-banner"]');
  if (installing === null) {
    line?.remove();
    return;
  }
  if (!(line instanceof HTMLElement)) {
    line = element('p', { className: 'updating-banner', testId: 'updating-banner' });
    root.append(line);
  }
  line.textContent = `Updating Callie to ${installing.version}… Callie restarts by itself when it is done; until then nothing here can be changed.`;
}

function restartToUpdate(): void {
  const update = globalThis.callieUpdate;
  if (update === undefined) return;
  void (async () => {
    lastUpdate = await update.restart();
    render(null);
  })();
}
// --- end of lane g83's update line ---------------------------------------------------

/** True from the click on Connect Gmail until the main process answers it. */
let mailboxWaiting = false;

const signedIn = (): boolean => lastState?.screen === 'today' && lastState.device !== null;

function showMailbox(state: MailboxState): void {
  lastMailbox = state;
  render(null);
}

/**
 * What a signed-in window reads first: the Mailbox row; the lanes as cached and then as
 * the server has them now, so the morning's list is on screen without a press; and
 * Home's status and figures.
 */
async function enterHome(): Promise<void> {
  if (!signedIn()) return;
  await Promise.all([
    loadMailbox(),
    (async () => {
      if (!hasTodayBridge()) return;
      await loadHomeToday(false);
      await loadHomeToday(true);
      // The read above may have found the server gone or the cache stale; the session
      // says so, and the system row and the quiet lines follow it.
      if (signedIn()) render(await bridge().state());
    })(),
    loadHomeAdmin({ figures: true }),
  ]);
}

/** Read the row, when there is a row to read: signed in, on the Today screen. */
async function loadMailbox(): Promise<void> {
  const mailbox = mailboxBridge();
  if (mailbox === undefined || !signedIn()) return;
  showMailbox(await mailbox.state());
}

async function refreshMailbox(): Promise<void> {
  const mailbox = mailboxBridge();
  if (mailbox === undefined || !signedIn()) return;
  mailboxWaiting = false;
  showMailbox(await mailbox.refresh());
}

async function connectMailbox(): Promise<void> {
  const mailbox = mailboxBridge();
  if (mailbox === undefined || mailboxWaiting) return;
  mailboxWaiting = true;
  render(null);
  let answer: MailboxState | null = null;
  try {
    answer = await mailbox.connect();
  } finally {
    mailboxWaiting = false;
    if (answer === null) render(null);
    else showMailbox(answer);
  }
}

// --- The shell: the sidebar and one view --------------------------------------------

/** Every view, by the route that shows it. A firm and the pipeline are one view. */
const VIEWS: Readonly<Record<Route['name'], View>> = {
  today: { mount: container => { mountToday(container); }, unmount: unmountToday },
  replies: replyPage,
  firms: firmWorkspace,
  firm: firmWorkspace,
  sequences: sequenceEditor,
  admin: settingsPage,
  dashboard: settingsPage,
};

/** Where the window is. Today until something says otherwise. */
let route: Route = { name: 'today' };
/** The view in the column now, and the route it was mounted for. */
let mounted: { readonly view: View; readonly route: Route } | null = null;

interface Shell {
  readonly sidebar: HTMLElement;
  readonly column: HTMLElement;
}

function shellOf(root: HTMLElement): Shell | null {
  if (root.dataset['view'] !== 'shell') return null;
  const sidebar = root.querySelector('[data-region="sidebar"]');
  const column = root.querySelector('[data-region="column"]');
  return sidebar instanceof HTMLElement && column instanceof HTMLElement ? { sidebar, column } : null;
}

function unmountView(): void {
  mounted?.view.unmount();
  mounted = null;
}

/** Put the route's view in the column: the old one unmounted, the new one mounted fresh. */
function mountView(shell: Shell): void {
  unmountView();
  shell.column.replaceChildren();
  shell.column.scrollTop = 0;
  const view = VIEWS[route.name];
  mounted = { view, route };
  // Today keeps Home's own look; every other view is laid out as its window was.
  shell.column.className = route.name === 'today' ? 'column' : 'column view';
  shell.column.dataset['route'] = routeText(route);
  view.mount(shell.column, route);
}

/** The sidebar and an empty column, built once per sign-in; the route's view goes in it. */
function buildShell(root: HTMLElement): Shell {
  root.replaceChildren();
  root.className = 'shell';
  root.dataset['view'] = 'shell';
  const sidebar = element('aside', { className: 'sidebar', testId: 'sidebar' });
  sidebar.dataset['region'] = 'sidebar';
  const column = element('main', { className: 'column', testId: 'column' });
  column.dataset['region'] = 'column';
  root.append(sidebar, column);
  const shell = { sidebar, column };
  mountView(shell);
  return shell;
}

/**
 * The route, in the address as well (`#firms`, `#firm/<id>`): the View menu's Reload
 * comes back to the same view rather than to Today. The page reads it once, at boot.
 */
function remember(next: Route): void {
  const hash = `#${routeText(next)}`;
  if (location.hash !== hash) history.replaceState(null, '', hash);
}

/**
 * Go to `next`. The same route again is a fresh look — the pipeline re-read, Settings
 * shown from the top — except Today, whose lanes may hold what somebody is typing.
 */
export function navigate(next: Route): void {
  const same = routeText(next) === routeText(route);
  route = next;
  remember(next);
  const root = document.querySelector('#app');
  const shell = root instanceof HTMLElement ? shellOf(root) : null;
  if (shell === null) return;
  if (!(same && next.name === 'today')) mountView(shell);
  render(null);
}

/** A view's own answer moved it (a firm opened from the board): the route follows, nothing is mounted again. */
function routeShown(next: Route): void {
  if (routeText(next) === routeText(route)) return;
  route = next;
  remember(next);
  if (mounted !== null) mounted = { view: mounted.view, route: next };
  const root = document.querySelector('#app');
  const shell = root instanceof HTMLElement ? shellOf(root) : null;
  if (shell !== null) shell.column.dataset['route'] = routeText(next);
  render(null);
}

export function render(state: DesktopState | null, options: { readonly busy?: boolean } = {}): void {
  if (state !== null) lastState = state;
  const current = lastState;
  const root = document.querySelector('#app');
  if (!(root instanceof HTMLElement) || current === null) return;
  const view = buildScreenView(current);

  if (view.screen === 'today' && current.device !== null) {
    signInDraft = null;
    const shell = shellOf(root) ?? buildShell(root);
    renderHome(shell.sidebar, {
      desktop: current,
      desktopBanners: view.banners,
      mailbox: lastMailbox,
      mailboxWaiting,
      thisMac: () => devicePanel(current),
      connectMailbox: () => {
        void connectMailbox();
      },
      refresh: refreshAll,
      update: lastUpdate,
      restartToUpdate,
    }, route);
    showUpdating(root, shell);
    return;
  }

  if (root.dataset['view'] === 'shell') {
    // Leaving the shell without a Sign out press — a revoked device, an expired
    // membership — forgets the person as thoroughly as the button does.
    unmountView();
    lastMailbox = null;
    mailboxWaiting = false;
    forgetHome();
  }
  root.replaceChildren();
  root.className = 'single';
  root.dataset['view'] = 'single';
  root.append(element('h1', { text: view.heading, testId: 'heading' }));

  const banners = element('div', { className: 'banners', testId: 'banners' });
  for (const banner of view.banners) {
    const node = element('p', { className: `banner banner-${banner.tone}`, text: banner.text });
    node.dataset['testid'] = `banner-${banner.tone}`;
    banners.append(node);
  }
  // Lane g83: an install under way says so on every screen, including the upgrade screen
  // it is about to clear. A staged update's Restart lives in Home's sidebar only.
  if (lastUpdate?.kind === 'installing') {
    banners.append(element('p', { className: 'banner banner-info', text: updateLine(lastUpdate) ?? '', testId: 'update-notice' }));
  }
  root.append(banners);

  if (view.screen === 'upgrade_required') {
    // The upgrade instruction and one control (wave 1): Update now, the six-hourly check
    // run at once. A blocked build installs what it finds and restarts by itself.
    root.append(element('p', { testId: 'upgrade-only', text: 'Callie will work again once this Mac is updated.' }));
    renderUpdateNow(root);
    return;
  }
  // `signing_in` is a sign-in the browser has not finished: the same form, waiting.
  renderSignIn(root, (options.busy ?? false) || view.screen === 'signing_in', view.signInEnabled, current.rememberedWorkspace);
}

export async function boot(): Promise<void> {
  setHomeRedraw(() => {
    render(null);
  });
  setNavigator(navigate, routeShown);
  // The menu's ⌘1–⌘6 and a deep link. The main process sends one of the six names and
  // nothing else; the preload has checked it before it gets here.
  bridge().onNavigate(name => {
    const next = routeOf(name);
    if (next !== null) navigate(next);
  });
  // A route in the address: a Reload, or a page loaded straight onto one (the specs do).
  // The main process loads the window without one, so the app opens on Today.
  route = routeOf(decodeURIComponent(location.hash.slice(1))) ?? route;
  globalThis.callieUpdate?.onChange(() => {
    void loadUpdate();
  });
  render(await bridge().state());
  await Promise.all([loadUpdate(), enterHome()]);
  startTodayTicker();
}

if (typeof document !== 'undefined') {
  // Coming back from the browser is when a grant has just landed: read the row again.
  // Coming back from Administration is when a calling number has just been added: the
  // administration bridge already holds it, and reading its state asks the API nothing.
  // And coming back from the phone app or anywhere else is when today's list may have
  // moved: Home reads it again if the last read is a minute old (lane g84, G05).
  window.addEventListener('focus', () => {
    void loadMailbox();
    void loadUpdate();
    if (signedIn()) void loadHomeAdmin();
    if (signedIn()) autoRefreshToday('focus');
  });
  void boot();
}
