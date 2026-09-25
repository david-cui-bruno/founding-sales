import type { DesktopState, MailboxState, WindowTarget } from '../shared/contract.ts';
import type { UpdateStatus } from '../shared/updateContract.ts';
import { button, element } from './firmDom.ts';
import {
  NAV_ROWS,
  RESTART_TO_UPDATE,
  UNAVAILABLE,
  buildHomeView,
  figuresWindow,
  type FiguresRead,
  type HomeView,
  type NeedsRow,
} from './homeView.ts';
import type { AdminState } from './settingsContract.ts';
import type { TodayState } from './todayContract.ts';
import { renderLanes } from './todayLanes.ts';
import {
  TODAY_TICK_MS,
  buildTodayView,
  lanesKey,
  refreshDue,
  refreshFailed,
  updatedLine,
  type BannerView,
} from './todayView.ts';

/**
 * Home: what a signed-in person sees in the main window (lane g65; specification 8.2,
 * 13.4, 14.2).
 *
 * One column of Today — the business date, a line of counts, the four lanes in the
 * server's order, the last seven days in four figures, and what needs the person — beside
 * a sidebar holding the windows with their keys, the system's status as dots and words,
 * and "This Mac". The design is Mockup A2's (`docs/decisions/g65-today-is-the-home.md`):
 * dividers rather than cards, grey section headers with a small count, colour only as a
 * dot or a small tag, actions that appear on hover, status in the sidebar rather than in
 * banners.
 *
 * `renderer.ts` owns the session, sign-in and the Mailbox row, and hands this module the
 * "This Mac" panel it builds. This module owns the three reads Home adds — the lanes from
 * `callieToday`, the status and figures from `callieAdmin` — and draws them. It decides
 * nothing: `homeView.ts` says what to show and `todayLanes.ts` draws the lanes.
 *
 * **The lanes are redrawn only when the list changes.** The sidebar, the figures and the
 * Needs-you list are redrawn whenever any answer arrives, and those answers include the
 * mailbox row read every time the window regains focus. The lanes hold text a person is
 * typing — a snooze reason, a call note — so they are redrawn only when `callieToday`
 * answers with a list that differs from the one on screen, and are `aria-busy` while a
 * call to it is in flight.
 *
 * **The list keeps itself current (lane g84, audit item G05).** Home reads the list
 * again when the window regains focus and the last read is a minute old, and at the
 * business day's rollover (`refreshDue` in `todayView.ts` has the rules). The list on
 * screen stays while the read is in flight; a line under the summary says how old it is
 * — "Updated just now", "Updated 4 min ago" — and, when the read failed, says so beside
 * a Retry, under the offline or stale line the column already shows. Neither read runs
 * while somebody is typing in the lanes: it waits for the next tick.
 */

export interface HomeContext {
  readonly desktop: DesktopState;
  /** The session's own lines, from `buildScreenView`. */
  readonly desktopBanners: readonly BannerView[];
  readonly mailbox: MailboxState | null;
  readonly mailboxWaiting: boolean;
  /** `renderer.ts`'s panel: the device details, the Mailbox row and Sign out. */
  readonly thisMac: () => HTMLElement;
  readonly connectMailbox: () => void;
  readonly refresh: () => void;
  /** Lane g83: what `callieUpdate` last said, and its Restart to update. */
  readonly update?: UpdateStatus | null;
  readonly restartToUpdate?: () => void;
}

let today: TodayState | null = null;
let admin: AdminState | null = null;
let figures: FiguresRead = { requested: null, answered: false, dashboard: null };
let thisMacOpen = false;
/** Bumped at sign-out, so an answer to the previous person's read is dropped. */
let generation = 0;
/** The list the lanes on screen were drawn from, as text, or undefined when they must be drawn. */
let lanesDrawnFrom: string | undefined;
/** `callieToday` calls not yet answered; the lanes are `aria-busy` while there are any. */
let todayPending = 0;
let redraw: () => void = () => undefined;
/** When Home last asked for the list to be read again, by any trigger, or null. */
let lastRefreshAt: number | null = null;
/** Whether a read of the list has answered since sign-in; until then no failure is claimed. */
let refreshAnswered = false;
/** Whether somebody has typed or chosen in the lanes since they were last drawn. */
let lanesEdited = false;
let ticker: ReturnType<typeof setInterval> | null = null;

