import type { DesktopState, MailboxState } from '../shared/contract.ts';
import { reasonSentence } from '@fss/contracts';
import { shortDayTime } from './dates.ts';
import { OFFLINE_SENTENCE } from './readError.ts';

/**
 * What the window shows, as a pure function of the state the main process sent.
 *
 * Keeping this separate from the DOM is what lets every rule in specification 14.2 —
 * "when offline or below the minimum client version, cloud-dependent controls show a
 * clear non-actionable state" — be a unit test rather than a screenshot.
 *
 * The renderer composes no sentences of its own about refusals. A refusal arrives as
 * a stable code and this file maps it to one fixed English sentence, so the words a
 * person reads are versioned with the release and the same code never says two things.
 */

export interface BannerView {
  readonly tone: 'info' | 'warning' | 'blocking';
  readonly text: string;
}

interface ScreenView {
  readonly screen: DesktopState['screen'];
  readonly heading: string;
  readonly banners: readonly BannerView[];
  /** Whether the sign-in form is shown and usable. */
  readonly signInEnabled: boolean;
  /** Whether anything that would mutate cloud state may be offered at all. */
  readonly actionsEnabled: boolean;
  /** Whether the list on screen is the cache rather than a fresh read. */
  readonly showingCachedList: boolean;
  readonly cardCount: number;
}

const NOTICES: Readonly<Record<string, string>> = Object.freeze({
  client_upgrade_required: 'This version of Callie is out of date. Install the current build to continue.',
  device_revoked: 'This Mac was signed out remotely. Sign in with Google again.',
  membership_inactive: 'Your access to this workspace has ended.',
  credential_reuse: 'This Mac was signed out for safety. Sign in with Google again.',
  credential_unknown: 'This Mac needs to sign in with Google again.',
  credential_expired: 'This Mac needs to sign in with Google again.',
  reauthentication_required: 'It has been thirty days. Sign in with Google again.',
  session_ended: 'This session has ended. Sign in with Google again.',
  membership_required: 'This Google account has no access to that workspace.',
  handoff_expired: 'That sign-in took too long. Start it again.',
  sign_in_timed_out: 'The browser did not finish signing in. Start it again.',
  signed_out: 'Signed out.',
  // Wave 3b, S7: the sign-out is shown at once and the server is told when it can be.
  // Until it is, this Mac keeps the credential it needs to say so, and nothing else.
  sign_out_pending: 'This Mac still has to tell the server it signed out; Callie retries when it is back online.',
  not_signed_in: 'This Mac needs to sign in with Google again.',
  device_revoked_elsewhere: 'That Mac was signed out.',
  offline: OFFLINE_SENTENCE,
  workspace_required: 'Enter the workspace ID to sign in on this Mac the first time.',
});

const UPGRADE_HEADING = 'Update Callie';
const SIGN_IN_HEADING = 'Sign in with Google';
export const TODAY_HEADING = 'Today';

export function buildScreenView(state: DesktopState): ScreenView {
  const banners: BannerView[] = [];

  if (state.screen === 'upgrade_required') {
    banners.push({ tone: 'blocking', text: NOTICES['client_upgrade_required'] ?? '' });
  } else {
    if (!state.online) banners.push({ tone: 'warning', text: NOTICES['offline'] ?? '' });
    if (state.stale) {
      banners.push({
        tone: 'warning',
        text:
          state.asOf === null
            ? 'This list is from an earlier read.'
            : `This list is from an earlier read, at ${state.asOf}. Changes will fail until Callie reconnects.`,
      });
    }
    // A sign-in that could not reach the server comes back with the notice `offline`,
    // which the line above has already said (wave 1: sign-in is no longer disabled offline).
    const notice = state.notice === null || (state.notice === 'offline' && !state.online) ? undefined : NOTICES[state.notice];
    if (notice !== undefined) banners.push({ tone: 'info', text: notice });
  }

  const heading =
    state.screen === 'upgrade_required'
      ? UPGRADE_HEADING
      : state.screen === 'today'
        ? TODAY_HEADING
        : SIGN_IN_HEADING;

  return {
    screen: state.screen,
    heading,
    banners,
    // An outdated client may read the upgrade instruction and nothing else, so it may
    // not start a sign-in either: signing in registers a device, which is a mutation.
    // Offline does not disable it (wave 1): a sign-in that cannot reach the server says so.
    signInEnabled: state.screen === 'sign_in',
    actionsEnabled: state.mayMutate && state.screen === 'today',
    showingCachedList: state.stale && state.today !== null,
    cardCount: state.today === null ? 0 : state.today.cards.length,
  };
}

