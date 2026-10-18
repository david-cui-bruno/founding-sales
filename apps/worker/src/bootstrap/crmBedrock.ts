import type { CrmMailEvidencePort } from '@fss/domain/crm/mailEvidence.ts';
import { createBedrockCrmExtractionAdapter, type CrmBedrockSurface } from '../providers/crmBedrock.ts';
import type { HandlerComposition } from './main.ts';

/** Explicit extraction-only injection. Ask answering and embedding are removed. */
export function composeCrmBedrock(options: {
  readonly surface: CrmBedrockSurface;
  readonly extraction?: Omit<Parameters<typeof createBedrockCrmExtractionAdapter>[0], 'surface'>;
  readonly mailEvidence?: CrmMailEvidencePort;
  readonly allowControlledEvaluation?: boolean;
  readonly verifyExtraction?: NonNullable<NonNullable<HandlerComposition['crmExtraction']>['verifyPurpose']>;
  readonly revalidateExtraction?: NonNullable<NonNullable<HandlerComposition['crmExtraction']>['revalidatePurpose']>;
  readonly providerTimeoutMs?: number;
}): Pick<HandlerComposition, 'crmExtraction'> {
  return {
    ...(options.extraction === undefined ? {} : { crmExtraction: {
      ...(options.verifyExtraction === undefined ? {} : { verifyPurpose: options.verifyExtraction }),
      ...(options.revalidateExtraction === undefined ? {} : { revalidatePurpose: options.revalidateExtraction }),
      ...(options.allowControlledEvaluation === undefined ? {} : { allowControlledEvaluation: options.allowControlledEvaluation }),
      adapter: createBedrockCrmExtractionAdapter({ ...options.extraction, surface: options.surface }),
      ...(options.mailEvidence === undefined ? {} : { mailEvidence: options.mailEvidence }),
      ...(options.providerTimeoutMs === undefined ? {} : { providerTimeoutMs: options.providerTimeoutMs }),
    } }),
  };
}