/** `renderer.ts` says how to draw the window again when an answer arrives. */
export function setHomeRedraw(next: () => void): void {
  redraw = next;
}

/** Whether the page was built with the lanes' bridge. */
export function hasTodayBridge(): boolean {
  return globalThis.callieToday !== undefined;
}

/**
 * Keep an answer if it belongs to the person still signed in, then draw. A bridge that
 * rejects — an IPC fault, never a refusal, which arrives as a state — leaves what was on
 * screen and says nothing in a dialog.
 */
async function keep<T>(read: () => Promise<T>, store: (value: T) => void, failed: () => void = () => undefined): Promise<void> {
  const mine = generation;
  let value: T;
  try {
    value = await read();
  } catch (error: unknown) {
    console.error(error);
    if (mine === generation) {
      failed();
      redraw();
    }
    return;
  }
  if (mine !== generation) return;
  store(value);
  redraw();
}

/** One `callieToday` call, counted while it is in flight. */
async function keepToday(next: () => Promise<TodayState>, options: { readonly read?: boolean } = {}): Promise<void> {
  todayPending += 1;
  redraw();
  await keep(
    async () => {
      try {
        return await next();
      } finally {
        todayPending -= 1;
      }
    },
    value => {
      today = value;
      if (options.read === true) refreshAnswered = true;
    },
  );
}

/** The lanes: the list as cached (`refresh: false`) or read again (`refresh: true`). */
export async function loadHomeToday(refresh: boolean): Promise<void> {
  const bridge = globalThis.callieToday;
  if (bridge === undefined) return;
  if (refresh) lastRefreshAt = Date.now();
  await keepToday(async () => (refresh ? await bridge.refresh() : await bridge.state()), { read: refresh });
}

/**
 * Whether somebody is in the middle of something in the lanes: a field there has focus,
 * or they have typed or chosen since the lanes were drawn. A read that found a changed
 * list would redraw the lanes and drop it, so the read waits.
 */
function personIsTyping(): boolean {
  const lanes = document.querySelector('[data-region="today"]');
  if (!(lanes instanceof HTMLElement)) return false;
  const active = document.activeElement;
  const focused = active instanceof HTMLElement && lanes.contains(active) && active.matches('input, textarea, select');
  return focused || lanesEdited;
}

/**
 * Read the list again if it is due (lane g84, G05): on focus when the last read is a
 * minute old, and on the tick after the business day's rollover. Quiet, so the notice
 * on screen stays; skipped while a read is in flight or somebody is typing in the lanes.
 */
export function autoRefreshToday(trigger: 'focus' | 'tick', now: number = Date.now()): void {
  const bridge = globalThis.callieToday;
  if (bridge === undefined || today === null || todayPending > 0) return;
  const zone = today.businessTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!refreshDue({ trigger, now, lastAttempt: lastRefreshAt, zone })) return;
  if (personIsTyping()) return;
  lastRefreshAt = now;
  void keepToday(async () => await bridge.refresh({ quiet: true }), { read: true });
}

/** The "Updated" line's words for the list on screen now. */
function updatedText(): string {
  return today === null ? '' : (updatedLine(today.asOf, Date.now()) ?? '');
}

/**
 * Every thirty seconds: the "Updated" line's minutes, written into the line in place so
 * nothing else on the page is redrawn, and the rollover check. Started once, at boot.
 */
export function startTodayTicker(): void {
  if (ticker !== null) return;
  ticker = setInterval(() => {
    const text = document.querySelector('[data-testid="today-updated-text"]');
    if (text !== null && text.textContent !== updatedText()) text.textContent = updatedText();
    autoRefreshToday('tick');
  }, TODAY_TICK_MS);
}

