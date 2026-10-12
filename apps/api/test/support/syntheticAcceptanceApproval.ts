import {createHash} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {z} from 'zod';
import type {AskAnswerRequest,AskAgentScope} from '@fss/contracts';
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const legacyModel='us.anthropic.claude-haiku-4-5-20251001-v1:0';
export const SYNTHETIC_ACCEPTANCE_MODELS=[legacyModel,'us.anthropic.claude-sonnet-5-5','us.anthropic.claude-haiku-5-5','us.anthropic.claude-sonnet-4-6'] as const;
const sha=z.string().regex(/^[a-f0-9]{64}$/u);
const scopeSchema=z.object({captureNative:z.literal(true).optional(),scopeVersion:z.union([z.literal(2),z.literal(3)]).optional(),maxRequestInputBytes:z.literal(30000).optional(),maxNativeOutputTokens:z.literal(4096).optional(),maxProbeOutputTokens:z.literal(32).optional(),runId:z.uuid(),modelVersion:z.enum(SYNTHETIC_ACCEPTANCE_MODELS),labelsSha256:sha,extractionIds:z.array(z.string()),askIds:z.array(z.string()),maxSteps:z.number().int().min(1).max(50),maxCents:z.number().int().min(1).max(1000),maxAskSteps:z.number().int().min(1).max(6),maxAskInputBytes:z.number().int().min(1).max(30000),maxAskOutputTokens:z.number().int().min(1).max(4096),askQuestions:z.record(z.string(),z.string().min(1)),sourceSha256:z.record(z.string(),sha),stage:z.enum(['gold_context','history_investigation']).optional(),thinking:z.literal('disabled').optional(),pricing:z.strictObject({inputTokenPriceMicros:z.number().finite().positive().max(1000),outputTokenPriceMicros:z.number().finite().nonnegative().max(1000),basis:z.literal('conservative_upper_bound_not_invoice')}).optional()}).passthrough();
const approvalSchema=z.object({approved:z.literal(true),approvedBy:z.literal('David Cui'),scopeSha256:sha,humanLabelsReviewed:z.literal(true),reference:z.string().min(1).max(200)});
export const SYNTHETIC_ACCEPTANCE_CRITICAL_SOURCES=['apps/api/test/syntheticActualAcceptance.test.ts','apps/api/test/support/syntheticAcceptanceApproval.ts','apps/worker/test/support/syntheticPaidBudget.ts','apps/worker/test/support/boundedActualBedrock.ts','apps/worker/src/providers/askAgentSdk.ts','apps/worker/src/providers/askModelEvidence.ts','tools/ask-evaluation/diagnostics/capture-converse.ts','apps/worker/src/providers/crmBedrock.ts','apps/worker/src/handlers/askAnswer.ts','apps/worker/src/handlers/crmExtract.ts','packages/domain/crm/capabilityStartup.ts'];
/** Paid-runner approval seam: pure validation before credentials, marker, or calls.
 * Version1 receipts remain exactly their former 25/$1 Haiku scope. Version2 binds
 * one model and investigation stage, rather than silently extending old funding.
 * The individual $10 source ceiling is not campaign funding or spending authority. */
export function validateSyntheticAcceptance(input:{scopeBytes:Buffer;approvalBytes:Buffer;labelsBytes:Buffer;readSource:(path:string)=>Buffer}){
 const scope=scopeSchema.parse(JSON.parse(input.scopeBytes.toString()));const approval=approvalSchema.parse(JSON.parse(input.approvalBytes.toString()));
 if(approval.scopeSha256!==hash(input.scopeBytes))throw new Error('exact_paid_scope_approval_required');
 if(scope.labelsSha256!==hash(input.labelsBytes))throw new Error('frozen_scope_changed');
 if(!scope.scopeVersion){if(scope.maxSteps!==25||scope.maxCents!==100||scope.modelVersion!==legacyModel||scope.stage!==undefined||scope.pricing!==undefined||scope.thinking!==undefined)throw new Error('frozen_scope_changed');}
 else {
  const floor=(scope.modelVersion==='us.anthropic.claude-sonnet-5-5'||scope.modelVersion==='us.anthropic.claude-sonnet-4-6')?{input:3.3,output:16.5}:{input:1.1,output:5.5};
  if(!scope.pricing||scope.pricing.inputTokenPriceMicros<floor.input||scope.pricing.outputTokenPriceMicros<floor.output)throw new Error('synthetic_price_ceiling_too_low');
  if(!scope.stage||scope.thinking!=='disabled'||!scope.pricing||scope.maxRequestInputBytes!==30000||scope.maxNativeOutputTokens!==4096||scope.maxProbeOutputTokens!==32||scope.maxAskSteps!==(scope.stage==='gold_context'?2:6)||scope.maxAskOutputTokens>1000||scope.maxSteps<1+scope.extractionIds.length+scope.askIds.length*scope.maxAskSteps)throw new Error('frozen_scope_changed');
  if(JSON.stringify(scope.extractionIds)!==JSON.stringify(scope.scopeVersion===3?[]:['dev_01','dev_02','dev_05','dev_08'])||JSON.stringify(scope.askIds)!==JSON.stringify(['dev_01','dev_05','dev_06','dev_08','dev_10','dev_11']))throw new Error('frozen_cases_changed');
  if(SYNTHETIC_ACCEPTANCE_CRITICAL_SOURCES.some(path=>!scope.sourceSha256[path]))throw new Error('approved_runner_changed');
 }
 if(scope.captureNative&&scope.scopeVersion!==3)throw new Error('capture_scope_mismatch');
 const labels=z.object({cases:z.array(z.object({caseId:z.string(),syntheticText:z.string().min(1),expectedOutcome:z.string().min(1),forbiddenOutcome:z.string().min(1),eventAt:z.string()}))}).parse(JSON.parse(input.labelsBytes.toString()));
 if([...scope.extractionIds,...scope.askIds].some(id=>!labels.cases.some(item=>item.caseId===id)))throw new Error('frozen_case_missing');
 for(const id of scope.askIds)if(!scope.askQuestions[id])throw new Error('frozen_case_missing');
 for(const [path,fingerprint] of Object.entries(scope.sourceSha256)){if(path.startsWith('/')||path.split('/').includes('..')||hash(input.readSource(path))!==fingerprint)throw new Error('approved_runner_changed');}
 return {scope,approval,scopeSha256:hash(input.scopeBytes),pricing:scope.pricing??{inputTokenPriceMicros:1.1,outputTokenPriceMicros:5.5,basis:'conservative_upper_bound_not_invoice' as const}};
}
/** Exclusive marker survives failures; never turns a consumed run into new money. */
export function claimSyntheticAcceptanceDirectory(repository:string,runId:string){
 z.uuid().parse(runId);const directory=resolve(repository,'.context',`synthetic-acceptance-${runId}`);mkdirSync(directory,{mode:0o700});return directory;
}

/** Stage scope is the actual public Ask contract. A firm scope resolves an empty
 * initial corpus, so known-gold evidence must use the selected-source intent. */
export function syntheticAskStageScope(stage:'gold_context'|'history_investigation'|undefined,firmId:string,source:AskAnswerRequest['scope']['sources'][number]):{agentScope:AskAgentScope;scope:AskAnswerRequest['scope']}{
 return stage==='gold_context'?{agentScope:{kind:'selected',sources:[source]},scope:{sources:[source]}}:{agentScope:{kind:'firm',firmId},scope:{sources:[]}};
}
