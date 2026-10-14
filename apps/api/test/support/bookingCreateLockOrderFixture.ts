import { expect } from 'vitest';
import type { BookingPolicyBindings } from '@fss/contracts';
import type { BookingCreateRuntime } from '@fss/domain/meetings/bookingCreateRuntime.ts';
import { bookingCreateSourceFixture } from './bookingCreateFixture.ts';

/** Local minimum of setupBooking, with the same canonical source/policy commands.
 * No imported test registration and no live calendar or pricing evidence. */
export async function bookingCreateLockOrderFixture() {
  const f = await bookingCreateSourceFixture();
  const bindings: BookingPolicyBindings = {
    ownerUserId: f.fixture.alpha.admin.userId,
    account: { provider: 'calcom', accountId: '9', email: 'owner@booking.example', generation: 1 },
    event: { eventTypeId: 7, bookingUrl: 'https://cal.com/controlled/booking', configurationRevision: 'controlled-event-1' },
    calendars: [{ credentialId: 3, externalId: 'controlled-calendar' }],
    source: { scopeRevision: 'controlled-source-1', dataScope: 'necessary_booking_context_attendee_selected_freebusy', dataHandlingVersion: 'minimized-1' },
    sender: { channel: 'email', accountId: f.binding, authorityRevision: 'controlled-sender-1' },
    model: { providerKey: 'aws_bedrock', route: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', modelVersion: 'anthropic.claude-haiku-4-5-20251001-v1:0', accountBinding: 'controlled-bedrock', consentRevision: 'controlled-consent', purpose: 'booking_interpretation', qualityReviewRevision: 'controlled-quality', selection: 'initial_haiku' },
    budget: { lane: 'booking', timeZone: 'America/New_York', dailyCeilingCents: 200, monthlyCeilingCents: 2500 }
  };
  const runtime: BookingCreateRuntime = {
    policy: { now: () => '2026-10-13T17:00:00Z', readEvidence: async () => ({ evidenceKind: 'controlled', binding: bindings, verifiedAt: '2026-10-13T16:00:00Z', validUntil: '2026-10-14T20:00:00Z', accountAccess: true, calendarFreeBusy: true, eventSettings: true, modelConsent: true, modelAcceptance: true, senderAuthority: true, sourceAuthority: true, providerAdapter: true, releaseReady: true, funding: { status: 'verified', sharedRemainingDailyCents: 200, sharedRemainingMonthlyCents: 2500 } }) },
    readCostContract: async () => ({ accountId: '9', eventTypeId: 7, operationScope: 'availability_create_inspection', maximumCents: 0, verifiedAt: '2026-10-13T16:00:00Z', validUntil: '2026-10-14T20:00:00Z', reference: 'controlled-contractual-zero-fixture-not-Cal-pricing' }),
    provider: { availability: async () => ({ available: true, reason: null }), create: async () => ({ state: 'unknown', reason: 'fixture_not_created' }), inspect: async () => ({ state: 'unknown', reason: 'not_found' }) }
  };
  f.runtimeOptions.bookingCreate = runtime;
  f.runtimeOptions.bookingPolicyRuntime = runtime.policy;
  expect((await f.request('POST', '/meetings/booking-policy', f.command({ action: 'save', expectedRevision: 0, bindings }))).status).toBe(200);
  const offeredContext = await f.capture('Can you join Wednesday October 14, 2026 at 10:00 AM America/New_York for our 20 minute call?', 'outgoing');
  const agreement = await f.capture('Yes, that Wednesday time works. Please book the call.');
  const payload = { expectedPolicyRevision: 1, attendeeRouteId: f.attendeeRouteId, agreement, offeredContext, agreedSlot: { startsAt: '2026-10-14T14:00:00Z', timeZone: 'America/New_York' }, confirmation: 'owner_confirmed_unconditional_exact_slot' };
  return { ...f, bindings, runtime, payload };
}