/**
 * The sidebar's calling number, sending and domain, and then the last seven days.
 *
 * `state()` is the Administration bridge's cached read — it asks the API only the first
 * time — so it is also what runs when the window regains focus: a number added in
 * Administration a moment ago is on the bridge already. `loadDashboard` is a read and
 * is asked for only here, at sign-in and on Refresh.
 */
export async function loadHomeAdmin(options: { readonly figures?: boolean; readonly now?: Date } = {}): Promise<void> {
  const bridge = globalThis.callieAdmin;
  if (bridge === undefined) return;
  await keep(
    async () => await bridge.state(),
    value => {
      admin = value;
    },
  );
  if (options.figures !== true) return;
  const requested = figuresWindow(options.now ?? new Date());
  figures = { requested, answered: false, dashboard: null };
  await keep(
    async () => await bridge.loadDashboard(requested),
    value => {
      admin = value;
      figures = { requested, answered: true, dashboard: value.dashboard };
    },
    () => {
      figures = { requested, answered: true, dashboard: null };
    },
  );
}

/** Sign-out: nothing of this person's stays for the next one. */
export function forgetHome(): void {
  generation += 1;
  today = null;
  admin = null;
  figures = { requested: null, answered: false, dashboard: null };
  thisMacOpen = false;
  lanesDrawnFrom = undefined;
  lastRefreshAt = null;
  refreshAnswered = false;
  lanesEdited = false;
}

function applyToday(next: Promise<TodayState>): void {
  void keepToday(async () => await next);
}

