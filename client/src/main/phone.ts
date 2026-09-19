import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isExcludedNumber } from '../../../src/main/communications/excludedNumbers';
import { createPhoneHandoffLauncher } from '../../../src/main/communications/phoneHandoffLauncher';
import { createNativePhoneLaunchDriver, inspectNativePhoneRouteCandidate, resolveVerifiedNativePhoneHelper } from '../../../src/main/communications/phoneLaunchDriver';
import { PhoneRouteSettings } from '../../../src/main/communications/phoneRouteSettings';
import { CALLIE_APPLE_BRIDGE_IDENTIFIER } from '../../../src/main/appleBridge/helperPath';
import type { TodayCard, TodayView } from '../../../src/shared/contracts/v1Contract';
import { TODAY_STALE_MS } from '../renderer/today/todayModel';
import { DIAL_REFUSAL_SENTENCES, PHONE_SETUP_SENTENCES, type ClientPhoneSetup as ClientPhoneSetupResult,
  type DialRefusal, type DialResult } from '../shared/clientContract';

type PhoneSetupState = ClientPhoneSetupResult['state'];

/**
 * The Phone.app handoff of the thin client (FSS target design section 6: the only native piece). The launcher, the
 * driver, the packaged helper path, the same-team signature check and the local setup proof are the old app's
 * modules, imported unchanged from the repository's `src/main`; nothing about them is reimplemented here.
 *
 * What is new is the gate in front of them, which is the worker's own verdict rather than a local one:
 *
 *   - the card must come from the Today view this main process last served, and that view must be under two minutes old
 *   - the card's `dialAllowed` must be true, which the worker computed at request time from the firm's zone
 *   - the number must be exactly the one on that card, so a renderer can never substitute another
 *   - the number must pass the production launcher's excluded-number rules, independently of everything above
 *   - a firm the worker holds as suppressed is never dialed, whatever else the card says
 *
 * Handing a number to Phone.app is not a call: it opens the dialer with the number in it and David presses the
 * button. The honest outcomes are therefore handed off, refused with a reason, or unknown — never "called". Only
 * `log_call_outcome` records what happened, and only David can say what that was.
 */

export type { DialRefusal, DialResult };

/** The Today view this main process last served, with the instant it was fetched. */
export type HeldView = { view: TodayView; fetchedAt: string };
/** What the old app's launcher exposes; injected whole in the unit tests. */
export type HandoffLauncher = {
  inspectCapability(): Promise<{ state: 'available' | 'unavailable'; reasonCode: string | null }>;
  dispatch(phone: string): Promise<{ status: 'handoff_accepted' | 'refused' | 'unavailable' | 'unknown'; reasonCode: string | null }>;
};

export type ClientPhoneInput = {
  /** The last `GET /v1/today` answer this process served, or null when it has served none. */
  heldView: () => HeldView | null;
  /** The launcher, resolved lazily so no helper or OS work happens before a dial is asked for. Null means no route. */
  launcher: () => Promise<HandoffLauncher | null>;
  now?: () => number;
  isExcludedNumber?: (phone: string) => boolean;
  /** How old a view may be and still be dialed from. Two minutes, the same window the page's stale banner uses. */
  staleMs?: number;
};

const refused = (reason: DialRefusal): DialResult => ({ outcome: 'refused', reason, sentence: DIAL_REFUSAL_SENTENCES[reason] });

/** The card for one firm in a view, whichever lane it stands in. Pure. */
export function cardOfView(view: TodayView, firmId: string): TodayCard | null {
  if (view.list === null) return null;
  for (const lane of ['replies', 'callbacks', 'due', 'new'] as const) {
    const card = view.list.lanes[lane].find(entry => entry.firmId === firmId);
    if (card) return card;
  }
  return null;
}

export class ClientPhone {
  constructor(private readonly input: ClientPhoneInput) {}

