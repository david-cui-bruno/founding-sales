/**
 * Which transport carries Callie's Claude calls, and the one table that maps a Claude
 * model id to its Amazon Bedrock inference profile (slice BR1).
 *
 * Two transports, one request shape. The reply classifier, the after-call summary and
 * research's extraction all build a Messages API request (`ClassifierRequest`) and hand it
 * to an `AnthropicMessagesTransport`; this file decides which one a worker builds:
 *
 *   * `FSS_MODEL_TRANSPORT=bedrock` — Amazon Bedrock `InvokeModel`, with the worker task
 *     role as the credential (`bedrockClient.ts`). Paid from the AWS account's credits.
 *     Production sets it (`infra/modules/stack`).
 *   * `FSS_MODEL_TRANSPORT=anthropic`, or unset — the direct Anthropic API with the
 *     classifier key (`anthropicClient.ts`). Paid in cash.
 *
 * Anything else is a configuration problem named by the variable, and the worker builds no
 * transport at all. **There is no automatic fallback from one to the other**: a Bedrock
 * failure is the paid-call pattern's ordinary failure (refused, or ambiguous and estimated),
 * never a second request to the direct API, which would be cash the ceiling did not plan.
 *
 * ## Who pays, in the ledger
 *
 * A call's `provider_key` names its transport, so `settings/funding.ts` can tell credits
 * from cash by the key alone: the direct API keeps the keys it always had
 * (`anthropic_classifier`, `anthropic_call_summary`, `anthropic_extraction`, cash) and a
 * Bedrock call is `aws_bedrock.<purpose>` (credits, like `aws_transcribe.standard`). The key
 * is chosen when the reservation is made and is the reservation's for life: a later chunk
 * compares it with its own transport and never calls one transport against money reserved
 * for the other.
 */

export const MODEL_TRANSPORTS = ['anthropic', 'bedrock'] as const;
export type ModelTransportKind = (typeof MODEL_TRANSPORTS)[number];

export const MODEL_TRANSPORT_VARIABLE = 'FSS_MODEL_TRANSPORT';

/** The deployment's transport, or the variable's name when its value is not one. */
export function readModelTransport(
  environment: Readonly<Record<string, string | undefined>>,
): { readonly kind: ModelTransportKind; readonly problem: null } | { readonly kind: null; readonly problem: string } {
  const chosen = (environment[MODEL_TRANSPORT_VARIABLE] ?? '').trim();
  if (chosen === '' || chosen === 'anthropic') return { kind: 'anthropic', problem: null };
  if (chosen === 'bedrock') return { kind: 'bedrock', problem: null };
  return { kind: null, problem: MODEL_TRANSPORT_VARIABLE };
}

// ---------------------------------------------------------------------------
// Provider keys
// ---------------------------------------------------------------------------

/** What a model call is for. One `provider_key` per purpose and transport. */
export type ModelCallPurpose = 'classifier' | 'call_summary' | 'extraction';

/** The `provider_key` kind every Bedrock model call is filed under. Credit-funded. */
export const BEDROCK_PROVIDER_KIND = 'aws_bedrock';

/**
 * The `provider_key` a reservation and its ledger row carry.
 *
 * The direct API's keys are the ones the ledger has always held, unchanged, so a month that
 * spans the switch reads as one history.
 */
export function modelProviderKey(purpose: ModelCallPurpose, transport: ModelTransportKind): string {
  return transport === 'bedrock' ? `${BEDROCK_PROVIDER_KIND}.${purpose}` : `anthropic_${purpose}`;
}

/** Which transport a reservation's `provider_key` was priced for. */
export function transportOfProviderKey(providerKey: string): ModelTransportKind {
  return providerKey.startsWith(`${BEDROCK_PROVIDER_KIND}.`) ? 'bedrock' : 'anthropic';
}

// ---------------------------------------------------------------------------
// The model table
// ---------------------------------------------------------------------------

