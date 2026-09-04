import { z } from 'zod';

export const federalContactStatusSchema = z.enum([
  'unknown', 'verified_clear', 'listed',
]);
export const contactComplianceSourceSchema = z.enum([
  'ftc_download', 'enrichment_vendor', 'manual_import', 'legacy',
]);

const utcTimestampSchema = z.string().datetime({ offset: true }).refine(
  (value) => new Date(value).toISOString() === value,
  'Timestamp must use canonical UTC ISO format.',
);

export const contactComplianceEvidenceSchema = z.object({
  federalStatus: federalContactStatusSchema.default('unknown'),
  tcpaFlag: z.boolean().nullable().default(null),
  coveredAreaCode: z.string().regex(/^\d{3}$/).nullable().default(null),
  source: contactComplianceSourceSchema.default('legacy'),
  scrubbedAt: utcTimestampSchema.nullable().default(null),
  expiresAt: utcTimestampSchema.nullable().default(null),
}).strict().superRefine((evidence, context) => {
  if (evidence.source === 'enrichment_vendor' && evidence.federalStatus === 'verified_clear') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Vendor false results map to unknown, not verified_clear.',
      path: ['federalStatus'],
    });
  }
  if (evidence.federalStatus === 'verified_clear' && (
    evidence.coveredAreaCode === null
    || evidence.scrubbedAt === null
    || evidence.expiresAt === null
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Verified clear evidence requires area-code coverage, scrub time, and expiration.',
      path: ['federalStatus'],
    });
  }
  if (evidence.scrubbedAt === null || evidence.expiresAt === null) return;
  const maximumExpiry = new Date(evidence.scrubbedAt).getTime() + 31 * 24 * 60 * 60 * 1000;
  if (new Date(evidence.expiresAt).getTime() > maximumExpiry) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Compliance evidence expiration cannot exceed 31 days after scrub timestamp.',
      path: ['expiresAt'],
    });
  }
});

export type ContactComplianceEvidence = Readonly<{
  federalStatus: 'unknown' | 'verified_clear' | 'listed';
  tcpaFlag: boolean | null;
  coveredAreaCode: string | null;
  source: 'ftc_download' | 'enrichment_vendor' | 'manual_import' | 'legacy';
  scrubbedAt: string | null;
  expiresAt: string | null;
}>;
