import type { DashboardResponse } from '@fss/contracts';
import type { DesktopState, MailboxState, WindowTarget } from '../shared/contract.ts';
import type { UpdateStatus } from '../shared/updateContract.ts';
import type { AdminState, CallingNumberView } from './settingsContract.ts';
import type { TodayCard, TodayLane, TodayState } from './todayContract.ts';
import type { BannerView, CardView, TodayScreenView } from './todayView.ts';
import { buildMailboxView } from './viewModel.ts';

/**
 * Home, as a pure function of what the four bridges said (lane g65; specification 8.2,
 * 13.4, 14.2).
 *
 * Home is the main window once a person is signed in: the Today lanes in one column, a
 * sidebar with the windows and the system's status, the last seven days in four figures,
 * and a short list of what needs the person. Everything it shows is a fact a bridge
 * already surfaces. It computes no eligibility, no sending posture and no order:
 *
 * * **The lanes are the server's order.** A section starts wherever the lane of the next
 *   card changes, so the sections are the snapshot's own runs. Nothing is sorted, and a
 *   lane never moves because this file has an opinion about precedence (8.2).
 * * **Sending on or off is `effectiveSendingEnabled`,** read out of the settings
 *   snapshot, and the domain checklist is `/outbound/status`'s `authenticationPasses`.
 *   Neither is recombined here (16.2, 12.7).
 * * **The calling number is the one the server marks `usedForCalls`,** which it marks
 *   exactly when the person has a verified, enabled number (lane g60).
 *
 * Every bridge may be absent: a page built without the preload says "Unavailable in this
 * build" in that bridge's places and offers nothing there, exactly as the Mailbox row
 * already did.
 */

export const UNAVAILABLE = 'Unavailable in this build';
export const TODAY_HEADING = 'Today';
export const HOME_EMPTY = 'Nothing today. Add firms and a sequence, and tomorrow’s list builds at 05:00.';
export const NOTHING_NEEDS_YOU = 'Nothing needs you.';
export const CHECKING = 'Checking…';
export const FIGURES_LABEL = 'Last 7 days';
export const FIGURES_UNREAD = 'Callie could not read the last 7 days.';
/** The window the figures cover, ending now. Seven days of milliseconds, not a calendar week. */
export const FIGURES_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const LANE_SECTION_LABELS: Readonly<Record<TodayLane, string>> = Object.freeze({
  reply: 'Replies',
  callback: 'Callbacks',
  due_work: 'Due today',
  new_firm: 'New firms',
});

// ---------------------------------------------------------------------------
// The sidebar's windows
// ---------------------------------------------------------------------------

export interface NavRow {
  readonly label: string;
  /** Null for Today, which is this window. */
  readonly window: WindowTarget | null;
  /** The key the Window menu gives it. */
  readonly keys: string;
}

/** The mockup's order: selling first, then the two screens a person opens when not selling. */
export const NAV_ROWS: readonly NavRow[] = Object.freeze([
  { label: 'Today', window: null, keys: '⌘1' },
  { label: 'Replies', window: 'replies', keys: '⌘2' },
  { label: 'Firms', window: 'firms', keys: '⌘3' },
  { label: 'Sequences', window: 'sequences', keys: '⌘4' },
  { label: 'Dashboard', window: 'dashboard', keys: '⌘6' },
  { label: 'Administration', window: 'administration', keys: '⌘5' },
]);

// ---------------------------------------------------------------------------
// Inputs and outputs
// ---------------------------------------------------------------------------

/** One `loadDashboard` read: the window asked for, and what came back. */
export interface FiguresRead {
  /** Null until the first read is asked for. */
  readonly requested: { readonly from: string; readonly to: string } | null;
  /** True once that read has answered, well or badly. */
  readonly answered: boolean;
  readonly dashboard: DashboardResponse | null;
}

export interface HomeInput {
  /** Signed in: `screen` is `today` and `device` is set. */
  readonly desktop: DesktopState;
  /** Which bridges the preload installed on this page. */
  readonly bridges: { readonly today: boolean; readonly mailbox: boolean; readonly admin: boolean };
  /** Null until `callieToday` has answered. */
  readonly today: TodayState | null;
  /** The lanes view model `buildTodayView` made from `today`. */
  readonly todayView: TodayScreenView | null;
  /** Null until `callieMailbox` has answered. */
  readonly mailbox: MailboxState | null;
  /** The page's own flag between a Connect click and the main process's first answer. */
  readonly mailboxWaiting: boolean;
  /** Null until `callieAdmin` has answered. */
  readonly admin: AdminState | null;
  readonly figures: FiguresRead;
  /** Lane g83: what `callieUpdate` last said. Absent or null draws no update line. */
  readonly update?: UpdateStatus | null;
}

