import { z } from 'zod';
import { discoveryInputFingerprint, type CompanyPreparationConfiguration } from './companyResearchWorker';
import { companySourcePolicy } from './companySourcePolicy';

export type CompanyResearchStartupConfiguration = CompanyPreparationConfiguration & {
  maxAccountBudgetMicros: number;
  /** Explicit permitted public URLs, never a model-provided boolean. */
  permittedSources: readonly string[];
};

/** Pure construction checks shared by startup and active local configuration saves.
 * This neither approves spending nor probes provider readiness. Empty sources retain
 * their existing execution hold. Paused/null records are not activation requests. */
export function validateCompanyResearchConfiguration(config: CompanyResearchStartupConfiguration): void {
  discoveryInputFingerprint(config);
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(config.maxAccountBudgetMicros);
  const permitted = z.array(z.string().url().max(2048)).max(500).parse(config.permittedSources);
  if (permitted.some(url => companySourcePolicy(url) !== 'candidate')) throw new Error('Research source configuration invalid');
}
