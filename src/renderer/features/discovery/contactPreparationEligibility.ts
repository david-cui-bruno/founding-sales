import type { DiscoveryBrief } from '../../../shared/contracts/discoveryContract';

/** Presentation admission only. Begin and the enrichment writer recheck authority. */
export function supportsContactPreparation(brief: DiscoveryBrief): boolean {
  const assessment = brief.assessment;
  const override = brief.latestOverride;
  return !brief.stale && assessment !== null && assessment.disposition === 'candidate'
    && assessment.identitySupported && (assessment.axes.fit?.band === 'medium' || assessment.axes.fit?.band === 'high')
    && (override === null || override.evidenceChanged || override.decision === 'reconsider');
}
