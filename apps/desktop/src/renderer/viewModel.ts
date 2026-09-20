import type { DesktopState } from '../shared/contract.ts';

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

export interface ScreenView {
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
  offline: 'Callie cannot reach the server.',
});

export const UPGRADE_HEADING = 'Update Callie';
export const SIGN_IN_HEADING = 'Sign in with Google';
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
            : `This list is from an earlier read, at ${state.asOf}. Nothing here can be changed until Callie reconnects.`,
      });
    }
    const notice = state.notice === null ? undefined : NOTICES[state.notice];
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
    signInEnabled: state.screen === 'sign_in' && state.online,
    actionsEnabled: state.mayMutate && state.screen === 'today' && !state.stale,
    showingCachedList: state.stale && state.today !== null,
    cardCount: state.today === null ? 0 : state.today.cards.length,
  };
}
