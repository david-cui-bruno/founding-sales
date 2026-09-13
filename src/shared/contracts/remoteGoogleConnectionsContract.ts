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