// ---------------------------------------------------------------------------
// The Mailbox row on "This Mac" (release.md 8.0x)
// ---------------------------------------------------------------------------

export const MAILBOX_ROW_LABEL = 'Mailbox';
export const CONNECT_GMAIL_LABEL = 'Connect Gmail';
/** The same words the sign-in button uses while the browser has the person. */
export const MAILBOX_WAITING_LABEL = 'Waiting for your browser…';
const MAILBOX_WAITING_HINT =
  'Finish in your browser. If it says Gmail not connected, press Refresh, then Connect Gmail again.';

interface MailboxView {
  /** The row's value: what the server last said, never a guess. */
  readonly text: string;
  /**
   * The one control. Connect Gmail when there is no connected mailbox; the waiting label,
   * disabled, while the consent screen is open; nothing once connected. There is never
   * a Disconnect (see `MailboxBridge` in the shared contract).
   */
  readonly action: { readonly label: string; readonly enabled: boolean } | null;
  readonly hint: string | null;
  /** A refusal or failure, as one fixed sentence. Plain text on the card, never a dialog. */
  readonly notice: string | null;
}

const SYNC_LABELS: Readonly<Record<NonNullable<NonNullable<MailboxState['status']>['mailbox']>['syncState'], string>> =
  Object.freeze({
    baseline_pending: 'baseline pending',
    ready: 'ready',
    recovering: 'recovering',
  });

const MAILBOX_NOTICES: Readonly<Record<string, string>> = Object.freeze({
  offline: OFFLINE_SENTENCE,
  not_signed_in: 'Sign in before connecting Gmail.',
  client_upgrade_required: 'This version of Callie is out of date. Install the current build to continue.',
  mailbox_already_connected: 'Gmail is already connected.',
  mailbox_connect_timed_out: 'Gmail was not connected in time. Press Connect Gmail to start again.',
  consent_url_refused: 'The server sent a consent address Callie will not open.',
  browser_unavailable: 'Callie could not open your browser.',
  unreadable_answer: 'Callie could not read the server’s answer.',
  refused: 'The server refused that.',
});

/**
 * The one place a mailbox code becomes English. A code neither table knows goes to
 * `reasonSentence`, which has the switch and grant refusals and, for anything else, a
 * generic sentence that names the code in parentheses.
 */
export function mailboxNoticeSentence(code: string, options: { readonly address?: string | null } = {}): string {
  if (code === 'mailbox_switch_timed_out') {
    return options.address == null
      ? 'Google didn’t confirm the switch. Your mailbox did not change.'
      : `Google didn’t confirm the switch. Your mailbox is still ${options.address}.`;
  }
  return MAILBOX_NOTICES[code] ?? NOTICES[code] ?? reasonSentence(code);
}

/** "callie@usecallie.com · connected · baseline pending". */
function mailboxStatusLine(
  mailbox: NonNullable<NonNullable<MailboxState['status']>['mailbox']>,
): string {
  // The baseline state only means something for a mailbox that is connected.
  return mailbox.status === 'connected'
    ? [mailbox.emailAddress, mailbox.status, SYNC_LABELS[mailbox.syncState]].join(' · ')
    : [mailbox.emailAddress, mailbox.status].join(' · ');
}

/**
 * The Mailbox row, as a pure function of what the main process sent.
 *
 * `waiting` is the page's own flag for the instant between the click and the main
 * process's first answer, exactly as the sign-in form has one; everything else is the
 * bridge's word. A row whose status has never been read offers nothing to press: a
 * connection started blind could be a second grant for a mailbox that is already
 * connected, and Refresh is one click away.
 */
export function buildMailboxView(state: MailboxState | null, options: { readonly waiting?: boolean } = {}): MailboxView {
  const notice =
    state?.notice == null
      ? null
      : mailboxNoticeSentence(state.notice, { address: state.status?.mailbox?.emailAddress ?? null });
  if ((options.waiting ?? false) || state?.connecting === true) {
    const mailbox = state?.status?.mailbox ?? null;
    return {
      text: mailbox === null ? 'Not connected' : mailboxStatusLine(mailbox),
      action: { label: MAILBOX_WAITING_LABEL, enabled: false },
      hint: MAILBOX_WAITING_HINT,
      notice,
    };
  }
  if (state === null) return { text: 'Checking…', action: null, hint: null, notice: null };
  if (state.status === null) return { text: 'Unknown', action: null, hint: null, notice };
  const mailbox = state.status.mailbox;
  const text = mailbox === null ? 'Not connected' : mailboxStatusLine(mailbox);
  if (state.status.connected) return { text, action: null, hint: null, notice };
  return { text, action: { label: CONNECT_GMAIL_LABEL, enabled: state.mayConnect }, hint: null, notice };
}

