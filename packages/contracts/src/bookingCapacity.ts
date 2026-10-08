import {z} from 'zod';
import {instant,uuid} from './foundationRows.ts';
import {meetingStateWireSchema} from './meetings.ts';

export const BOOKING_CAPACITY_REASONS = ['integration_off','routing_ambiguous','booking_link_missing','booking_link_unsupported','api_key_missing','api_key_invalid','provider_unauthorized','provider_forbidden','provider_unreachable','provider_rate_limited','provider_invalid_response','account_mismatch','event_not_found','event_ambiguous','event_mismatch','configuration_changed'] as const;
export type BookingCapacityReason = (typeof BOOKING_CAPACITY_REASONS)[number];

/** Configuration evidence for one approved booking link; never an invented available-slot count. */
export const bookingCapacityResponseSchema = z.strictObject({
  preference:z.strictObject({weeklyIntroCalls:z.literal(3),enforcementVerified:z.literal(false)}),
  provider:z.strictObject({
    status:z.enum(['unavailable','observed']),reason:z.enum(BOOKING_CAPACITY_REASONS).nullable(),observedAt:instant.nullable(),
    bookingUrl:z.string().max(2000).nullable(),eventTypeId:z.number().int().positive().nullable(),weeklyLimit:z.number().int().positive().nullable(),scope:z.literal('event_type'),
  }),
  recorded:z.strictObject({observedAt:instant,windowStart:instant,windowEnd:instant,truncated:z.boolean(),bookings:z.array(z.strictObject({
    meetingId:uuid,state:meetingStateWireSchema,startsAt:instant,endsAt:instant,sourceUpdatedAt:instant,
    firm:z.strictObject({id:uuid,name:z.string().max(200)}).nullable(),attendeeEmail:z.string().max(320).nullable(),
    matchReason:z.enum(['firm_unmatched','firm_ambiguous']).nullable(),
  })).max(50)}),
});
export type BookingCapacityResponse = z.infer<typeof bookingCapacityResponseSchema>;
