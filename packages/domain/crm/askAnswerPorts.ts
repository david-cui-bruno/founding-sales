import type { RepositoryContext } from "../db/workspaceScope.ts";
import type { AskProviderMetadata } from './askProviderState.ts';
import type {
  AskAgentScope,
  CanonicalSourceReference,
  CrmTokenPriceMicros,
} from "@fss/contracts";

export type AskPaidStage =
  "answer" | "embedding_query" | "embedding_document" | "support";
export interface AskPurposeSnapshot {
  readonly purpose: "answer" | "embedding" | "support";
  readonly agentLimits?: AskAgentLimits;
  readonly embeddingDimensions?: 256 | 512 | 1024;
  readonly revision: number;
  readonly endpointId: string;
  readonly modelVersion: string;
  readonly accessGrantVersion: string;
  readonly dataHandlingVersion: string;
  readonly evaluationFingerprint: string;
  readonly processorVersion: string;
  readonly retrievalVersion: string;
  readonly answerVersion: string;
  readonly supportVersion: string;
  readonly chunkerVersion: string;
  readonly inputTokenPriceMicros: CrmTokenPriceMicros;
  readonly outputTokenPriceMicros: CrmTokenPriceMicros;
  readonly dailyCeilingCents: number;
  readonly monthlyCeilingCents: number;
}
export interface AskAdapterRoute {
  readonly endpointId: string;
  readonly modelVersion: string;
  readonly providerKey: string;
}
export type AskPurposeTarget =
  | {
      readonly kind: "request";
      readonly requestId: string;
      readonly version: number;
      readonly epoch: number;
    }
  | {
      readonly kind: "canonical_index";
      readonly workId: string;
      readonly revision: number;
      readonly windowId: string;
    };
export interface AskPurposeProofInput {
  readonly target: AskPurposeTarget;
  readonly evidenceFingerprint?: string;
  readonly attributionFingerprint?: string;
  readonly agentScope?: AskAgentScope | null;
  readonly route: AskAdapterRoute;
  readonly stage: AskPaidStage;
  readonly purpose: AskPurposeSnapshot;
  readonly configFingerprint: string;
  readonly authorizationFingerprint: string;
  readonly workspaceId: string;
  readonly ownerUserId: string;
  readonly inputScopeFingerprint: string;
  readonly contextFingerprint: string;
  readonly initialAccessFingerprint: string;
}
export interface AskPurposeProof {
  readonly configFingerprint: string;
  readonly authorizationFingerprint: string;
  readonly validUntil: string;
  readonly evaluationKind: "actual" | "controlled_fixture";
}
export interface AskInputWindow {
  readonly id: string;
  readonly ordinal: number;
  readonly source: CanonicalSourceReference;
  readonly text: string;
  readonly textHash: string;
}
export interface AskInputGroup {
  readonly id: string;
  readonly windowIds: readonly string[];
  readonly earliestOrdinal: number;
  readonly score: number;
}
export interface AskAdapterUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}
export interface AskAnswerAdapter {
  readonly endpointId: string;
  readonly modelVersion: string;
  readonly providerKey: string;
  run(input: {
    readonly question: string;
    readonly windows: readonly AskInputWindow[];
    readonly groups: readonly AskInputGroup[];
    readonly maxOutputTokens: number;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly acceptance: "accepted" | "unknown" | "not_accepted";
    readonly usage: AskAdapterUsage | null;
    readonly answer: unknown;
  }>;
}
export interface AskRetrievalAdapter {
  /** This port is local-only; external embeddings are separate paid methods. */
  rank(input: {
    readonly question: string;
    readonly windows: readonly AskInputWindow[];
  }): Promise<readonly AskInputGroup[]>;
}
export interface AskSupportAdapter {
  readonly endpointId: string;
  readonly modelVersion: string;
  readonly providerKey: string;
  run(input: {
    readonly question: string;
    readonly windows: readonly AskInputWindow[];
    readonly claims: unknown;
    readonly maxOutputTokens: number;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly acceptance: "accepted" | "unknown" | "not_accepted";
    readonly usage: AskAdapterUsage | null;
    readonly support: unknown;
  }>;
}
export interface AskAnswerComposition {
  readonly agent?: AskAgentStepAdapter;
  readonly embedding?: AskEmbeddingAdapter;
  readonly agentLimits?: AskAgentLimits;
  readonly embeddingDimensions?: 256 | 512 | 1024;
  readonly retrieval?: AskRetrievalAdapter;
  readonly answer?: AskAnswerAdapter;
  readonly support?: AskSupportAdapter;
  readonly revalidatePurpose?: (
    context: RepositoryContext,
    input: AskPurposeProofInput,
  ) => Promise<boolean>;
  readonly verifyPurpose?: (
    input: AskPurposeProofInput,
  ) => Promise<AskPurposeProof | null>;
  readonly allowControlledEvaluation?: boolean;
  readonly providerTimeoutMs?: number;
}

/** Exactly one externally billed generation; execution owns all subsequent steps. */
export interface AskAgentStepAdapter extends AskAdapterRoute {
  /** Complete conservative text-only SDK input before dispatch, including system,
   * tool schemas and message encoding. Ordinary SDK composition always supplies
   * this; omission preserves only legacy/custom adapter compatibility. */
  inputBound?(input: {
    readonly question: string;
    readonly transcript: readonly unknown[];
    readonly maxOutputTokens: number;
    readonly remainingSteps?: number;
  }): { readonly inputBytes: number; readonly maxInputTokens: number } | null;
  runStep(input: {
    readonly question: string;
    readonly transcript: readonly unknown[];
    readonly maxOutputTokens: number;
    readonly remainingSteps?: number;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly acceptance: "accepted" | "unknown" | "not_accepted";
    readonly usage: AskAdapterUsage | null;
    readonly answer: unknown;
    readonly toolCalls: readonly {
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
      readonly providerMetadata?: AskProviderMetadata;
    }[];
  }>;
}
export interface AskAgentLimits {
  readonly maxSteps: number;
  readonly maxInputBytes: number;
  readonly maxOutputTokens: number;
  readonly deadlineMs: number;
}
/** Embedding purpose and rates are independent of answering authority. */
export interface AskEmbeddingAdapter extends AskAdapterRoute {
  readonly dimensions: 256 | 512 | 1024;
  embed(input: {
    readonly text: string;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly acceptance: "accepted" | "unknown" | "not_accepted";
    readonly usage: AskAdapterUsage | null;
    readonly vector: readonly number[] | null;
  }>;
}