  /**
   * One dial. Every refusal is named, so the renderer shows a sentence and never a silent nothing. The order matters:
   * the view's age and the card's own verdict are checked before anything touches the helper, so a stale or held card
   * cannot even reach the OS.
   */
  async dial(request: { firmId: string; number: string }): Promise<DialResult> {
    const held = this.input.heldView();
    if (!held) return refused('no_view');
    const now = (this.input.now ?? Date.now)();
    const fetched = Date.parse(held.fetchedAt);
    if (!Number.isFinite(fetched) || now - fetched >= (this.input.staleMs ?? TODAY_STALE_MS)) return refused('view_stale');
    const card = cardOfView(held.view, request.firmId);
    if (!card) return refused('card_unknown');
    // A suppressed firm is never dialed, whatever else the card says. The worker never puts one on a list at all;
    // this is the second lock on the same door, on the side David's own click is on.
    if (card.holdReason === 'suppressed') return refused('suppressed');
    if (card.dialAllowed !== true) return refused('dial_not_allowed');
    if (card.phone === null || card.phone.number !== request.number) return refused('number_mismatch');
    const excluded = this.input.isExcludedNumber ?? isExcludedNumber;
    try { if (excluded(request.number) !== false) return refused('number_excluded'); }
    catch { return refused('number_excluded'); }

    let launcher: HandoffLauncher | null;
    try { launcher = await this.input.launcher(); }
    catch { return refused('route_unavailable'); }
    if (!launcher) return refused('route_unavailable');
    try {
      const capability = await launcher.inspectCapability();
      if (capability.state !== 'available') return refused('route_unavailable');
      const result = await launcher.dispatch(request.number);
      if (result.status === 'handoff_accepted') return { outcome: 'handed_off', number: request.number };
      if (result.status === 'unknown') return { outcome: 'unknown', reason: 'handoff_uncertain', sentence: DIAL_REFUSAL_SENTENCES.handoff_uncertain };
      return refused(result.status === 'refused' ? 'number_excluded' : 'route_unavailable');
    } catch { return refused('route_unavailable'); }
  }
}

/**
 * The production launcher: the packaged same-team helper and the setup proof file under the client's own directory.
 * Resolved once, lazily, and only on macOS in a packaged build — `resolveVerifiedNativePhoneHelper` refuses an
 * unpackaged one outright, which is why a development run and the Playwright specs have no route at all and say so.
 */
export function createProductionDialLauncher(input: {
  clientDirectory: string;
  isPackaged: boolean;
  resourcesPath: string;
  parentExecutablePath: string;
  platform?: NodeJS.Platform;
}): () => Promise<HandoffLauncher | null> {
  const settings = new PhoneRouteSettings(join(input.clientDirectory, 'phone-route.json'));
  let pending: Promise<HandoffLauncher | null> | undefined;
  return () => pending ??= (async () => {
    if ((input.platform ?? process.platform) !== 'darwin' || !input.isPackaged) return null;
    const verifiedHelperPath = await resolveVerifiedNativePhoneHelper({
      path: { isPackaged: true, resourcesPath: input.resourcesPath, developmentExecutablePath: '/forbidden', environment: {} },
      signature: { parentExecutablePath: input.parentExecutablePath, expectedIdentifier: CALLIE_APPLE_BRIDGE_IDENTIFIER },
    });
    return createPhoneHandoffLauncher({
      driver: createNativePhoneLaunchDriver({ verifiedHelperPath, setupFingerprint: () => settings.read()?.fingerprint ?? null }),
      // The domain gate above checked the card; the launcher independently refuses service codes, short codes,
      // the plant-test exchanges, the reserved fictional block and anything not well-formed E.164.
      isExcludedNumber,
    });
  })().catch(() => null);
}

/**
 * The fingerprint of the phone helper this Mac would actually launch (S5), for the setup proof. Null on anything
 * but a packaged macOS build, because `resolveVerifiedNativePhoneHelper` refuses an unpackaged helper outright:
 * a development run and the Playwright specs therefore have no candidate and the section says so.
 */
