import type { AskAnswerComposition } from '@fss/domain/crm/askAnswerPorts.ts';
import type { CrmMailEvidencePort } from '@fss/domain/crm/mailEvidence.ts';
import { createBedrockAskAnswerAdapter, createBedrockCrmExtractionAdapter, type CrmBedrockSurface } from '../providers/crmBedrock.ts';
import type { HandlerComposition } from './main.ts';

/** Explicit purpose-specific injection; never reuse classifier grants or enable controls.
 * Actual verifier, policy, funding and evaluation receipts belong to the operator's
 * approved configuration. Absent bindings leave the normal worker unavailable.
 */
export function composeCrmBedrock(options: {
  readonly surface: CrmBedrockSurface;
  readonly extraction?: Omit<Parameters<typeof createBedrockCrmExtractionAdapter>[0], 'surface'>;
  readonly mailEvidence?: CrmMailEvidencePort;
  readonly answer?: Omit<Parameters<typeof createBedrockAskAnswerAdapter>[0], 'surface'>;
  readonly verifyPurpose?: NonNullable<AskAnswerComposition['verifyPurpose']>;
  readonly allowControlledEvaluation?: boolean;
  readonly providerTimeoutMs?: number;
}): Pick<HandlerComposition, 'crmExtraction' | 'crmAskAnswers'> {
  if (options.answer !== undefined && options.verifyPurpose === undefined)
    throw new Error('crm_ask_purpose_verifier_required');
  return {
    ...(options.extraction === undefined ? {} : { crmExtraction: {
      adapter: createBedrockCrmExtractionAdapter({ ...options.extraction, surface: options.surface }),
      ...(options.mailEvidence === undefined ? {} : { mailEvidence: options.mailEvidence }),
      ...(options.providerTimeoutMs === undefined ? {} : { providerTimeoutMs: options.providerTimeoutMs }),
    } }),
    ...(options.answer === undefined ? {} : { crmAskAnswers: {
      answer: createBedrockAskAnswerAdapter({ ...options.answer, surface: options.surface }),
      verifyPurpose: options.verifyPurpose!,
      ...(options.allowControlledEvaluation === undefined ? {} : { allowControlledEvaluation: options.allowControlledEvaluation }),
      ...(options.providerTimeoutMs === undefined ? {} : { providerTimeoutMs: options.providerTimeoutMs }),
    } }),
  };
}
