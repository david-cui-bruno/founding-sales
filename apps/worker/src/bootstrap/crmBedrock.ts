import {createAskTitanAdapter} from '../providers/askTitan.ts';
import {createAskSdkStepAdapter} from '../providers/askAgentSdk.ts';
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
  readonly answerModel?:Parameters<typeof createAskSdkStepAdapter>[0]['model'];
  readonly embedding?:Parameters<typeof createAskTitanAdapter>[0];
  readonly extraction?: Omit<Parameters<typeof createBedrockCrmExtractionAdapter>[0], 'surface'>;
  readonly mailEvidence?: CrmMailEvidencePort;
  readonly answer?: Omit<Parameters<typeof createBedrockAskAnswerAdapter>[0], 'surface'> & {readonly region?:'us-east-1';readonly agentLimits?:NonNullable<AskAnswerComposition['agentLimits']>|undefined};
  readonly verifyPurpose?: NonNullable<AskAnswerComposition['verifyPurpose']>;
  readonly allowControlledEvaluation?: boolean;
  readonly verifyExtraction?: NonNullable<NonNullable<HandlerComposition['crmExtraction']>['verifyPurpose']>;
  readonly revalidateExtraction?: NonNullable<NonNullable<HandlerComposition['crmExtraction']>['revalidatePurpose']>;
  readonly revalidateAskPurpose?: NonNullable<AskAnswerComposition['revalidatePurpose']>;
  readonly providerTimeoutMs?: number;
}): Pick<HandlerComposition, 'crmExtraction' | 'crmAskAnswers' | 'crmAskIndex'> {
  if (options.answer !== undefined && options.verifyPurpose === undefined)
    throw new Error('crm_ask_purpose_verifier_required');
  if (options.embedding !== undefined && options.verifyPurpose === undefined) throw new Error('crm_embedding_purpose_verifier_required');
  return {
    ...(options.embedding === undefined ? {} : {crmAskIndex:{embedding:createAskTitanAdapter(options.embedding),verifyPurpose:options.verifyPurpose!,...(options.revalidateAskPurpose?{revalidatePurpose:options.revalidateAskPurpose}:{}),...(options.allowControlledEvaluation===undefined?{}:{allowControlledEvaluation:options.allowControlledEvaluation}),...(options.providerTimeoutMs===undefined?{}:{providerTimeoutMs:options.providerTimeoutMs})}}),
    ...(options.extraction === undefined ? {} : { crmExtraction: {
      ...(options.verifyExtraction===undefined?{}:{verifyPurpose:options.verifyExtraction}),
      ...(options.revalidateExtraction===undefined?{}:{revalidatePurpose:options.revalidateExtraction}),
      ...(options.allowControlledEvaluation===undefined?{}:{allowControlledEvaluation:options.allowControlledEvaluation}),
      adapter: createBedrockCrmExtractionAdapter({ ...options.extraction, surface: options.surface }),
      ...(options.mailEvidence === undefined ? {} : { mailEvidence: options.mailEvidence }),
      ...(options.providerTimeoutMs === undefined ? {} : { providerTimeoutMs: options.providerTimeoutMs }),
    } }),
    ...(options.answer === undefined ? {} : { crmAskAnswers: {
      ...(options.embedding?{embedding:createAskTitanAdapter(options.embedding)}:{}),
      ...(options.answer.agentLimits?{agent:createAskSdkStepAdapter({...options.answer,...options.answerModel===undefined?{}:{model:options.answerModel},region:options.answer.region??'us-east-1'}),agentLimits:options.answer.agentLimits}:{answer:createBedrockAskAnswerAdapter({ ...options.answer, surface: options.surface })}),
      verifyPurpose: options.verifyPurpose!,
      ...(options.revalidateAskPurpose===undefined?{}:{revalidatePurpose:options.revalidateAskPurpose}),
      ...(options.allowControlledEvaluation === undefined ? {} : { allowControlledEvaluation: options.allowControlledEvaluation }),
      ...(options.providerTimeoutMs === undefined ? {} : { providerTimeoutMs: options.providerTimeoutMs }),
    } }),
  };
}