export type Tone = 'ok' | 'warn' | 'stop' | 'none';

export interface StatusRow {
  readonly key: 'mailbox' | 'calling' | 'sending' | 'domain' | 'system' | 'update';
  readonly tone: Tone;
  readonly text: string;
  /** Lane g83: the one row with a control, the staged update's Restart to update. */
  readonly action?: 'restart_to_update';
}

export type NeedsAction =
  | { readonly kind: 'connect_mailbox'; readonly label: string; readonly enabled: boolean }
  | { readonly kind: 'open'; readonly window: WindowTarget; readonly label: string };

export interface NeedsRow {
  readonly key: 'connect_gmail' | 'calling_number' | 'domain_checklist' | 'alerts';
  readonly label: string;
  /** A grey second line, or null. */
  readonly detail: string | null;
  readonly action: NeedsAction;
}

export interface FigureCell {
  readonly key: 'replies' | 'calls' | 'holds' | 'emails';
  readonly label: string;
  readonly value: string;
  readonly note: string | null;
}

export interface FiguresView {
  readonly label: string;
  readonly cells: readonly FigureCell[];
  /** One grey line when the figures could not be read, or null. */
  readonly line: string | null;
}

export interface LaneSection {
  readonly lane: TodayLane;
  readonly label: string;
  readonly cards: readonly CardView[];
}

export interface HomeView {
  /** "Thursday, 25 September", from the snapshot's date in the business zone. */
  readonly heading: string;
  /** "3 firms · 1 reply · 1 callback". Counts only; null when there is no list. */
  readonly summary: string | null;
  /** Quiet lines at the top of the column: offline, stale, and the last notice. */
  readonly notices: readonly BannerView[];
  /** Null when `callieToday` is absent: the lanes then say `UNAVAILABLE`. */
  readonly lanes: { readonly sections: readonly LaneSection[]; readonly emptyLine: string | null } | null;
  readonly status: readonly StatusRow[];
  readonly needs: readonly NeedsRow[];
  /** "Nothing needs you.", "Checking…" or `UNAVAILABLE` when `needs` is empty; null otherwise. */
  readonly needsLine: string | null;
  readonly figures: FiguresView;
}

// ---------------------------------------------------------------------------
// The heading
// ---------------------------------------------------------------------------

/** How far `zone`'s wall clock is ahead of UTC at `instant`, in milliseconds. */
function zoneOffset(zone: string, instant: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const read = (type: string): number => Number(parts.find(part => part.type === type)?.value ?? '0');
  return Date.UTC(read('year'), read('month') - 1, read('day'), read('hour'), read('minute'), read('second')) - instant;
}

/**
 * "Thursday, 25 September": the snapshot's business date, in words.
 *
 * The date is a calendar date in the workspace's business zone (8.2), so it is read at
 * noon *in that zone* and formatted in that zone. Midnight UTC would be the evening
 * before anywhere west of Greenwich — on the Sunday DST ends in New York,
 * 2026-11-01T00:00Z is Saturday evening there — and noon is never inside a DST gap.
 * Assembled from parts so the comma does not depend on the ICU build.
 */
export function businessDateHeading(snapshotDate: string | null, zone: string | null): string {
  if (snapshotDate === null || zone === null) return TODAY_HEADING;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(snapshotDate);
  if (match === null) return TODAY_HEADING;
  const noonUtc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
  try {
    const instant = noonUtc - zoneOffset(zone, noonUtc);
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    }).formatToParts(new Date(instant));
    const part = (type: string): string => parts.find(entry => entry.type === type)?.value ?? '';
    return `${part('weekday')}, ${part('day')} ${part('month')}`;
  } catch {
    // An unknown zone is a server fault this window cannot correct; it says Today.
    return TODAY_HEADING;
  }
}

/**
 * A task's instant as the business zone's wall clock: "14:00" on the snapshot's own
 * date, "Thu 24 Sep, 09:00" on any other. The instant itself goes in `datetime`.
 */
