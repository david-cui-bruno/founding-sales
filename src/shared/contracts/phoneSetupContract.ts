import { z } from 'zod';

export const PHONE_SETUP_ERROR = 'PHONE_SETUP_FAILED';
export const phoneFingerprintSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
export const phoneSetupSchema = z.object({
  version: z.literal(1), fingerprint: phoneFingerprintSchema,
  confirmedAt: z.string().datetime({ offset: true }),
}).strict();
export type PhoneSetup = z.infer<typeof phoneSetupSchema>;
export const confirmPhoneSetupSchema = z.object({ expectedFingerprint: phoneFingerprintSchema }).strict();
export type ConfirmPhoneSetup = z.infer<typeof confirmPhoneSetupSchema>;
export type PhoneSetupStatus = Readonly<{
  state: 'unconfigured' | 'unavailable' | 'needs_confirmation' | 'configured';
  candidateFingerprint: string | null;
  confirmedAt: string | null;
}>;
export const phoneSetupStatusSchema = z.object({
  state: z.enum(['unconfigured', 'unavailable', 'needs_confirmation', 'configured']),
  candidateFingerprint: phoneFingerprintSchema.nullable(),
  confirmedAt: z.string().datetime({ offset: true }).nullable(),
}).strict().refine(value => {
  if (value.state === 'configured') return value.candidateFingerprint !== null && value.confirmedAt !== null;
  if (value.state === 'needs_confirmation') return value.candidateFingerprint !== null && value.confirmedAt === null;
  return value.candidateFingerprint === null && value.confirmedAt === null;
}, { message: 'Phone setup state and evidence must agree.' }).transform((value): PhoneSetupStatus => ({
  state: value.state, candidateFingerprint: value.candidateFingerprint, confirmedAt: value.confirmedAt,
}));

/** Configuration is handoff readiness only, never evidence of a connected call. */
export interface PhoneSetupApi {
  status(): Promise<PhoneSetupStatus>;
  confirm(input: ConfirmPhoneSetup): Promise<PhoneSetupStatus>;
  clear(): Promise<PhoneSetupStatus>;
}
