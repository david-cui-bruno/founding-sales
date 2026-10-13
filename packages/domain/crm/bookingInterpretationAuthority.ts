import type { RepositoryContext } from '../db/workspaceScope.ts';
import type { BookingPolicySnapshot, CurrentBookingPolicy, CurrentBookingPolicyQuery } from '../meetings/bookingPolicyTypes.ts';

/** Read-only canonical #622 reader/fence, never another settings store or client permission. */
export interface BookingInterpretationAuthorityPort {
  read(context: RepositoryContext, query: CurrentBookingPolicyQuery): Promise<CurrentBookingPolicy>;
  revalidate(context: RepositoryContext, snapshot: BookingPolicySnapshot): Promise<CurrentBookingPolicy>;
}
export const unavailableBookingInterpretationAuthority: BookingInterpretationAuthorityPort = {
  read: async () => ({ kind: 'unavailable', reason: 'booking_authority_unavailable' }),
  revalidate: async () => ({ kind: 'unavailable', reason: 'booking_authority_unavailable' }),
};