export function dueLabel(instant: string, zone: string | null, snapshotDate: string | null): string {
  const at = Date.parse(instant);
  if (!Number.isFinite(at) || zone === null) return instant;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    }).formatToParts(new Date(at));
    const part = (type: string): string => parts.find(entry => entry.type === type)?.value ?? '';
    const time = `${part('hour')}:${part('minute')}`;
    if (`${part('year')}-${part('month')}-${part('day')}` === snapshotDate) return time;
    // en-US for the month: en-GB's short September is "Sept" in current ICU.
    const month = new Intl.DateTimeFormat('en-US', { timeZone: zone, month: 'short' }).format(new Date(at));
    return `${part('weekday')} ${String(Number(part('day')))} ${month}, ${time}`;
  } catch {
    return instant;
  }
}

// ---------------------------------------------------------------------------
// The lanes and the summary
// ---------------------------------------------------------------------------

/**
 * The lanes as sections, in the server's order: a new section starts wherever the
 * next card's lane differs from the last one's. 8.2's snapshot orders by lane first,
 * so this is one section per lane in precedence order — and if it ever did not, the
 * page would show the server's order faithfully rather than repair it.
 */
export function laneSections(cards: readonly CardView[]): readonly LaneSection[] {
  const sections: { lane: TodayLane; label: string; cards: CardView[] }[] = [];
  for (const entry of cards) {
    const last = sections.at(-1);
    if (last?.lane === entry.card.lane) last.cards.push(entry);
    else sections.push({ lane: entry.card.lane, label: LANE_SECTION_LABELS[entry.card.lane], cards: [entry] });
  }
  return sections;
}

