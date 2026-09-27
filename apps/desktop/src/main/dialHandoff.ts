import { e164 as e164Schema } from '@fss/contracts';

/**
 * The `tel:` handoff (specification 9.2, 14.2; wave 2's S4.5 shape since desktop 1.0.12).
 *
 * Until 1.0.11 a call was a two-command dance: `POST /dial/authorize` minted a
 * sixty-second ticket, `POST /dial/consume` spent it, and the URI came back on the
 * consumption. Wave 2 replaced it with advice — `POST /dial/check` answers "callable, and
 * here is the URI", writes nothing and mints nothing — and the call is logged afterwards
 * with `POST /calls/log`, which never needed a ticket. So the two commands are gone and
 * this module is what is left of the handoff: the proof that a phone app exists, and the
 * one place a URI is checked before it is opened.
 *
 * What the ticket flow got right and this keeps:
 *
 * **The exact-match number check.** The comparison is against the whole string rather
 * than `test()`, because JavaScript's `$` also matches before a trailing newline, so
 * `+14015550123\n` passes `test()` and would have been interpolated into a URI.
 *
 * **The preflight cannot be re-armed.** A counter is bumped on every dispatch, so a slow
 * inspection resolving afterwards cannot re-arm an attempt that has already gone.
 *
 * **The open is invoked synchronously and a throw afterwards is `unknown`.** Once
 * `openTelUri` has been called, bytes may already have reached the window server. That is
 * `opened_unknown`, and the card says "Callie could not confirm the phone app opened.
 * Record what happened either way" rather than pretending to know.
 *
 * **Every decision is the server's.** 14.2: the client "contains no authoritative
 * sequence, suppression, policy, eligibility, or send logic". This module never asks
 * whether a number may be called; it is handed the advice's own URI and checks that the
 * string it was handed is a `tel:` URI for the number the advice named.
 */

/** What the main process needs from the operating system. No Electron import here. */
export interface PhoneLaunchDriver {
  /**
   * Whether a `tel:` handler is registered and is the one the person expects.
   * Asynchronous because asking the OS is.
   */
  inspectVerifiedHandler(): Promise<'verified' | 'unavailable'>;
  /**
   * Whether the handler verified a moment ago is still the current one, answered
   * synchronously: between the inspection and the open, another application may have
   * claimed the scheme.
   */
  isVerifiedHandlerCurrent(): boolean;
  openTelUri(uri: string): Promise<void>;
}

export type SetupProof =
  | { readonly ready: true }
  | { readonly ready: false; readonly reason: 'no_tel_handler' | 'handler_changed' };

export type HandoffOutcome =
  | { readonly status: 'opened'; readonly e164: string }
  /** The open was invoked and may have reached the OS. Record the call either way. */
  | { readonly status: 'opened_unknown' }
  | { readonly status: 'refused'; readonly reason: 'no_tel_handler' | 'handler_changed' | 'invalid_target' };

export interface DialHandoff {
  /** Ask the OS whether a `tel:` handler exists. Arms exactly one handoff. */
  checkSetup(): Promise<SetupProof>;
  /**
   * Open the URI `POST /dial/check` answered with. The caller has just re-read the advice;
   * this checks the string is a `tel:` URI for the number the advice named and opens it.
   */
  open(input: { readonly telUri: string; readonly e164: string }): Promise<HandoffOutcome>;
}

/**
 * The sentence the product shows beside the button, from 9.2's last clause.
 * A constant rather than a string in a component, because the limitation is part of
 * the contract and should be versioned with it.
 */
export const HANDOFF_LIMITATION_NOTICE =
  'Once a call is handed to the phone app, Callie cannot recall it. A suppression recorded after that point applies to the next call, not this one.';

export function createDialHandoff(deps: { readonly driver: PhoneLaunchDriver }): DialHandoff {
  let armed = false;
  let inspections = 0;

  return {
    async checkSetup(): Promise<SetupProof> {
      const current = ++inspections;
      armed = false;
      try {
        const handler = await deps.driver.inspectVerifiedHandler();
        // A later inspection started while this one was in flight: its answer is the
        // current one, and this answer arms nothing.
        if (current !== inspections) return { ready: false, reason: 'handler_changed' };
        if (handler !== 'verified') return { ready: false, reason: 'no_tel_handler' };
        armed = true;
        return { ready: true };
      } catch {
        return { ready: false, reason: 'no_tel_handler' };
      }
    },

    async open(input): Promise<HandoffOutcome> {
      const hadPreflight = armed;
      armed = false;
      // A pending inspection resolving after this point cannot re-arm an attempt that
      // has already been made.
      ++inspections;

      if (!hadPreflight) return { status: 'refused', reason: 'no_tel_handler' };

      let stillCurrent: boolean;
      try {
        stillCurrent = deps.driver.isVerifiedHandlerCurrent();
      } catch {
        stillCurrent = false;
      }
      if (!stillCurrent) return { status: 'refused', reason: 'handler_changed' };

      // The server built the URI and the number; this is the last check before the
      // string leaves the process, and it matches the whole input so a trailing newline
      // cannot ride along.
      if (!e164Schema.safeParse(input.e164).success || input.telUri !== `tel:${input.e164}`) {
        return { status: 'refused', reason: 'invalid_target' };
      }

      try {
        const pending = deps.driver.openTelUri(input.telUri);
        return await pending.then(
          (): HandoffOutcome => ({ status: 'opened', e164: input.e164 }),
          (): HandoffOutcome => ({ status: 'opened_unknown' }),
        );
      } catch {
        // A synchronous throw may still have happened after the handoff began.
        return { status: 'opened_unknown' };
      }
    },
  };
}

/** The handoff a build with no OS binding uses. It opens nothing and says so. */
export function unavailableDialHandoff(): DialHandoff {
  return {
    checkSetup: async () => await Promise.resolve({ ready: false, reason: 'no_tel_handler' }),
    open: async () => await Promise.resolve({ status: 'refused', reason: 'no_tel_handler' }),
  };
}
