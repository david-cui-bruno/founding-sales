import { isDeepStrictEqual } from 'node:util';
import type { CompanyResearchProfile, LocalKnownCompanyConfiguration } from '../../shared/contracts/localCompanyResearchSettingsContract';
import { companySourcePolicy } from './companySourcePolicy';
/** Reviewed public rates, 2026-09-15. Not a provider probe or invoice guarantee. */
const profile: CompanyResearchProfile = {
  id: 'known-company-gpt-4.1-mini-2025-04-14-v1', label: 'GPT-4.1 mini · bounded company page extraction',
  reviewedAt: '2026-09-15', referenceUrl: 'https://developers.openai.com/api/docs/models/gpt-4.1-mini.md',
  researchLimits: { maxCompanies: 1, maxPages: 1, maxBytes: 250000, maxCostMicros: 20000,
    knownCompanyExtraction: { version: 1, model: 'gpt-4.1-mini-2025-04-14', maxInputBytes: 20000, maxOutputTokens: 2048, maxCostMicros: 20000, inputMicrosPerMillionTokens: 400000, outputMicrosPerMillionTokens: 1600000 } },
};
export function getCompanyResearchProfiles(): CompanyResearchProfile[] { return [structuredClone(profile)]; }
export function validateKnownCompanyActivation(configuration: LocalKnownCompanyConfiguration): void {
  if (configuration.profileId !== profile.id || !isDeepStrictEqual(configuration.researchLimits, profile.researchLimits)) throw new Error('Research request profile mismatch');
  if (configuration.permittedSources.some(url => companySourcePolicy(url) !== 'candidate')) throw new Error('Research source configuration invalid');
  if (configuration.maxAccountBudgetMicros < configuration.researchLimits.maxCostMicros) throw new Error('Research cumulative ceiling below attempt reservation');
}
