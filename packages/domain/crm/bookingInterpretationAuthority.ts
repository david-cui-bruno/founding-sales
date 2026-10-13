import type { RepositoryContext } from '../db/workspaceScope.ts';
import type { BookingPolicyView } from '@fss/contracts';
import type { BookingPolicySnapshot, CurrentBookingPolicy, CurrentBookingPolicyQuery, BookingPolicyRuntime } from '../meetings/bookingPolicyTypes.ts';
import { readCurrentBookingPolicy, revalidateBookingPolicy, readBookingPolicy } from '../meetings/bookingPolicy.ts';
/** Canonical read-only authority. Never supplied by a command or model candidate. */
export interface BookingInterpretationAuthorityPort {
  read(context: RepositoryContext, query: CurrentBookingPolicyQuery): Promise<CurrentBookingPolicy>;
  revalidate(context: RepositoryContext, snapshot: BookingPolicySnapshot): Promise<CurrentBookingPolicy>;
  budget(context: RepositoryContext, snapshot: BookingPolicySnapshot): Promise<BookingPolicyView['budget'] | null>;
}
export const unavailableBookingInterpretationAuthority: BookingInterpretationAuthorityPort = {
  read: async () => ({ kind: 'unavailable', reason: 'booking_authority_unavailable' }),
  revalidate: async () => ({ kind: 'unavailable', reason: 'booking_authority_unavailable' }),
  budget: async () => null,
};
/** No live composition: absent canonical trusted evidence stays unavailable. */
export function createBookingInterpretationAuthority(runtime?: BookingPolicyRuntime): BookingInterpretationAuthorityPort {
  return {
    read: (context, query) => readCurrentBookingPolicy(context, { ...query, capability: 'interpretation' }, runtime),
    revalidate: (context, snapshot) => revalidateBookingPolicy(context, snapshot, runtime),
    async budget(context, snapshot) {
      const current = await revalidateBookingPolicy(context, snapshot, runtime);
      if (current.kind !== 'available') return null;
      return (await readBookingPolicy(context, runtime)).budget;
    },
  };
}
