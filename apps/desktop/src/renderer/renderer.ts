import type { DesktopBridge, DesktopState, MailboxBridge, MailboxState } from '../shared/contract.ts';
import type { UpdateStatus } from '../shared/updateContract.ts';
import {
  autoRefreshToday,
  forgetHome,
  hasTodayBridge,
  loadHomeAdmin,
  loadHomeToday,
  renderHome,
  setHomeRedraw,
  startTodayTicker,
} from './homePage.ts';
import { updateLine } from './homeView.ts';
import { buildMailboxView, buildScreenView, MAILBOX_ROW_LABEL } from './viewModel.ts';

/**
 * The main window.
 *
 * Deliberately plain: no framework, no build step beyond a transpile, and every
 * value written to the page through `textContent` rather than `innerHTML`, so a firm
 * name that contains a tag is a firm name. The renderer holds no rule of its own —
 * it asks `buildScreenView` what to show and does that.
 *
 * Signed out, it is the sign-in form; below the minimum version, the upgrade
 * instruction and nothing to press. Signed in, it is **Home** (lane g65,
 * `homePage.ts`): the Today lanes, the status sidebar, the last seven days and what
 * needs the person. Home replaced G2's "This Mac" card and its bare list of cached
 * cards; the card is now "This Mac" at the foot of the sidebar, and this file still
 * builds it.
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

function renderSignIn(root: HTMLElement, busy: boolean, enabled: boolean): void {
  const form = element('form', { className: 'sign-in', testId: 'sign-in-form' });

  const workspaceLabel = element('label', { text: 'Workspace' });
  const workspace = element('input');
  workspace.name = 'workspaceId';
  workspace.required = true;
  workspace.autocomplete = 'off';
  workspace.dataset['testid'] = 'workspace-id';
  workspaceLabel.append(workspace);

  const labelLabel = element('label', { text: 'Name this Mac' });
  const deviceLabel = element('input');
  deviceLabel.name = 'deviceLabel';
  deviceLabel.required = true;
  deviceLabel.value = 'This Mac';
  deviceLabel.dataset['testid'] = 'device-label';
  labelLabel.append(deviceLabel);

  const submit = element('button', { text: busy ? 'Waiting for your browser…' : 'Sign in with Google' });
  submit.type = 'submit';
  submit.disabled = busy || !enabled;
  submit.dataset['testid'] = 'sign-in';
  submit.className = 'btn btn-primary';

  form.append(workspaceLabel, labelLabel, submit);
  form.addEventListener('submit', event => {
    event.preventDefault();
    void (async () => {
      render(await bridge().signIn({ workspaceId: workspace.value.trim(), deviceLabel: deviceLabel.value.trim() }));
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
  void loadHomeAdmin({ figures: true });
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

export function render(state: DesktopState | null, options: { readonly busy?: boolean } = {}): void {
  if (state !== null) lastState = state;
  const current = lastState;
  const root = document.querySelector('#app');
  if (!(root instanceof HTMLElement) || current === null) return;
  const view = buildScreenView(current);

  if (view.screen === 'today' && current.device !== null) {
    renderHome(root, {
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
    });
    return;
  }

  if (root.dataset['view'] === 'home') {
    // Leaving Home without a Sign out press — a revoked device, an expired
    // membership — forgets the person as thoroughly as the button does.
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
    // The one screen with nothing to press: the upgrade instruction and no controls.
    root.append(element('p', { testId: 'upgrade-only', text: 'Callie will work again once this Mac is updated.' }));
    return;
  }
  // `signing_in` is a sign-in the browser has not finished: the same form, waiting.
  renderSignIn(root, (options.busy ?? false) || view.screen === 'signing_in', view.signInEnabled);
}

export async function boot(): Promise<void> {
  setHomeRedraw(() => {
    render(null);
  });
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
