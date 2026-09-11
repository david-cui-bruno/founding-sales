import type { Capability, HandoffResult } from '../../shared/contracts/outboundContract';
import type { OutboundReadinessPort, PhoneHandoffPort } from './outboundPorts';

export interface PhoneLaunchDriver {
  inspectVerifiedHandler(): Promise<'phone_continuity_verified' | 'unavailable'>;
  isVerifiedHandlerCurrent(): boolean;
  openTelUri(uri: string): Promise<void>;
}

const routeUnavailable: Capability = Object.freeze({ state: 'unavailable', reasonCode: 'phone_route_unverified' });
const noRoute: HandoffResult = Object.freeze({ status: 'unavailable', reasonCode: 'phone_route_unverified' });
const invalidTarget: HandoffResult = Object.freeze({ status: 'refused', reasonCode: 'invalid_target' });
const uncertain: HandoffResult = Object.freeze({ status: 'unknown', reasonCode: 'handoff_uncertain' });

// No OS binding is supplied here. A future driver needs independent route proof,
// including a synchronous exact-handler check. There is deliberately no TTL.
export function createPhoneHandoffLauncher(input: {
  driver: PhoneLaunchDriver;
  isExcludedNumber(phone: string): boolean;
}): PhoneHandoffPort {
  let verifiedPreflight = false;
  let inspection = 0;

  return {
    async inspectCapability(): Promise<Capability> {
      const current = ++inspection;
      verifiedPreflight = false;
      try {
        const handler = await input.driver.inspectVerifiedHandler();
        if (current !== inspection || handler !== 'phone_continuity_verified') return routeUnavailable;
        verifiedPreflight = true;
        return { state: 'available', reasonCode: null };
      } catch {
        return routeUnavailable;
      }
    },
    dispatch(phone): Promise<HandoffResult> {
      const hadPreflight = verifiedPreflight;
      verifiedPreflight = false;
      ++inspection; // Pending inspections cannot rearm a consumed/failed attempt.

      // Matching the entire input also excludes a final newline, which JS `$`
      // alone permits. Never trim, decode, normalize or accept a caller's URI.
      if (typeof phone !== 'string' || phone.match(/^\+[1-9][0-9]{7,14}$/)?.[0] !== phone) {
        return Promise.resolve(invalidTarget);
      }
      try {
        if (input.isExcludedNumber(phone) !== false) return Promise.resolve(invalidTarget);
      } catch {
        return Promise.resolve(invalidTarget);
      }
      try {
        if (!hadPreflight || input.driver.isVerifiedHandlerCurrent() !== true) return Promise.resolve(noRoute);
      } catch {
        return Promise.resolve(noRoute);
      }

      // Invoke synchronously. A throw may occur after the external handoff began.
      try {
        const pending = input.driver.openTelUri(`tel:${phone}`);
        return pending.then(
          (): HandoffResult => ({ status: 'handoff_accepted', reasonCode: null }),
          () => uncertain,
        );
      } catch {
        return Promise.resolve(uncertain);
      }
    },
  };
}

// These are the only production bindings in this slice. Neither performs work,
// reads OS/personal state, launches anything, nor accepts an enabling flag.
export function unavailablePhoneHandoff(): PhoneHandoffPort {
  return {
    inspectCapability: async () => routeUnavailable,
    dispatch: async () => noRoute,
  };
}

export function unavailableOutboundReadiness(): OutboundReadinessPort {
  return {
    getCapability: () => ({ state: 'unavailable', reasonCode: 'inbound_safety_unwired' }),
    check: async () => ({ kind: 'blocked', reasonCode: 'inbound_safety_unwired' }),
    assertCurrent: () => { throw new Error('Inbound readiness is unavailable.'); },
  };
}
