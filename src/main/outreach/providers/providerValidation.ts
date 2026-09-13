/* eslint-disable no-control-regex -- These schemas intentionally reject NUL in secrets and content. */
import { z } from 'zod';
import { legacyGoogleGrantSchema as googleGrantSchema } from '../../../shared/contracts/googleGrantCapabilities';

export type ProviderErrorCode =
  | 'credentials_locked' | 'credentials_corrupt' | 'credentials_unavailable'
  | 'invalid_configuration' | 'model_unconfigured' | 'gmail_unconfigured' | 'gmail_reauthorize'
  | 'provider_invalidated' | 'provider_rejected' | 'provider_response_invalid' | 'network_uncertain'
  | 'invalid_draft_context' | 'ungrounded_output' | 'oauth_cancelled' | 'oauth_timeout'
  | 'oauth_browser_failed' | 'oauth_unavailable' | 'oauth_denied' | 'oauth_identity_invalid';

/** Deliberately no cause, payload, token, URL or exception interpolation. */
export class ProviderError extends Error {
  constructor(readonly code: ProviderErrorCode) { super(code); this.name = 'OutreachProviderError'; }
}
export function fail(code: ProviderErrorCode): never { throw new ProviderError(code); }
export const safeError = (error: unknown, fallback: ProviderErrorCode): ProviderError =>
  error instanceof ProviderError ? error : new ProviderError(fallback);
export const secretSchema = z.string().max(16384).regex(/^[^\r\n\u0000]*$/);
export const mailboxSchema = z.string().max(254).email().regex(/^[\x21-\x7e]+$/);
export const modelCredentialsSchema = z.object({ apiKey: secretSchema, model: z.string().max(200).regex(/^[a-zA-Z0-9._:/-]*$/) }).strict();
export const gmailCredentialsSchema = z.object({
  clientId: secretSchema, clientSecret: secretSchema, refreshToken: secretSchema, accessToken: secretSchema,
  expiresAt: z.number().finite().nonnegative(), email: z.union([z.literal(''), mailboxSchema]),
  grant: googleGrantSchema.refine(grant => grant.owner === 'local').optional(),
}).strict().refine(value => !value.grant || value.grant.email === value.email);
export const storedCredentialsSchema = z.object({
  model: modelCredentialsSchema, gmail: gmailCredentialsSchema,
  senderName: z.string().max(240).regex(/^[^\r\n\u0000]*$/), postalAddress: z.string().max(2000).regex(/^[^\u0000]*$/),
}).strict();