// ---------------------------------------------------------------------------
// Settings › Mailbox (call-to-booking A3)
// ---------------------------------------------------------------------------

export const SWITCH_MAILBOX_LABEL = 'Switch mailbox…';
export const DEFAULT_SWITCH_TARGET = 'david@usecallie.com';

export interface MailboxSectionView {
  /** The connected (or last connected) address, or null when there is none. */
  readonly address: string | null;
  /** "Connected · ready", "Not connected", … — what the server last said. */
  readonly stateLine: string;
  /** "Last synced 25 Sep 2026, 14:00" or "Not synced yet"; null when there is no mailbox. */
  readonly syncedLine: string | null;
  /** While the mailbox is reading its first 30 days; null otherwise. */
  readonly baselineLine: string | null;
  /** The outcome of the last connect or switch, as a sentence. */
  readonly notice: string | null;
  /** The latest refused grant the server remembers, when it is not the notice above. */
  readonly lastRefusal: string | null;
  /** True while the consent screen is open. */
  readonly waiting: boolean;
  /** "Waiting for your browser… (david@usecallie.com)" while switching. */
  readonly waitingLine: string | null;
  /** Whether "Switch mailbox…" may be pressed: connected, signed in, online, not already waiting. */
  readonly canSwitch: boolean;
}

const SECTION_SYNC_LABELS = Object.freeze({
  baseline_pending: 'reading the last 30 days',
  ready: 'up to date',
  recovering: 'catching up',
} as const);

/** The Settings › Mailbox section, as a pure function of what the main process sent. */
export function buildMailboxSection(
  state: MailboxState | null,
  options: { readonly waiting?: boolean } = {},
): MailboxSectionView {
  const empty: MailboxSectionView = {
    address: null,
    stateLine: 'Checking…',
    syncedLine: null,
    baselineLine: null,
    notice: null,
    lastRefusal: null,
    waiting: options.waiting ?? false,
    waitingLine: null,
    canSwitch: false,
  };
  if (state === null) return empty;
  const mailbox = state.status?.mailbox ?? null;
  const address = mailbox?.emailAddress ?? null;
  const waiting = (options.waiting ?? false) || state.connecting;
  const notice = state.notice === null ? null : mailboxNoticeSentence(state.notice, { address });
  const refusal = state.status?.lastGrantRefusal ?? null;
  const lastRefusal =
    waiting || refusal === null || refusal.reason === state.notice ? null : reasonSentence(refusal.reason);
  const base = { address, notice, lastRefusal, waiting };
  const waitingLine =
    waiting ? (state.switchingTo == null ? MAILBOX_WAITING_LABEL : `${MAILBOX_WAITING_LABEL} (${state.switchingTo})`) : null;
  if (state.status === null) return { ...empty, ...base, stateLine: 'Unknown', waitingLine };
  if (mailbox === null) return { ...empty, ...base, stateLine: 'Not connected', waitingLine };

  const connected = state.status.connected && mailbox.status === 'connected';
  const baselineLine =
    connected && mailbox.syncState === 'baseline_pending'
      ? mailbox.baseline == null || mailbox.baseline.messagesSeen === 0
        ? 'Reading the last 30 days…'
        : `Reading the last 30 days: ${String(mailbox.baseline.messagesSeen)} ${mailbox.baseline.messagesSeen === 1 ? 'message' : 'messages'} so far`
      : null;
  return {
    ...base,
    stateLine: connected ? `Connected · ${SECTION_SYNC_LABELS[mailbox.syncState]}` : `Not connected (${mailbox.status})`,
    syncedLine: connected
      ? mailbox.lastSyncedAt == null
        ? 'Not synced yet'
        : `Last synced ${shortDayTime(mailbox.lastSyncedAt)}`
      : null,
    baselineLine,
    waitingLine,
    canSwitch: connected && state.mayConnect,
  };
}

/** What a typed target address is worth: a sentence when it cannot be used, else null. */
export function switchTargetIssue(target: string, current: string | null): string | null {
  const trimmed = target.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(trimmed)) return 'Enter a valid e-mail address.';
  if (current !== null && trimmed.toLowerCase() === current.toLowerCase()) return reasonSentence('mailbox_switch_same_address');
  return null;
}
