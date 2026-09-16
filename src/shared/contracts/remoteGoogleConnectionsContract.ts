import { z } from 'zod';
import { googleGrantPurposeSchema, type GoogleGrantPurpose } from './googleGrantCapabilities';
import { remoteGoogleGrantBeginSchema, remoteGoogleGrantDisclosureSchema, remoteGoogleGrantStatusSchema } from './remoteGoogleGrantContract';

export const googleConnectionSelectorSchema = z.strictObject({ purpose: googleGrantPurposeSchema });
export const googleConsentOpenedSchema = z.strictObject({ state: z.literal('consent_opened'), purpose: googleGrantPurposeSchema });
export type GoogleConnectionSelector = z.infer<typeof googleConnectionSelectorSchema>;
export type GoogleConsentOpened = z.infer<typeof googleConsentOpenedSchema>;
/** Main owns URL validation and browser opening. No URL, token or callback code crosses this API. */
export interface RemoteGoogleConnectionsApi {
  status(input: GoogleConnectionSelector): Promise<z.infer<typeof remoteGoogleGrantStatusSchema>>;
  disclosure(input: GoogleConnectionSelector): Promise<z.infer<typeof remoteGoogleGrantDisclosureSchema>>;
  begin(input: z.infer<typeof remoteGoogleGrantBeginSchema>): Promise<GoogleConsentOpened>;
  revoke(input: GoogleConnectionSelector): Promise<z.infer<typeof remoteGoogleGrantStatusSchema>>;
}
export const selectedGooglePurpose = (purpose?: GoogleGrantPurpose): GoogleGrantPurpose => purpose ?? 'permitted_correspondence';
/** The only status-read failure reasons the desktop surfaces, the worker's own codes from a small non-OK
 * `{ error }` body: `google_unconfigured`, which a handler built without a Google client answers (this worker
 * deployment has no Google client at all; mail and calendar stay gated), and `worker_scope_denied`, which the
 * worker answers when this pairing was issued without the google:grant scope (this app cannot read grants).
 * Neither is a grant state or a transient failure. Anything else stays the generic code and no body text is
 * ever shown. The reason travels as the rejection message, which is all the context bridge preserves of an Error. */
export const GOOGLE_CONNECTION_STATUS_MAX_ERROR_BYTES = 512;
export const googleConnectionStatusReasonSchema = z.enum(['google_unconfigured', 'worker_scope_denied']);
export type GoogleConnectionStatusReason = z.infer<typeof googleConnectionStatusReasonSchema>;
export const googleConnectionStatusErrorBodySchema = z.object({ error: googleConnectionStatusReasonSchema });
export class GoogleConnectionStatusFailure extends Error {
  constructor(readonly reason: GoogleConnectionStatusReason) { super(reason); this.name = 'GoogleConnectionStatusFailure'; }
}
export function googleConnectionStatusReason(error: unknown): GoogleConnectionStatusReason | null {
  if (!(error instanceof Error)) return null;
  const parsed = googleConnectionStatusReasonSchema.safeParse(error.message);
  return parsed.success ? parsed.data : null;
}
/** Bridge reply for one status read: the grant status as read, or exactly one allowlisted reason. */
export const googleConnectionStatusUnavailableSchema = z.strictObject({ unavailable: googleConnectionStatusReasonSchema });
export const googleConnectionStatusResultSchema = z.union([remoteGoogleGrantStatusSchema, googleConnectionStatusUnavailableSchema]);
