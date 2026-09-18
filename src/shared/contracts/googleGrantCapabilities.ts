import { z } from 'zod';
/** Technical provider powers only. None of these authorizes cold outreach. */
export const googleScopes = {
  send: 'https://www.googleapis.com/auth/gmail.send',
  relevant_read: 'https://www.googleapis.com/auth/gmail.readonly',
  availability: 'https://www.googleapis.com/auth/calendar.freebusy',
  event_write: 'https://www.googleapis.com/auth/calendar.events.owned',
} as const;
export const googleCapabilitySchema = z.enum(['send', 'relevant_read', 'availability', 'event_write']);
export type GoogleCapability = z.infer<typeof googleCapabilitySchema>;
export const googleCalendarSelectionSchema = z.strictObject({ ownedCalendarId: z.string().min(1).max(255),
  conflictCalendarIds: z.array(z.string().min(1).max(255)).min(1).max(20), confirmed: z.literal(true) });
export type GoogleCalendarSelection = z.infer<typeof googleCalendarSelectionSchema>;
export const legacyGoogleGrantSchema = z.strictObject({ provider: z.literal('google'), subject: z.string().min(1).max(255),
  email: z.string().email().max(254), grantedScopes: z.array(z.string().min(1).max(500)).min(1).max(20),
  owner: z.enum(['local', 'remote']), purpose: z.literal('permitted_correspondence'), capabilities: z.array(googleCapabilitySchema).max(4), calendars: googleCalendarSelectionSchema.optional(),
}).refine(grant => new Set(grant.capabilities).size === grant.capabilities.length
  && grant.capabilities.every(capability => grant.grantedScopes.includes(googleScopes[capability])), 'grant_missing_capability');
export const googleGrantPurposeSchema = z.enum(['permitted_correspondence', 'personal_availability']);
export type GoogleGrantPurpose = z.infer<typeof googleGrantPurposeSchema>;
// Confirmation records explicit selection, not provider resource-access proof.
const explicitCalendarId = z.string().email().max(255).regex(/^[a-z0-9._#-]+@[a-z0-9.-]+$/);
export const googleAvailabilityCalendarSelectionSchema = z.strictObject({
  calendarIds: z.array(explicitCalendarId).min(1).max(20).refine(ids => new Set(ids).size === ids.length), confirmed: z.literal(true),
});
export type GoogleAvailabilityCalendarSelection = z.infer<typeof googleAvailabilityCalendarSelectionSchema>;
export const googleGrantBeginOptionsSchema = z.union([
  z.strictObject({ purpose: z.literal('permitted_correspondence').optional(),
    expectedEmail: z.string().email().max(254).refine(value => value === value.toLowerCase()).optional() }),
  z.strictObject({ purpose: z.literal('personal_availability'), availabilityCalendars: googleAvailabilityCalendarSelectionSchema }),
]);
export type GoogleGrantBeginOptions = z.infer<typeof googleGrantBeginOptionsSchema>;
const personalIdentityScopes = ['openid', 'email', 'https://www.googleapis.com/auth/userinfo.email'];
const personalGoogleGrantSchema = z.strictObject({ provider: z.literal('google'), subject: z.string().min(1).max(255),
  email: z.string().email().max(254), grantedScopes: z.array(z.string().min(1).max(500)).min(1).max(20),
  owner: z.literal('remote'), purpose: z.literal('personal_availability'), capabilities: z.array(z.literal('availability')).length(1),
  availabilityCalendars: googleAvailabilityCalendarSelectionSchema,
}).refine(grant => grant.grantedScopes.includes('openid')
  && grant.grantedScopes.some(scope => scope === 'email' || scope === personalIdentityScopes[2])
  && grant.grantedScopes.includes(googleScopes.availability)
  && grant.grantedScopes.every(scope => personalIdentityScopes.includes(scope) || scope === googleScopes.availability), 'google_scope_unapproved');
export const googleGrantSchema = z.union([legacyGoogleGrantSchema, personalGoogleGrantSchema]);
// Type-only absent property keeps historical metadata readers source-compatible.
// The strict personal runtime schema still rejects any owned-calendar field.
export type GoogleGrant = z.infer<typeof legacyGoogleGrantSchema>
  | (z.infer<typeof personalGoogleGrantSchema> & { calendars?: never });
export function capabilitiesForScopes(scopes: readonly string[]): GoogleCapability[] {
  return googleCapabilitySchema.options.filter(capability => scopes.includes(googleScopes[capability]));
}
export function requireCapabilities(grant: GoogleGrant | undefined, required: GoogleCapability[]): void {
  const parsed = googleGrantSchema.safeParse(grant);
  if (!parsed.success || required.some(capability => !(parsed.data.capabilities as readonly GoogleCapability[]).includes(capability)
    || !parsed.data.grantedScopes.includes(googleScopes[capability]))) throw new Error('grant_missing_capability');
}
/** Revision 2 (18 September 2026). The deployed OAuth client is a Google Workspace
 * Internal-audience client, so the External "Testing" refresh-token warning of revision 1
 * no longer describes it and was withdrawn. The version is part of the begin request, so a
 * desktop holding a stale text cannot start consent. */
export const googleGrantDisclosure = {
  version: 'google-grant-v2',
  text: 'Your Worker holds this grant in the cloud, not on this Mac. The OAuth client is a Google Workspace Internal-audience client, so only an account inside your own Workspace can complete this consent. With the grant the Worker does exactly two things: it sends mail from the named @usecallie.com mailbox you confirm here, and only under a template you approved or a message you approved one at a time; and it reads replies on the threads it already sent, to show them to you. It does not read the rest of the mailbox, does not train any model on the mailbox, and does not create or edit calendar events. Gmail read is a restricted scope: before you activate reply drafting, review the selected model provider, exactly what message data may transfer, and that provider’s retention settings. Verification requirements depend on the actual deployment and are not presumed exempt. Free/busy, where this grant is used for it at all, applies only to the confirmed owned/conflict calendars supported by that scope, and shared-calendar access requires a separate explicit scope review. An OAuth grant does not authorize unsolicited email.',
} as const;

export const personalGoogleGrantDisclosure = {
  version: 'personal-google-grant-v2',
  text: 'This remote personal Google grant uses verified identity and free/busy only for explicitly confirmed calendar IDs. It does not read or send personal mail and does not create or edit calendar events. Selection is not proof of calendar access. Missing or inaccessible free/busy results must not be treated as free. Shared-calendar access requires a separate scope review. This deployment uses one Google Workspace Internal-audience OAuth client for every remote grant, so the account that completes this consent must be inside your own Workspace; a consumer Google account cannot complete it.',
} as const;
