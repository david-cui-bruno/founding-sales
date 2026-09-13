import { z } from 'zod';
import {
  googleAvailabilityCalendarSelectionSchema, googleCalendarSelectionSchema, googleCapabilitySchema,
  googleGrantDisclosure, googleGrantPurposeSchema, googleGrantSchema, personalGoogleGrantDisclosure,
} from './googleGrantCapabilities';

const legacyBegin = z.strictObject({
  purpose: z.literal('permitted_correspondence').optional(),
  capabilities: z.array(googleCapabilitySchema).min(1).max(4),
  disclosureVersion: z.literal(googleGrantDisclosure.version),
  calendars: googleCalendarSelectionSchema.optional(),
  expectedEmail: z.string().email().max(254).refine(value => value === value.toLowerCase()).optional(),
}).refine(value => new Set(value.capabilities).size === value.capabilities.length, 'duplicate_capability');
const personalBegin = z.strictObject({
  purpose: z.literal('personal_availability'),
  capabilities: z.array(z.literal('availability')).length(1),
  disclosureVersion: z.literal(personalGoogleGrantDisclosure.version),
  availabilityCalendars: googleAvailabilityCalendarSelectionSchema,
});
/** Remote grant requests are distinct from local desktop Gmail credentials. */
export const remoteGoogleGrantBeginSchema = z.union([legacyBegin, personalBegin]);
export type RemoteGoogleGrantBegin = z.infer<typeof remoteGoogleGrantBeginSchema>;
export const remoteGoogleGrantSelectorSchema = z.strictObject({ purpose: googleGrantPurposeSchema.optional() });
export const remoteGoogleGrantStatusSchema = z.strictObject({
  state: z.enum(['unconfigured', 'ready', 'revoked']),
  grant: googleGrantSchema.nullable(),
  providerRevocation: z.enum(['confirmed', 'pending']).optional(),
}).refine(value => (value.state !== 'ready' || value.grant !== null) &&
  (value.state !== 'unconfigured' || value.grant === null) &&
  (!value.grant || value.grant.owner === 'remote') &&
  (!value.providerRevocation || value.state === 'revoked'), 'invalid_remote_grant_state');
export type RemoteGoogleGrantStatus = z.infer<typeof remoteGoogleGrantStatusSchema>;
export const remoteGoogleGrantAuthorizationSchema = z.strictObject({ authorizationUrl: z.string().url().max(8192) });
export const remoteGoogleGrantDisclosureSchema = z.union([
  z.strictObject({ version: z.literal(googleGrantDisclosure.version), text: z.literal(googleGrantDisclosure.text) }),
  z.strictObject({ version: z.literal(personalGoogleGrantDisclosure.version), text: z.literal(personalGoogleGrantDisclosure.text) }),
]);
