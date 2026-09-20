import { consumedTicketDtoSchema, dialTicketDtoSchema } from '@fss/contracts';
import type { AuthedClient } from './authedClient.ts';
import type { DialApi, PhoneLaunchDriver } from './dialHandoff.ts';
import { probeSchemeHandlers, type SchemeHandlers } from './launchServices.ts';

/**
 * The one place a `tel:` URI reaches macOS (specification 9.2, 14.2, 17).
 *
 * G4 wrote the handoff *logic* — the setup proof, the ticket, the consumption, the
 * "a failed open is `unknown`" rule — against two ports and deliberately imported no
 * Electron: `PhoneLaunchDriver` for the operating system and `DialApi` for the server.
 * This file is those two ports, and nothing else. It holds no decision about whether a
 * call may be placed; `authorizeDial` on the server made that, and the number dialed is
 * the one the server put on the ticket.
 *
 * There is no Swift helper: section 2's decision table says "Thin Electron application;
 * the main process opens `tel:` URLs; no native Swift helper", and David confirmed it.
 *
 * ## Only `tel:`, by construction
 *
 * `shell.openExternal` will open anything macOS has a handler for, including `file:`,
 * `x-apple-*` and whatever an application registered this morning. A driver that passed
 * its argument through would make every caller of `openTelUri` a general-purpose
 * "open this URL as the user" primitive, one argument away from being the most useful
 * thing an attacker could find in this process.
 *
 * So the check is here, it is an exact match against an E.164 `tel:` URI rather than a
 * prefix test, and it throws before anything is opened. `shell.openExternal` is
 * unreachable from this module for any other string.
 *
 * The match is `exec(...)?.[0] === uri` rather than `test(...)`, and that is the same
 * trap G4's launcher documented: JavaScript's `$` also matches before a trailing
 * newline, so `tel:+14015550123\n` passes `test()`.
 */

const TEL_URI = /^tel:\+[1-9][0-9]{7,14}$/u;

/** Whether this string is a `tel:` URI and an E.164 number, and nothing else. */
export function isTelUri(value: string): boolean {
  return TEL_URI.exec(value)?.[0] === value;
}

export class NotATelUriError extends Error {
  readonly code = 'not_a_tel_uri';
  constructor() {
    super('this driver opens tel: URIs and nothing else');
    this.name = 'NotATelUriError';
  }
}

/**
 * How long a launch-services answer counts as current.
 *
 * `isVerifiedHandlerCurrent` is synchronous, and the only honest way to answer it is
 * from a recent probe: the real check reads an `lsregister -dump` that takes seconds
 * and tens of megabytes, which is not something that can happen between consuming a
 * ticket and opening a URI. Sixty seconds is the ticket's own life (9.2), so a proof
 * that has outlived a ticket has outlived its usefulness too.
 */
export const HANDLER_PROOF_MILLISECONDS = 60_000;

export interface TelLaunchDriverDeps {
  /** The launch-services read. A pure query that never launches anything. */
  readonly probe?: (scheme: string) => SchemeHandlers;
  /** `shell.openExternal`. Loaded lazily so this module is testable without Electron. */
  readonly openExternal?: (uri: string) => Promise<void>;
  readonly now?: () => number;
}

async function electronOpenExternal(uri: string): Promise<void> {
  // A dynamic import, so `telHandoff.ts` — like `dialHandoff.ts` — can be unit-tested
  // in a plain Node process that has no Electron runtime to bind to.
  const { shell } = await import('electron');
  await shell.openExternal(uri);
}

/**
 * The OS half of the handoff.
 *
 * `inspectVerifiedHandler` fails closed on every answer that is not "a bundle claims
 * `tel:`": `absent` is no phone app, and `unknown` is "not macOS, or the database
 * could not be read", which is not a proof of anything and must not be treated as one.
 */
export function createTelLaunchDriver(deps: TelLaunchDriverDeps = {}): PhoneLaunchDriver {
  const probe = deps.probe ?? (scheme => probeSchemeHandlers(scheme));
  const openExternal = deps.openExternal ?? electronOpenExternal;
  const now = deps.now ?? (() => Date.now());

  let provenAt: number | null = null;

  return {
    inspectVerifiedHandler: async (): Promise<'verified' | 'unavailable'> => {
      await Promise.resolve();
      let handlers: SchemeHandlers;
      try {
        handlers = probe('tel');
      } catch {
        provenAt = null;
        return 'unavailable';
      }
      if (handlers.kind !== 'available') {
        provenAt = null;
        return 'unavailable';
      }
      provenAt = now();
      return 'verified';
    },

    isVerifiedHandlerCurrent: (): boolean =>
      provenAt !== null && now() - provenAt <= HANDLER_PROOF_MILLISECONDS,

    openTelUri: async (uri: string): Promise<void> => {
      if (!isTelUri(uri)) throw new NotATelUriError();
      await openExternal(uri);
    },
  };
}

/**
 * The server half: the two commands of 9.2, through the window's authenticated client.
 *
 * Both are commands with their own receipts (5.3), so `AuthedClient.command` mints an
 * id for each and the caller passes the two it was given — `dialHandoff` already keeps
 * them apart, because one id for both would make the consumption a replay.
 *
 * A refusal arrives as its stable code and is returned as one. Nothing here interprets
 * it: `already_consumed`, `route_version_stale` and `firm_suppressed` are sentences the
 * renderer's notice table owns.
 */
export function createDialApi(api: AuthedClient): DialApi {
  return {
    authorize: async input => {
      const answer = await api.command(
        '/dial/authorize',
        {
          firmId: input.firmId,
          ...(input.contactId === undefined ? {} : { contactId: input.contactId }),
          routeId: input.routeId,
          routeVersion: input.routeVersion,
          callingIdentityId: input.callingIdentityId,
        },
        value => dialTicketDtoSchema.parse(value),
        { commandId: input.commandId },
      );
      return answer.ok ? { ok: true, ticket: answer.value } : { ok: false, reason: answer.reason };
    },
    consume: async input => {
      const answer = await api.command(
        '/dial/consume',
        { ticketId: input.ticketId },
        value => consumedTicketDtoSchema.parse(value),
        { commandId: input.commandId },
      );
      return answer.ok ? { ok: true, consumed: answer.value } : { ok: false, reason: answer.reason };
    },
  };
}
