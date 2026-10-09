import type {CanonicalSourceReference} from '@fss/contracts';

export type AskPaidStage='answer'|'embedding_query'|'embedding_document'|'support';
export interface AskPurposeSnapshot {
 readonly purpose:'answer'|'embedding'|'support';
 readonly revision:number;
 readonly endpointId:string;
 readonly modelVersion:string;
 readonly accessGrantVersion:string;
 readonly dataHandlingVersion:string;
 readonly evaluationFingerprint:string;
 readonly processorVersion:string;
 readonly retrievalVersion:string;
 readonly answerVersion:string;
 readonly supportVersion:string;
 readonly chunkerVersion:string;
 readonly inputTokenPriceMicros:number;
 readonly outputTokenPriceMicros:number;
 readonly dailyCeilingCents:number;
 readonly monthlyCeilingCents:number;
}
export interface AskAdapterRoute {readonly endpointId:string;readonly modelVersion:string;readonly providerKey:string}
export interface AskPurposeProofInput {
 readonly route:AskAdapterRoute;
 readonly stage:AskPaidStage;
 readonly purpose:AskPurposeSnapshot;
 readonly configFingerprint:string;
 readonly authorizationFingerprint:string;
 readonly workspaceId:string;
 readonly ownerUserId:string;
 readonly inputScopeFingerprint:string;
 readonly contextFingerprint:string;
 readonly initialAccessFingerprint:string;
}
export interface AskPurposeProof {readonly configFingerprint:string;readonly authorizationFingerprint:string;readonly validUntil:string;readonly evaluationKind:'actual'|'controlled_fixture'}
export interface AskInputWindow {readonly id:string;readonly ordinal:number;readonly source:CanonicalSourceReference;readonly text:string;readonly textHash:string}
export interface AskInputGroup {readonly id:string;readonly windowIds:readonly string[];readonly earliestOrdinal:number;readonly score:number}
export interface AskAdapterUsage {readonly inputTokens:number;readonly outputTokens:number}
export interface AskAnswerAdapter {
 readonly endpointId:string;readonly modelVersion:string;readonly providerKey:string;
 run(input:{readonly question:string;readonly windows:readonly AskInputWindow[];readonly groups:readonly AskInputGroup[];readonly maxOutputTokens:number;readonly signal:AbortSignal}):Promise<{readonly acceptance:'accepted'|'unknown'|'not_accepted';readonly usage:AskAdapterUsage|null;readonly answer:unknown}>;
}
export interface AskRetrievalAdapter {
 /** This port is local-only; external embeddings are separate paid methods. */
 rank(input:{readonly question:string;readonly windows:readonly AskInputWindow[]}):Promise<readonly AskInputGroup[]>;
}
export interface AskSupportAdapter {
 readonly endpointId:string;readonly modelVersion:string;readonly providerKey:string;
 run(input:{readonly question:string;readonly windows:readonly AskInputWindow[];readonly claims:unknown;readonly maxOutputTokens:number;readonly signal:AbortSignal}):Promise<{readonly acceptance:'accepted'|'unknown'|'not_accepted';readonly usage:AskAdapterUsage|null;readonly support:unknown}>;
}
export interface AskAnswerComposition {
 readonly retrieval?:AskRetrievalAdapter;
 readonly answer?:AskAnswerAdapter;
 readonly support?:AskSupportAdapter;
 readonly verifyPurpose?:(input:AskPurposeProofInput)=>Promise<AskPurposeProof|null>;
 readonly allowControlledEvaluation?:boolean;
 readonly providerTimeoutMs?:number;
}
