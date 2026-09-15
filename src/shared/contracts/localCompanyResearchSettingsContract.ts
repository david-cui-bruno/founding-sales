import { z } from 'zod';
import { researchLimitsSchema } from '../../main/research/companyResearchTypes';
const counter = z.number().int().nonnegative().safe();
export const localKnownCompanyConfigurationSchema = z.strictObject({
  version: z.literal(1), mode: z.literal('known_company'), state: z.enum(['active', 'paused']),
  profileId: z.string().min(1).max(200),
  researchLimits: researchLimitsSchema.refine(value => value.maxCompanies === 1 && !!value.knownCompanyExtraction, 'Known-company extraction required'),
  maxAccountBudgetMicros: counter.positive(), permittedSources: z.array(z.string().url().max(2048)).min(1).max(500),
});
export type LocalKnownCompanyConfiguration = z.infer<typeof localKnownCompanyConfigurationSchema>;
export const companyResearchProfileSchema = z.strictObject({ id: z.string().min(1), label: z.string().min(1), reviewedAt: z.string().min(1), referenceUrl: z.string().url(), researchLimits: researchLimitsSchema });
export type CompanyResearchProfile = z.infer<typeof companyResearchProfileSchema>;
export const companyResearchSettingsSchema = z.strictObject({ revision: counter, configuration: localKnownCompanyConfigurationSchema.nullable(), profiles: z.array(companyResearchProfileSchema), blockedReason: z.literal('paired_research_present').nullable(), reservedOrSpentMicros: counter });
export type CompanyResearchSettings = z.infer<typeof companyResearchSettingsSchema>;
export const updateCompanyResearchSettingsRequestSchema = z.strictObject({ expectedRevision: counter, configuration: localKnownCompanyConfigurationSchema, reviewed: z.boolean() });
export type UpdateCompanyResearchSettingsRequest = z.infer<typeof updateCompanyResearchSettingsRequestSchema>;
export const companyResearchSettingsUpdateReplySchema = (input: UpdateCompanyResearchSettingsRequest) => companyResearchSettingsSchema.refine(result => input.expectedRevision < Number.MAX_SAFE_INTEGER && result.revision === input.expectedRevision + 1 && JSON.stringify(result.configuration) === JSON.stringify(localKnownCompanyConfigurationSchema.parse(input.configuration)), 'Company research settings update mismatch');