export interface BedrockModel {
  /**
   * The `us.anthropic.*` system-defined cross-region inference profile the request is sent
   * to (`InvokeModel`'s `modelId`). It routes to the foundation model in us-east-1,
   * us-east-2 or us-west-2 (`aws bedrock list-inference-profiles`, read 1 October 2026).
   */
  readonly inferenceProfileId: string;
  /** The foundation model the profile routes to. `CountTokens` takes this, not the profile. */
  readonly foundationModelId: string;
  /**
   * Whether Bedrock's `CountTokens` answers for this model. Measured on 1 October 2026:
   * Claude Haiku 4.5 does; Claude Opus 5 and Claude Sonnet 5.5 answer "The provided model
   * doesn't support counting tokens". Where it is false the transport answers the request's
   * UTF-8 byte length instead — an upper bound, so a reservation admitted on it still holds.
   */
  readonly countTokens: boolean;
  /**
   * Bedrock's on-demand price in cents per million tokens for a **regional** (geo, `us.*`)
   * cross-region profile, from the AWS Price List API (`pricing get-products`, service code
   * `AmazonBedrockFoundationModels`, region us-east-1, read 1 October 2026, effective
   * 1 September 2026). Usage types `USE1-MP:USE1_InputTokenCount-Units` /
   * `USE1_OutputTokenCount-Units` (Haiku 4.5: SKUs JQDUC8Q4K8C6GSGH, X629GDA2GXAP6R54) and
   * `USE1_input_tokens_standard-Units` / `USE1_output_tokens_standard-Units` (Opus 5:
   * 9F36CPTU6P68N3FP, R3K9HYRTTJUP7UJF; Sonnet 5.5: 6TG78WT6WYJUVS72, ZNY2E4B6MTPHYXVH).
   * Regional is 10% above the global and first-party rates. Cache writes (1.25×) and reads
   * (0.1×) keep the first-party multipliers exactly (Haiku 4.5: $1.375 and $0.11).
   */
  readonly inputCentsPerMillion: number;
  readonly outputCentsPerMillion: number;
}

const HAIKU_4_5: BedrockModel = Object.freeze({
  inferenceProfileId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  foundationModelId: 'anthropic.claude-haiku-4-5-20251001-v1:0',
  countTokens: true,
  inputCentsPerMillion: 110,
  outputCentsPerMillion: 550,
});

/**
 * Every Claude model id a Callie request builder may send, and its Bedrock identity. A model
 * with no row here cannot be sent over Bedrock: the transport refuses it before any request
 * (`test/classification/bedrockTransport.test.ts` asserts that every classifier, summary and
 * research model has a row).
 */
export const BEDROCK_MODEL_TABLE: Readonly<Record<string, BedrockModel>> = Object.freeze({
  'claude-haiku-4-5': HAIKU_4_5,
  'claude-haiku-4-5-20251001': HAIKU_4_5,
  'claude-opus-5': Object.freeze({
    inferenceProfileId: 'us.anthropic.claude-opus-5',
    foundationModelId: 'anthropic.claude-opus-5',
    countTokens: false,
    inputCentsPerMillion: 550,
    outputCentsPerMillion: 2_750,
  }),
  'claude-sonnet-5-5': Object.freeze({
    inferenceProfileId: 'us.anthropic.claude-sonnet-5-5',
    foundationModelId: 'anthropic.claude-sonnet-5-5',
    countTokens: false,
    inputCentsPerMillion: 220,
    outputCentsPerMillion: 1_100,
  }),
});

export function bedrockModelOf(model: string): BedrockModel | undefined {
  return Object.hasOwn(BEDROCK_MODEL_TABLE, model) ? BEDROCK_MODEL_TABLE[model] : undefined;
}

export class UnmappedBedrockModelError extends Error {
  constructor(readonly modelName: string) {
    super(`no Bedrock inference profile for ${modelName}`);
    this.name = 'UnmappedBedrockModelError';
  }
}

/**
 * A model's price per million tokens on a transport: the caller's first-party row for the
 * direct API, the Bedrock row for Bedrock. Throws for a Bedrock model with no row, so a call
 * nobody priced is a call nobody reserves.
 */
export function transportPrice(
  transport: ModelTransportKind,
  model: string,
  firstParty: { readonly input: number; readonly output: number },
): { readonly input: number; readonly output: number } {
  if (transport === 'anthropic') return firstParty;
  const row = bedrockModelOf(model);
  if (row === undefined) throw new UnmappedBedrockModelError(model);
  return { input: row.inputCentsPerMillion, output: row.outputCentsPerMillion };
}
