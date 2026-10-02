/**
 * Which transport carries Callie's Claude calls, and the one table that maps a Claude
 * model id to its Amazon Bedrock inference profile (slice BR1).
 *
 * Two transports, one request shape. The reply classifier, the after-call summary and
 * research's extraction all build a Messages API request (`ClassifierRequest`) and hand it
 * to an `AnthropicMessagesTransport`; this file decides which one carries each request:
 *
 *   * `FSS_MODEL_TRANSPORT=bedrock` — **by model** (review BR1R, finding 1). A model in
 *     `BEDROCK_MODEL_TABLE` (the models this AWS account can call) goes through Amazon
 *     Bedrock `InvokeModel` with the worker task role (`bedrockClient.ts`), paid from
 *     credits. Any other model goes through the direct API with the classifier key, exactly
 *     as before: cash, the cash keys, the cash ceiling. With no key, such a model has no
 *     route and nothing is reserved for it. Production sets it (`infra/modules/stack`).
 *   * `FSS_MODEL_TRANSPORT=anthropic`, or unset — the direct Anthropic API with the
 *     classifier key (`anthropicClient.ts`). Paid in cash.
 *
 * Anything else is a configuration problem named by the variable, and the worker builds no
 * transport at all. The route is a function of the model alone, decided before the
 * reservation, and the reservation's `provider_key` records it. **There is no automatic
 * fallback from one to the other**: a Bedrock failure is the paid-call pattern's ordinary
 * failure (refused, or ambiguous and estimated), never a second request to the direct API,
 * which would be cash the ceiling did not plan.
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
export type ModelCallPurpose = 'classifier' | 'call_summary' | 'call_analysis' | 'extraction';

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
 * The Claude models this AWS account can call on Bedrock, and their Bedrock identity: Claude
 * Haiku 4.5 only, of the models a Callie request builder sends. Measured 1 October 2026:
 * Opus 5, Opus 5.5, Sonnet 5.5, Sonnet 5 and Fable 5.1 are listed in us-east-1 but every
 * call answers 403 "not available for this account". A model with no row is routed to the
 * direct API (`modelRoute`), never to Bedrock, so adding a row is what moves a model to
 * credits — after the account can call it.
 */
export const BEDROCK_MODEL_TABLE: Readonly<Record<string, BedrockModel>> = Object.freeze({
  'claude-haiku-4-5': HAIKU_4_5,
  'claude-haiku-4-5-20251001': HAIKU_4_5,
});

/** Which transport carries a model's requests, or null when this deployment has none for it. */
export type ModelRoute = (model: string) => ModelTransportKind | null;

/** Every model through the direct API: a deployment without Bedrock. */
export const DIRECT_ROUTE: ModelRoute = () => 'anthropic';

/**
 * The route under `FSS_MODEL_TRANSPORT=bedrock`: a mapped model to Bedrock, any other to the
 * direct API when the deployment holds its key, and otherwise nowhere.
 */
export function bedrockModelRoute(options: { readonly directAvailable: boolean }): ModelRoute {
  return model => (bedrockModelOf(model) !== undefined ? 'bedrock' : options.directAvailable ? 'anthropic' : null);
}

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