function openWindow(window: WindowTarget): void {
  void globalThis.callie?.openWindow({ window });
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function renderSidebar(sidebar: HTMLElement, view: HomeView, context: HomeContext): void {
  sidebar.replaceChildren();
  const mark = element('div', { className: 'workspace' });
  mark.append(element('span', { className: 'workspace-mark', text: 'C' }), element('span', { text: 'Callie' }));
  sidebar.append(mark);

  const nav = element('nav', { className: 'nav', testId: 'nav' });
  for (const row of NAV_ROWS) {
    const item = element('button', { className: 'nav-row', testId: `nav-${row.window ?? 'today'}` });
    item.type = 'button';
    item.append(element('span', { text: row.label }), element('kbd', { text: row.keys }));
    const target = row.window;
    if (target === null) item.setAttribute('aria-current', 'page');
    else {
      item.addEventListener('click', () => {
        openWindow(target);
      });
    }
    nav.append(item);
  }
  sidebar.append(nav);

  sidebar.append(element('p', { className: 'sidebar-label', text: 'Status' }));
  const status = element('ul', { className: 'status', testId: 'status' });
  for (const row of view.status) {
    const item = element('li', { className: 'status-row', testId: `status-${row.key}` });
    item.dataset['tone'] = row.tone;
    item.append(element('span', { className: `dot dot-${row.tone}` }), element('span', { text: row.text }));
    // Lane g83: the update row's one control. Nothing else in the status list is pressable.
    if (row.action === 'restart_to_update') {
      const restart = button(RESTART_TO_UPDATE, 'update-restart', context.restartToUpdate !== undefined);
      restart.className = 'status-action';
      item.classList.add('status-row-action');
      restart.addEventListener('click', () => {
        restart.disabled = true;
        context.restartToUpdate?.();
      });
      item.append(restart);
    }
    status.append(item);
  }
  sidebar.append(status);

  const details = element('details', { className: 'this-mac', testId: 'this-mac' });
  details.open = thisMacOpen;
  details.append(element('summary', { text: 'This Mac', testId: 'this-mac-summary' }), context.thisMac());
  details.addEventListener('toggle', () => {
    thisMacOpen = details.open;
  });
  sidebar.append(details);
}

function renderHeader(header: HTMLElement, view: HomeView, context: HomeContext): void {
  header.replaceChildren();
  header.append(element('h1', { text: view.heading, testId: 'heading' }));
  const line = element('div', { className: 'summary-line' });
  line.append(element('p', { className: 'summary', text: view.summary ?? '', testId: 'summary' }));
  const refresh = button('Refresh', 'refresh', true);
  refresh.className = 'btn btn-quiet';
  refresh.addEventListener('click', () => {
    context.refresh();
  });
  line.append(refresh);
  header.append(line);
  renderUpdated(header, context);
}

/**
 * How old the list on screen is, and whether the last read failed (lane g84, G05). The
 * failure is said once here, beside Retry; why it failed is the offline or stale line
 * above the lanes, which the column already shows. While a read is in flight the line
 * keeps what it said, so nothing flickers.
 */
function renderUpdated(header: HTMLElement, context: HomeContext): void {
  if (today === null || globalThis.callieToday === undefined) return;
  const line = element('p', { className: 'updated', testId: 'today-updated' });
  line.append(element('span', { text: updatedText(), testId: 'today-updated-text' }));
  if (refreshAnswered && refreshFailed(today)) {
    line.append(element('span', { text: today.asOf === null ? 'Could not refresh.' : ' · Could not refresh.', testId: 'today-refresh-failed' }));
    const retry = button('Retry', 'today-retry', true);
    retry.className = 'btn btn-quiet';
    retry.addEventListener('click', () => {
      context.refresh();
    });
    line.append(retry);
  }
  header.append(line);
}

function renderNotices(notices: HTMLElement, view: HomeView): void {
  notices.replaceChildren();
  for (const notice of view.notices) {
    notices.append(element('p', { className: `banner banner-${notice.tone}`, text: notice.text, testId: `banner-${notice.tone}` }));
  }
}

function renderTodayRegion(region: HTMLElement, view: HomeView, todayView: ReturnType<typeof buildTodayView> | null): void {
  region.setAttribute('aria-busy', String(todayPending > 0));
  // Compared as text: the cached list and the fresh read are two objects with the same
  // content more often than not, and redrawing for that would drop a half-typed reason.
  // Without `asOf`, which every read changes and the lanes never show (lane g84).
  const drawnFrom = lanesKey(today);
  if (lanesDrawnFrom === drawnFrom) return;
  lanesDrawnFrom = drawnFrom;
  lanesEdited = false;
  region.replaceChildren();
  const bridge = globalThis.callieToday;
  if (view.lanes === null || bridge === undefined) {
    region.append(element('p', { className: 'quiet empty', text: UNAVAILABLE, testId: 'today-unavailable' }));
    return;
  }
  if (today === null || todayView === null) {
    if (view.lanes.emptyLine !== null) {
      region.append(element('p', { className: 'quiet empty', text: view.lanes.emptyLine, testId: 'today-empty' }));
    }
    return;
  }
  renderLanes(region, today, todayView, view.lanes, { bridge, apply: applyToday });
}

function renderFigures(region: HTMLElement, view: HomeView): void {
  region.replaceChildren();
  region.append(element('h2', { className: 'section-head', text: view.figures.label, testId: 'figures-label' }));
  const grid = element('div', { className: 'figure-grid' });
  for (const cell of view.figures.cells) {
    const figure = element('div', { className: 'figure', testId: `figure-${cell.key}` });
    figure.append(element('div', { className: 'figure-label', text: cell.label }));
    const value = element('div', { className: 'figure-value' });
    value.append(element('span', { text: cell.value, testId: 'figure-value' }));
    if (cell.note !== null) value.append(element('small', { text: cell.note, testId: 'figure-note' }));
    figure.append(value);
    grid.append(figure);
  }
  region.append(grid);
  if (view.figures.line !== null) region.append(element('p', { className: 'quiet', text: view.figures.line, testId: 'figures-line' }));
}

function renderNeed(list: HTMLElement, need: NeedsRow, context: HomeContext): void {
  const item = element('li', { className: 'need', testId: 'needs-row' });
  item.dataset['need'] = need.key;
  const row = element('div', { className: 'row' });
  const main = element('div', { className: 'row-main' });
  main.append(element('span', { className: 'label', text: need.label, testId: 'needs-label' }));
  if (need.detail !== null) main.append(element('span', { className: 'why', text: need.detail, testId: 'needs-detail' }));
  row.append(main);

  const actions = element('div', { className: 'row-actions' });
  const action = need.action;
  if (action.kind === 'connect_mailbox') {
    const connect = button(action.label, 'needs-connect', action.enabled);
    connect.className = 'btn btn-primary';
    connect.addEventListener('click', () => {
      context.connectMailbox();
    });
    actions.append(connect);
  } else {
    const open = button(action.label, 'needs-open', true);
    open.className = 'btn';
    open.addEventListener('click', () => {
      openWindow(action.window);
    });
    actions.append(open);
  }
  row.append(actions);
  item.append(row);
  list.append(item);
}

function renderNeeds(region: HTMLElement, view: HomeView, context: HomeContext): void {
  region.replaceChildren();
  const heading = element('h2', { className: 'section-head' });
  heading.append(element('span', { text: 'Needs you' }));
  if (view.needs.length > 0) heading.append(element('small', { text: String(view.needs.length), testId: 'needs-count' }));
  region.append(heading);
  if (view.needsLine !== null) {
    region.append(element('p', { className: 'quiet empty', text: view.needsLine, testId: 'needs-empty' }));
    return;
  }
  const list = element('ul', { className: 'rows' });
  for (const need of view.needs) renderNeed(list, need, context);
  region.append(list);
}

/** The regions of the page, found by name once the skeleton exists. */
function region(root: HTMLElement, name: string): HTMLElement {
  const found = root.querySelector(`[data-region="${name}"]`);
  if (!(found instanceof HTMLElement)) throw new Error(`the Home region ${name} is missing`);
  return found;
}

function skeleton(root: HTMLElement): void {
  root.replaceChildren();
  root.className = 'home';
  root.dataset['view'] = 'home';
  lanesDrawnFrom = undefined;

  const sidebar = element('aside', { className: 'sidebar', testId: 'sidebar' });
  sidebar.dataset['region'] = 'sidebar';
  const column = element('main', { className: 'column', testId: 'home' });
  for (const [name, tag, className, testId] of [
    ['header', 'header', 'column-head', 'column-head'],
    ['notices', 'div', 'banners', 'banners'],
    ['today', 'div', 'today', 'today'],
    ['figures', 'section', 'figures', 'figures'],
    ['needs', 'section', 'needs', 'needs'],
  ] as const) {
    const part = element(tag, { className, testId });
    part.dataset['region'] = name;
    if (name === 'today') {
      // Anything typed or chosen in the lanes holds off a read Home would make by itself.
      for (const kind of ['input', 'change']) {
        part.addEventListener(kind, () => {
          lanesEdited = true;
        });
      }
    }
    column.append(part);
  }
  root.append(sidebar, column);
}

/** Draw Home into `root`, building its skeleton the first time. */
export function renderHome(root: HTMLElement, context: HomeContext): void {
  if (root.dataset['view'] !== 'home') skeleton(root);
  const todayView = today === null ? null : buildTodayView(today);
  const view = buildHomeView(
    {
      desktop: context.desktop,
      bridges: {
        today: globalThis.callieToday !== undefined,
        mailbox: globalThis.callieMailbox !== undefined,
        admin: globalThis.callieAdmin !== undefined,
      },
      today,
      todayView,
      mailbox: context.mailbox,
      mailboxWaiting: context.mailboxWaiting,
      admin,
      figures,
      update: context.update ?? null,
    },
    context.desktopBanners,
  );
  renderSidebar(region(root, 'sidebar'), view, context);
  renderHeader(region(root, 'header'), view, context);
  renderNotices(region(root, 'notices'), view);
  renderTodayRegion(region(root, 'today'), view, todayView);
  renderFigures(region(root, 'figures'), view);
  renderNeeds(region(root, 'needs'), view, context);
}