function counted(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

/**
 * "11 firms · 2 replies · 1 callback · 12 emails held". Counts, never a sentence about
 * why: the held count appears only when the server says sending is off, and is the
 * list's own emails-due figure.
 */
export function summaryLine(cards: readonly TodayCard[], sendingOff: boolean): string | null {
  if (cards.length === 0) return null;
  const replies = cards.reduce((total, card) => total + card.counts.replies, 0);
  const callbacks = cards.filter(card => card.lane === 'callback').length;
  const emails = cards.reduce((total, card) => total + card.counts.emailsDue, 0);
  return [
    counted(cards.length, 'firm', 'firms'),
    replies > 0 ? counted(replies, 'reply', 'replies') : null,
    callbacks > 0 ? counted(callbacks, 'callback', 'callbacks') : null,
    sendingOff && emails > 0 ? `${counted(emails, 'email', 'emails')} held` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
}

// ---------------------------------------------------------------------------
// The sidebar's status
// ---------------------------------------------------------------------------

/** "+1 617 ··· 0100": enough to recognise a number, not enough to read one out. */
export function maskedNumber(e164: string): string {
  const digits = e164.replace(/\D/gu, '');
  if (digits.length === 11 && digits.startsWith('1')) return `+1 ${digits.slice(1, 4)} ··· ${digits.slice(-4)}`;
  if (digits.length >= 8) return `+${digits.slice(0, 2)} ··· ${digits.slice(-4)}`;
  return `··· ${digits.slice(-4)}`;
}

/** The number Today calls from, as the server chose it. */
function inUse(numbers: readonly CallingNumberView[]): CallingNumberView | null {
  return numbers.find(number => number.usedForCalls) ?? null;
}

/**
 * Why no number is in use, in the terms of Administration's own rows (lane g69):
 * `none` — the person has no number; `unattested` — a number is saved, not retired, and
 * not yet attested, which is what an unticked Add leaves behind; `retired` — every
 * number they have was retired. The same reading `settingsView.ts` gives each row, so
 * Home never names a state Administration does not show.
 */
function missingNumber(numbers: readonly CallingNumberView[]): 'none' | 'unattested' | 'retired' {
  if (numbers.length === 0) return 'none';
  const unattested = numbers.some(
    number => number.disabledAt === null && !(number.verificationStatus === 'verified' && number.enabled),
  );
  return unattested ? 'unattested' : 'retired';
}

function mailboxStatus(input: HomeInput): StatusRow {
  const row = (tone: Tone, text: string): StatusRow => ({ key: 'mailbox', tone, text });
  if (!input.bridges.mailbox) return row('none', `Mailbox: ${UNAVAILABLE.toLowerCase()}`);
  const status = input.mailbox?.status;
  if (status === undefined) return row('none', `Mailbox: ${CHECKING.toLowerCase()}`);
  if (status === null) return row('none', 'Mailbox status unknown');
  if (status.connected && status.mailbox !== null) return row('ok', `Mailbox connected · ${status.mailbox.emailAddress}`);
  if (status.connected) return row('ok', 'Mailbox connected');
  return row('warn', status.mailbox === null ? 'Mailbox not connected' : `Mailbox not connected · ${status.mailbox.emailAddress}`);
}

function adminRows(input: HomeInput): readonly StatusRow[] {
  const admin = input.admin;
  const isAdmin = input.desktop.device?.role === 'admin';
  if (!input.bridges.admin || admin === null) {
    const text = input.bridges.admin ? CHECKING.toLowerCase() : UNAVAILABLE.toLowerCase();
    return [
      { key: 'calling', tone: 'none', text: `Calling number: ${text}` },
      { key: 'sending', tone: 'none', text: `Sending: ${text}` },
      ...(isAdmin ? [{ key: 'domain', tone: 'none', text: `Domain: ${text}` } as const] : []),
    ];
  }

  const numbers = admin.callingNumbers;
  const number = numbers === null ? null : inUse(numbers);
  // A saved number that is not attested is not "no number" (lane g69): the person has
  // one, and the thing missing is their statement about it.
  const calling: StatusRow =
    numbers === null
      ? { key: 'calling', tone: 'none', text: 'Calling number not read' }
      : number !== null
        ? { key: 'calling', tone: 'ok', text: `Calling from ${maskedNumber(number.e164)}` }
        : missingNumber(numbers) === 'unattested'
          ? { key: 'calling', tone: 'warn', text: 'Calling number needs attestation' }
          : { key: 'calling', tone: 'warn', text: 'No calling number' };

  // 16.2's two switches, ANDed by the server. Read out, never recombined.
  const sending: StatusRow =
    admin.settings === null
      ? { key: 'sending', tone: 'none', text: 'Sending not read' }
      : admin.settings.effectiveSendingEnabled
        ? { key: 'sending', tone: 'ok', text: 'Sending on' }
        : { key: 'sending', tone: 'warn', text: 'Sending off' };

  if (!isAdmin) return [calling, sending];
  // 12.7's checklist is the server's `authenticationPasses`; the row is an admin's only,
  // because every `/outbound/*` read answers a salesperson with a redacted 403.
  const posture = admin.sendingAdmin;
  const domain: StatusRow =
    posture === null
      ? { key: 'domain', tone: 'none', text: 'Domain not read' }
      : posture.domain === null
        ? { key: 'domain', tone: 'warn', text: 'Domain checklist not recorded' }
        : posture.domain.authenticationPasses
          ? { key: 'domain', tone: 'ok', text: `Domain passes · ${posture.domain.domain}` }
          : { key: 'domain', tone: 'warn', text: `Domain checklist not passing · ${posture.domain.domain}` };
  return [calling, sending, domain];
}

function systemStatus(input: HomeInput): StatusRow {
  const online = input.today?.online ?? input.desktop.online;
  const stale = input.today?.stale ?? input.desktop.stale;
  const version = `Callie ${input.desktop.clientVersion}`;
  if (!online) return { key: 'system', tone: 'stop', text: `${version} · offline` };
  if (stale) return { key: 'system', tone: 'warn', text: `${version} · list is stale` };
  return { key: 'system', tone: 'ok', text: `${version} · online` };
}

// --- Lane g83: the update line -----------------------------------------------------
// One row under the version, and only while there is something to say: an install under
// way ("Updating Callie to 1.0.6…", which restarts by itself) or a verified update staged
// while the app was in use ("Callie 1.0.6 is ready", with Restart to update). Grey, like
// every row that is neither a problem nor a confirmation.
export const RESTART_TO_UPDATE = 'Restart to update';

export function updateLine(update: UpdateStatus | null | undefined): string | null {
  if (update === null || update === undefined || update.kind === 'none') return null;
  return update.kind === 'installing' ? `Updating Callie to ${update.version}…` : `Callie ${update.version} is ready`;
}

function updateStatus(input: HomeInput): readonly StatusRow[] {
  const text = updateLine(input.update);
  if (text === null) return [];
  return [
    input.update?.kind === 'ready'
      ? { key: 'update', tone: 'none', text, action: 'restart_to_update' }
      : { key: 'update', tone: 'none', text },
  ];
}
// --- end of lane g83's update line ---------------------------------------------------

export function statusRows(input: HomeInput): readonly StatusRow[] {
  return [mailboxStatus(input), ...adminRows(input), systemStatus(input), ...updateStatus(input)];
}

// ---------------------------------------------------------------------------
// Needs you
// ---------------------------------------------------------------------------

/**
 * What needs the person, from facts the bridges already surface, and nothing else.
 *
 * * The mailbox reads as not connected → **Connect Gmail**, pressed right here.
 * * The calling numbers were read and none is the one Today calls from → **Add your
 *   calling number** when there is none, **Attest your calling number** when one is saved
 *   and not attested, and **Re-attest your calling number** when every one is retired.
 *   Each opens Administration on Settings, where **Your calling number** is first and
 *   the existing row has its own Attest button (lane g69: until then a saved, unattested
 *   number was told to add itself again).
 * * An admin, whose `/outbound/status` read answered with no domain or a checklist that
 *   does not pass → **Record the domain checklist**, which opens Administration.
 * * An admin with unacknowledged alerts in a Diagnostics read the bridge already holds →
 *   **N alerts to acknowledge**, which opens Administration.
 *
 * A fact that was not read is not a need: an unread list of numbers is not "you have no
 * number", and a salesperson is never told about a domain they cannot see.
 */
export function needsRows(input: HomeInput): readonly NeedsRow[] {
  const rows: NeedsRow[] = [];
  const isAdmin = input.desktop.device?.role === 'admin';

  const status = input.mailbox?.status ?? null;
  if (input.bridges.mailbox && status !== null && !status.connected) {
    const view = buildMailboxView(input.mailbox, { waiting: input.mailboxWaiting });
    rows.push({
      key: 'connect_gmail',
      label: 'Connect Gmail',
      detail: view.notice ?? view.hint,
      action: {
        kind: 'connect_mailbox',
        label: view.action?.label ?? 'Connect Gmail',
        enabled: view.action?.enabled ?? false,
      },
    });
  }

  const admin = input.bridges.admin ? input.admin : null;
  if (admin !== null) {
    if (admin.callingNumbers !== null && inUse(admin.callingNumbers) === null) {
      rows.push(callingNumberNeed(missingNumber(admin.callingNumbers)));
    }
    const posture = admin.sendingAdmin;
    if (isAdmin && posture !== null && (posture.domain === null || !posture.domain.authenticationPasses)) {
      rows.push({
        key: 'domain_checklist',
        label: 'Record the domain checklist',
        detail: null,
        action: { kind: 'open', window: 'administration', label: 'Open' },
      });
    }
    const open = (admin.diagnostics?.alerts ?? []).filter(alert => alert.acknowledgedAt === null).length;
    if (isAdmin && open > 0) {
      rows.push({
        key: 'alerts',
        label: `${counted(open, 'alert', 'alerts')} to acknowledge`,
        detail: null,
        action: { kind: 'open', window: 'administration', label: 'Open' },
      });
    }
  }
  return rows;
}

/** The calling-number row, worded for what is missing. Administration opens on Settings. */
function callingNumberNeed(missing: 'none' | 'unattested' | 'retired'): NeedsRow {
  const action: NeedsAction = { kind: 'open', window: 'administration', label: 'Open' };
  if (missing === 'unattested') {
    return {
      key: 'calling_number',
      label: 'Attest your calling number',
      detail: 'Your number is saved. Open Your calling number and attest it.',
      action,
    };
  }
  if (missing === 'retired') {
    return {
      key: 'calling_number',
      label: 'Re-attest your calling number',
      detail: 'Your number was retired. Open Your calling number and attest it again.',
      action,
    };
  }
  return { key: 'calling_number', label: 'Add your calling number', detail: null, action };
}

function needsLine(input: HomeInput, rows: readonly NeedsRow[]): string | null {
  if (rows.length > 0) return null;
  if (!input.bridges.mailbox || !input.bridges.admin) return UNAVAILABLE;
  if (input.mailbox === null || input.admin === null) return CHECKING;
  return NOTHING_NEEDS_YOU;
}

// ---------------------------------------------------------------------------
// The figures
// ---------------------------------------------------------------------------

/** The last seven days, ending at `now`, as the dashboard read wants them. */
export function figuresWindow(now: Date): { readonly from: string; readonly to: string } {
  return { from: new Date(now.getTime() - FIGURES_WINDOW_MS).toISOString(), to: now.toISOString() };
}

const DASH = '—';

const sameInstant = (left: string, right: string): boolean => Date.parse(left) === Date.parse(right);

/**
 * Replies, calls, holds open and emails sent, over the window Home asked for.
 *
 * A dashboard for any other window is not these figures: the bridge keeps the last
 * figures it read when a read fails, and they may be Administration's thirty days. So
 * the answer's own window must be the one requested, or the row shows dashes and one
 * grey line. Sending that is `available: false` is "—, not in this build", never 0.
 */
export function figuresView(input: { readonly admin: boolean; readonly figures: FiguresRead }): FiguresView {
  const dashes = (line: string | null): FiguresView => ({
    label: FIGURES_LABEL,
    cells: [
      { key: 'replies', label: 'Replies', value: DASH, note: null },
      { key: 'calls', label: 'Calls', value: DASH, note: null },
      { key: 'holds', label: 'Holds open', value: DASH, note: null },
      { key: 'emails', label: 'Emails sent', value: DASH, note: null },
    ],
    line,
  });
  if (!input.admin) return dashes(UNAVAILABLE);
  const { requested, answered, dashboard } = input.figures;
  if (requested === null || !answered) return dashes(null);
  if (
    dashboard === null ||
    !sameInstant(dashboard.window.from, requested.from) ||
    !sameInstant(dashboard.window.to, requested.to)
  ) {
    return dashes(FIGURES_UNREAD);
  }

  const sending = dashboard.sending as { readonly available: boolean; readonly sent?: unknown; readonly held?: unknown };
  const sent = sending.available && typeof sending.sent === 'number' ? sending.sent : null;
  const held = sending.available && typeof sending.held === 'number' && sending.held > 0 ? sending.held : null;
  return {
    label: FIGURES_LABEL,
    cells: [
      {
        key: 'replies',
        label: 'Replies',
        value: String(dashboard.messages.human),
        note: dashboard.messages.uncertain > 0 ? `${String(dashboard.messages.uncertain)} uncertain` : null,
      },
      {
        key: 'calls',
        label: 'Calls',
        value: String(dashboard.calls.reduce((total, entry) => total + entry.count, 0)),
        note: null,
      },
      { key: 'holds', label: 'Holds open', value: String(dashboard.holds.open), note: null },
      sent === null
        ? { key: 'emails', label: 'Emails sent', value: DASH, note: 'not in this build' }
        : { key: 'emails', label: 'Emails sent', value: String(sent), note: held === null ? null : `${String(held)} held` },
    ],
    line: null,
  };
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

/**
 * The quiet lines at the top of the column. The lanes' own lines when `callieToday`
 * answered — offline, stale, and the last Today notice — plus the session's own notice;
 * the session's lines alone otherwise. The same sentence is never said twice.
 */
function noticesOf(input: HomeInput, desktopBanners: readonly BannerView[]): readonly BannerView[] {
  const lines = input.todayView === null ? desktopBanners : [...input.todayView.banners, ...desktopBanners.filter(banner => banner.tone === 'info')];
  const seen = new Set<string>();
  return lines.filter(line => {
    if (seen.has(line.text)) return false;
    seen.add(line.text);
    return true;
  });
}

export function buildHomeView(input: HomeInput, desktopBanners: readonly BannerView[]): HomeView {
  const snapshotDate = input.today?.snapshotDate ?? input.desktop.today?.snapshotDate ?? null;
  const zone = input.today?.businessTimeZone ?? input.desktop.today?.businessTimeZone ?? null;
  const sendingOff = input.bridges.admin && input.admin?.settings?.effectiveSendingEnabled === false;

  const today = input.bridges.today ? input.today : null;
  const todayView = input.bridges.today ? input.todayView : null;
  const lanes =
    !input.bridges.today
      ? null
      : {
          sections: todayView === null ? [] : laneSections(todayView.cards),
          // Before the first answer the column says it is checking rather than
          // "nothing today", which would be a claim about a list nobody has read.
          emptyLine:
            today === null || todayView === null
              ? CHECKING
              : today.cards.length > 0
                ? null
                : today.online
                  ? HOME_EMPTY
                  : todayView.emptyMessage,
        };
  const needs = needsRows(input);

  return {
    heading: businessDateHeading(snapshotDate, zone),
    summary: today === null ? null : summaryLine(today.cards, sendingOff),
    notices: noticesOf({ ...input, todayView }, desktopBanners),
    lanes,
    status: statusRows(input),
    needs,
    needsLine: needsLine(input, needs),
    figures: figuresView({ admin: input.bridges.admin, figures: input.figures }),
  };
}
