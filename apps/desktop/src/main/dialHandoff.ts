import { e164 } from '@fss/contracts';
import type { ConsumedTicketDto, DialRefusalCode, DialTicketDto } from '@fss/contracts';

/**
 * The `tel:` handoff (specification 9.2, 14.2).
 *
 * "Electron opens `tel:` only with an unexpired, unconsumed ticket. A ticket is
 * consumed immediately before local handoff. Failure to open the local application
 * permits requesting a new authorization but never reusing the ticket. Opening the
 * URL does not complete a step; only a recorded outcome does. A suppression
 * arriving after handoff cannot recall a call already offered to Phone.app, and the
 * product states this limitation."
 *
 * Ported from `src/main/communications/phoneHandoffLauncher.ts`, keeping the three
 * things the old launcher got right and dropping everything it decided for itself.
 *
 * **Kept: the exact-match number check.** `phone.match(...)?.[0] !== phone` rather
 * than `test()`, because JavaScript's `$` also matches before a trailing newline, so
 * `+14015550123\n` passes `test()` and would have been interpolated into a URI. The
 * same check is written here with the shared `e164` schema and a length comparison
 * that a newline cannot slip past.
 *
 * **Kept: the preflight cannot be re-armed.** The old launcher incremented a counter
 * on every dispatch so a slow inspection resolving afterwards could not re-arm a
 * consumed attempt. Same counter, same reason.
 *
 * **Kept: the open is invoked synchronously and a throw afterwards is `unknown`.**
 * Once `openTelUri` has been called, bytes may already have reached the window
 * server. The old code called that `handoff_uncertain`; here it is `opened_unknown`,
 * and either way the ticket is spent and the caller may only request a new one.
 *
 * **Dropped: every decision.** The old launcher consulted its own exclusion list and
 * decided whether a number could be dialed. Section 14.2 is explicit that the client
 * "contains no authoritative sequence, suppression, policy, eligibility, or send
 * logic", so this module checks that it holds a live server-issued ticket and
 * nothing else. The number it dials is the one the server put on the ticket, not one
 * the renderer passed in.
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
   * synchronously. The old launcher required this and it is why: between the
   * inspection and the open, another application may have claimed the scheme.
   */
  isVerifiedHandlerCurrent(): boolean;
  openTelUri(uri: string): Promise<void>;
}

/** What the main process needs from the API. Both are commands; both carry a command id. */
export interface DialApi {
  authorize(input: {
    readonly commandId: string;
    readonly firmId: string;
    readonly contactId?: string | undefined;
    readonly routeId: string;
    readonly routeVersion: number;
    readonly callingIdentityId: string;
  }): Promise<{ readonly ok: true; readonly ticket: DialTicketDto } | { readonly ok: false; readonly reason: string }>;
  consume(input: {
    readonly commandId: string;
    readonly ticketId: string;
  }): Promise<{ readonly ok: true; readonly consumed: ConsumedTicketDto } | { readonly ok: false; readonly reason: string }>;
}

export type SetupProof =
  | { readonly ready: true }
  | { readonly ready: false; readonly reason: 'no_tel_handler' | 'handler_changed' };

export type HandoffOutcome =
  | { readonly status: 'opened'; readonly e164: string }
  /** The open was invoked and may have reached the OS. The ticket is spent either way. */
  | { readonly status: 'opened_unknown' }
  | { readonly status: 'refused'; readonly reason: DialRefusalCode | 'no_tel_handler' | 'handler_changed' | 'invalid_target' }
  | { readonly status: 'not_authorized'; readonly reason: string };

export interface DialHandoff {
  /** Ask the OS whether a `tel:` handler exists. Arms exactly one handoff. */
  checkSetup(): Promise<SetupProof>;
  /** Authorize, consume, then open. Never reuses a ticket and never retries an open. */
  dial(input: {
    readonly commandId: string;
    readonly consumeCommandId: string;
    readonly firmId: string;
    readonly contactId?: string | undefined;
    readonly routeId: string;
    readonly routeVersion: number;
    readonly callingIdentityId: string;
  }): Promise<HandoffOutcome>;
}

/**
 * The sentence the product shows beside the button, from 9.2's last clause.
 * A constant rather than a string in a component, because the limitation is part of
 * the contract and should be versioned with it.
 */
export const HANDOFF_LIMITATION_NOTICE =
  'Once a call is handed to the phone app, Callie cannot recall it. A suppression recorded after that point applies to the next call, not this one.';

export function createDialHandoff(deps: { readonly driver: PhoneLaunchDriver; readonly api: DialApi }): DialHandoff {
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

    async dial(input): Promise<HandoffOutcome> {
      const hadPreflight = armed;
      armed = false;
      // A pending inspection resolving after this point cannot re-arm a consumed or
      // failed attempt.
      ++inspections;

      if (!hadPreflight) return { status: 'refused', reason: 'no_tel_handler' };

      // The setup proof, and only then the ticket: a ticket lives sixty seconds, and
      // spending twenty of them asking the OS a question is how a ticket expires
      // between being minted and being used.
      let stillCurrent: boolean;
      try {
        stillCurrent = deps.driver.isVerifiedHandlerCurrent();
      } catch {
        stillCurrent = false;
      }
      if (!stillCurrent) return { status: 'refused', reason: 'handler_changed' };

      const authorized = await deps.api.authorize({
        commandId: input.commandId,
        firmId: input.firmId,
        ...(input.contactId === undefined ? {} : { contactId: input.contactId }),
        routeId: input.routeId,
        routeVersion: input.routeVersion,
        callingIdentityId: input.callingIdentityId,
      });
      if (!authorized.ok) return { status: 'not_authorized', reason: authorized.reason };

      // "A ticket is consumed immediately before local handoff." Immediately: there
      // is nothing between this and the open but the number check.
      const consumed = await deps.api.consume({
        commandId: input.consumeCommandId,
        ticketId: authorized.ticket.ticketId,
      });
      if (!consumed.ok) return { status: 'not_authorized', reason: consumed.reason };

      const number = consumed.consumed.e164;
      // The server built the URI and the number; this is the last check before the
      // string leaves the process, and it matches the whole input so a trailing
      // newline cannot ride along.
      if (!e164.safeParse(number).success || consumed.consumed.telUri !== `tel:${number}`) {
        return { status: 'refused', reason: 'invalid_target' };
      }

      try {
        const pending = deps.driver.openTelUri(consumed.consumed.telUri);
        return await pending.then(
          (): HandoffOutcome => ({ status: 'opened', e164: number }),
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
    dial: async () => await Promise.resolve({ status: 'refused', reason: 'no_tel_handler' }),
  };
}
