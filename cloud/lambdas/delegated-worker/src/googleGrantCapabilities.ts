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
export const googleGrantSchema = z.strictObject({ provider: z.literal('google'), subject: z.string().min(1).max(255),
  email: z.string().email().max(254), grantedScopes: z.array(z.string().min(1).max(500)).min(1).max(20),
  owner: z.enum(['local', 'remote']), purpose: z.literal('permitted_correspondence'), capabilities: z.array(googleCapabilitySchema).max(4), calendars: googleCalendarSelectionSchema.optional(),
}).refine(grant => new Set(grant.capabilities).size === grant.capabilities.length
  && grant.capabilities.every(capability => grant.grantedScopes.includes(googleScopes[capability])), 'grant_missing_capability');
export type GoogleGrant = z.infer<typeof googleGrantSchema>;
export function capabilitiesForScopes(scopes: readonly string[]): GoogleCapability[] {
  return googleCapabilitySchema.options.filter(capability => scopes.includes(googleScopes[capability]));
}
export function requireCapabilities(grant: GoogleGrant | undefined, required: GoogleCapability[]): void {
  const parsed = googleGrantSchema.safeParse(grant);
  if (!parsed.success || required.some(capability => !parsed.data.capabilities.includes(capability)
    || !parsed.data.grantedScopes.includes(googleScopes[capability]))) throw new Error('grant_missing_capability');
}
export const googleGrantDisclosure = {
  version: 'google-grant-v1',
  text: 'Gmail read is a restricted scope. This app processes only relevant approved correspondence, not whole-mailbox training. Before activation, review the selected model provider, exactly what message data may transfer, and that provider’s retention settings. Google Testing refresh tokens may expire after seven days. Verification requirements depend on the actual deployment and are not presumed exempt. Calendar free/busy applies only to the confirmed owned/conflict calendars supported by this scope. Shared-calendar access requires a separate explicit scope review. OAuth grants do not authorize unsolicited email.',
} as const;