export async function inspectProductionPhoneCandidate(input: {
  isPackaged: boolean;
  resourcesPath: string;
  parentExecutablePath: string;
  platform?: NodeJS.Platform;
}): Promise<string | null> {
  if ((input.platform ?? process.platform) !== 'darwin' || !input.isPackaged) return null;
  try {
    const verifiedHelperPath = await resolveVerifiedNativePhoneHelper({
      path: { isPackaged: true, resourcesPath: input.resourcesPath, developmentExecutablePath: '/forbidden', environment: {} },
      signature: { parentExecutablePath: input.parentExecutablePath, expectedIdentifier: CALLIE_APPLE_BRIDGE_IDENTIFIER },
    });
    return await inspectNativePhoneRouteCandidate({ verifiedHelperPath });
  } catch { return null; }
}

/** Whether the local setup proof this Mac holds names a fingerprint at all. Read-only; never authorization. */
export function readPhoneSetupProof(clientDirectory: string): { confirmed: boolean; confirmedAt: string | null } {
  const proof = new PhoneRouteSettings(join(clientDirectory, 'phone-route.json')).read();
  return { confirmed: proof !== null, confirmedAt: proof?.confirmedAt ?? null };
}

/**
 * The Phone.app setup proof as the Settings page reads and writes it (slice S5). The proof rule is the old app's,
 * carried here unchanged: `PhoneRouteSettings` owns the file (0600, no symlink, no oversize, three keys), and the
 * state is the same comparison `createPhoneSetupService` makes — the stored fingerprint against the fingerprint of
 * the helper this Mac would actually launch. What differs is the shape it is reported in, and that the digest the
 * worker records is the sha256 of the fingerprint rather than the fingerprint itself.
 *
 * Nothing here dials, and confirming is not permission to dial: the launcher checks the helper's signature and the
 * excluded-number rules at the moment a number is handed over, whatever this file says.
 */
export type ClientPhoneSetupInput = {
  clientDirectory: string;
  /** The fingerprint of the helper this Mac would launch, or null when there is none to inspect. */
  inspectCandidate: () => Promise<string | null>;
  now?: () => string;
};

export const proofDigest = (fingerprint: string): string => createHash('sha256').update(fingerprint).digest('hex');

export class ClientPhoneSetup {
  private readonly settings: PhoneRouteSettings;
  constructor(private readonly input: ClientPhoneSetupInput) {
    this.settings = new PhoneRouteSettings(join(input.clientDirectory, 'phone-route.json'));
  }

  private answer(state: PhoneSetupState, proof: { fingerprint: string; confirmedAt: string } | null, candidate: string | null): ClientPhoneSetupResult {
    return { state, confirmedAt: proof?.confirmedAt ?? null, proofDigest: proof ? proofDigest(proof.fingerprint) : null,
      candidateDigest: candidate === null ? null : proofDigest(candidate), sentence: PHONE_SETUP_SENTENCES[state] };
  }

  /** The state of this Mac's proof. A candidate that cannot be inspected is `unavailable`, never a guess. */
  async read(): Promise<ClientPhoneSetupResult> {
    let candidate: string | null;
    try { candidate = await this.input.inspectCandidate(); } catch { candidate = null; }
    const proof = this.settings.read();
    if (candidate === null) return this.answer('unavailable', proof, null);
    if (proof?.fingerprint === candidate) return this.answer('configured', proof, candidate);
    return this.answer('needs_confirmation', proof, candidate);
  }

  /** Writes the proof for the helper this Mac would launch. Refuses when there is none: no proof is ever invented. */
  async confirm(): Promise<ClientPhoneSetupResult> {
    let candidate: string | null;
    try { candidate = await this.input.inspectCandidate(); } catch { candidate = null; }
    if (candidate === null) return this.answer('unavailable', this.settings.read(), null);
    const confirmedAt = (this.input.now ?? (() => new Date().toISOString()))();
    try { this.settings.confirm({ version: 1, fingerprint: candidate, confirmedAt }); }
    catch { return this.answer('unavailable', this.settings.read(), candidate); }
    return this.read();
  }

  /** Removes the proof. A Mac with no proof cannot hand a number to Phone.app at all. */
  async clear(): Promise<ClientPhoneSetupResult> {
    try { this.settings.clear(); } catch { /* A proof that cannot be removed is reported by the read below. */ }
    return this.read();
  }
}
