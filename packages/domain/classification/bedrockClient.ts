import type { AnthropicMessageResponse, AnthropicMessagesTransport } from './anthropicClient.ts';
import { bedrockModelOf } from './modelTransport.ts';
import type { ClassifierRequest } from './prompt.ts';
import { SERVER_SIDE_FALLBACK_BETA } from './types.ts';

/**
 * The Amazon Bedrock transport (slice BR1): the same `AnthropicMessagesTransport` the
 * classifier, the after-call summary and research's extraction already use, over Bedrock's
 * `InvokeModel` and `CountTokens` instead of the direct API.
 *
 * The seam is `anthropicClient.ts`'s, for its reasons: the SDK is loaded through a variable
 * specifier so it is in no process's static module graph, and no test reaches the network —
 * every test hands `bedrockTransport` a fake `BedrockRuntimeSurface`. The credential is the
 * process's AWS default chain (the worker's task role in ECS); there is no key to hold.
 *
 * ## The request
 *
 * The body is the Messages API request the builders produced, with `model` moved to the URL
 * (as its `us.anthropic.*` inference profile, `modelTransport.ts`'s table) and
 * `anthropic_version: "bedrock-2023-05-31"` added. Everything else — `system` with its
 * `cache_control`, `messages`, `max_tokens`, `output_config.format` (strict JSON schema) and
 * `output_config.effort` — is sent exactly as built, because Bedrock accepts each of them
 * (real-model checks, 1 October 2026; the slice report's parity matrix).
 *
 * ## The one degradation: server-side fallbacks
 *
 * Bedrock refuses the `server-side-fallback-2026-07-01` beta ("invalid beta flag") and the
 * `fallbacks` parameter ("fallbacks: Extra inputs are not permitted"), measured 1 October
 * 2026. So both are removed from the body here, and only here: a refusal on Bedrock is final
 * (the adapters' `refusal` outcome) rather than re-run on a second model. Nothing that
 * validates an answer depends on them — the schema check, the verbatim-excerpt check and the
 * refusal-before-content read are all the adapters' and are untouched. The reservation keeps
 * its doubled bound for a fallback model, which is now only an over-reservation.
 *
 * ## Errors
 *
 * Thrown in the shape `providerError.ts` reads — `status` and `error.error.type` — and never
 * carrying the request: an AWS `ValidationException` (400) is reported as the Messages API's
 * `invalid_request_error`, which is what its message is (Bedrock forwards the API's own
 * "output_config.effort: Extra inputs are not permitted"), so a 400's leading parameter path
 * reaches the log as it does on the direct API. Every other AWS error keeps its own name as
 * the type. A 4xx other than 408 is a refusal before generation (settled at 0, not retried),
 * anything else — a 5xx, Bedrock's 408 `ModelTimeoutException`, a dropped connection, a
 * timeout, an unreadable 200 — is ambiguous and estimated, exactly as on the direct API.
 *
 * ## Retries
 *
 * None: `maxAttempts: 1` is the AWS SDK's spelling of the Anthropic SDK's `maxRetries: 0`.
 * The paid-call pattern owns every retry, after asking its switch again.
 */

/** Bedrock's Messages API version string, required in every Anthropic body it is sent. */
export const BEDROCK_ANTHROPIC_VERSION = 'bedrock-2023-05-31';

/**
 * The two Bedrock calls, narrowed to bytes in and out, so a test can hand in a fake and the
 * transport's whole behaviour — body, model id, degradation, error shape — is tested without
 * the SDK.
 */
export interface BedrockRuntimeSurface {
  /** `InvokeModel`: the response body bytes. Throws as the AWS SDK does. */
  invokeModel(input: { readonly modelId: string; readonly body: string }): Promise<Uint8Array>;
  /** `CountTokens`: the input token count it reports, if any. Throws as the AWS SDK does. */
  countTokens(input: { readonly modelId: string; readonly body: string }): Promise<number | undefined>;
}

/** An error in the shape `providerErrorOf` reads. The message is fixed; nothing of the request is in it. */
export class BedrockTransportError extends Error {
  readonly status: number | null;
  readonly error: { readonly error: { readonly type: string | null; readonly message?: string | undefined } };
  constructor(input: { readonly status: number | null; readonly type: string | null; readonly message?: string | undefined }) {
    super(`bedrock request failed${input.status === null ? '' : ` (${String(input.status)})`}`);
    this.name = 'BedrockTransportError';
    this.status = input.status;
    this.error = { error: { type: input.type, ...(input.message === undefined ? {} : { message: input.message }) } };
  }
}

/** AWS error names that are the Messages API's own types under another name. */
const AWS_TO_MESSAGES_TYPE: Readonly<Record<string, string>> = Object.freeze({
  ValidationException: 'invalid_request_error',
});

/** An AWS SDK throw, as a `BedrockTransportError`. Nothing but status, name and (for a 400) its message. */
export function bedrockErrorOf(error: unknown): BedrockTransportError {
  if (error instanceof BedrockTransportError) return error;
  if (typeof error !== 'object' || error === null) return new BedrockTransportError({ status: null, type: null });
  const record = error as { name?: unknown; message?: unknown; $metadata?: { httpStatusCode?: unknown } };
  const raw = record.$metadata?.httpStatusCode;
  const status = typeof raw === 'number' && Number.isInteger(raw) ? raw : null;
  // Only an error the service answered has a type: a socket error or a client-side timeout
  // (no status) is ambiguous, and its name is not the API's word for anything.
  const name = status !== null && typeof record.name === 'string' ? record.name : null;
  const type = name === null ? null : (AWS_TO_MESSAGES_TYPE[name] ?? name);
  // The message travels only where `providerErrorOf` reads a parameter path out of it, a 400
  // `invalid_request_error`; it reads the path and nothing after its colon.
  const message = status === 400 && type === 'invalid_request_error' && typeof record.message === 'string' ? record.message : undefined;
  return new BedrockTransportError({ status, type, message });
}

/**
 * The body Bedrock is sent for one request, and the model id it goes to.
 *
 * Throws `BedrockTransportError` (400, `model_unmapped`) for a model with no row in the
 * table: refused here, before any request, as the service would refuse an unknown id.
 */
export function bedrockRequestOf(request: ClassifierRequest): {
  readonly inferenceProfileId: string;
  readonly foundationModelId: string;
  readonly countTokens: boolean;
  readonly body: string;
} {
  const model = bedrockModelOf(request.model);
  if (model === undefined) throw new BedrockTransportError({ status: 400, type: 'model_unmapped' });
  // `model` goes to the URL; `betas` and `fallbacks` are the server-side fallback, which
  // Bedrock refuses. Any other beta flag is passed on as `anthropic_beta`.
  const { model: _model, betas, fallbacks: _fallbacks, ...rest } = request;
  const kept = (betas ?? []).filter(beta => beta !== SERVER_SIDE_FALLBACK_BETA);
  const body = {
    anthropic_version: BEDROCK_ANTHROPIC_VERSION,
    ...rest,
    ...(kept.length > 0 ? { anthropic_beta: kept } : {}),
  };
  return {
    inferenceProfileId: model.inferenceProfileId,
    foundationModelId: model.foundationModelId,
    countTokens: model.countTokens,
    body: JSON.stringify(body),
  };
}

/** The transport over a surface. `loadBedrockTransport` is the only caller with a real one. */
export function bedrockTransport(surface: BedrockRuntimeSurface): AnthropicMessagesTransport {
  return {
    kind: 'bedrock',
    create: async request => {
      const prepared = bedrockRequestOf(request);
      let bytes: Uint8Array;
      try {
        bytes = await surface.invokeModel({ modelId: prepared.inferenceProfileId, body: prepared.body });
      } catch (error) {
        throw bedrockErrorOf(error);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      } catch {
        // A 200 whose body is not JSON: the request ran and may have been billed, and nobody
        // can say what it cost. Ambiguous (no status), so estimated.
        throw new BedrockTransportError({ status: null, type: null });
      }
      if (typeof parsed !== 'object' || parsed === null) throw new BedrockTransportError({ status: null, type: null });
      return parsed as AnthropicMessageResponse;
    },
    countTokens: async request => {
      const prepared = bedrockRequestOf(request);
      if (!prepared.countTokens) {
        // No count endpoint for this model: the request's UTF-8 byte length, which no
        // tokenizer exceeds, so whatever is admitted on it is still inside its reservation.
        return Math.max(1, Buffer.byteLength(prepared.body, 'utf8'));
      }
      let tokens: number | undefined;
      try {
        tokens = await surface.countTokens({ modelId: prepared.foundationModelId, body: prepared.body });
      } catch (error) {
        throw bedrockErrorOf(error);
      }
      if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) {
        // Not a count, so not "it fits".
        throw new Error('CountTokens returned no inputTokens');
      }
      return Math.trunc(tokens);
    },
  };
}

interface BedrockSdk {
  BedrockRuntimeClient: new (configuration: {
    region: string;
    maxAttempts: number;
    requestHandler: { requestTimeout: number; connectionTimeout: number };
  }) => { send(command: unknown): Promise<unknown> };
  InvokeModelCommand: new (input: { modelId: string; contentType: string; accept: string; body: Uint8Array }) => unknown;
  CountTokensCommand: new (input: { modelId: string; input: { invokeModel: { body: Uint8Array } } }) => unknown;
}

/**
 * Build the real transport: the only function that loads `@aws-sdk/client-bedrock-runtime`
 * and the only one that can reach Bedrock. The region is the task's (`AWS_REGION`); the
 * credential is the default chain.
 */
export async function loadBedrockTransport(options: {
  readonly region: string;
  readonly timeoutMilliseconds?: number | undefined;
}): Promise<AnthropicMessagesTransport> {
  const specifier = '@aws-sdk/client-bedrock-runtime';
  const sdk = (await import(specifier)) as BedrockSdk;
  const timeout = options.timeoutMilliseconds ?? 30_000;
  const client = new sdk.BedrockRuntimeClient({
    region: options.region,
    // No automatic retries (slice P1): see the file note.
    maxAttempts: 1,
    requestHandler: { requestTimeout: timeout, connectionTimeout: Math.min(timeout, 5_000) },
  });
  const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
  return bedrockTransport({
    invokeModel: async ({ modelId, body }) => {
      const answer = (await client.send(
        new sdk.InvokeModelCommand({ modelId, contentType: 'application/json', accept: 'application/json', body: encode(body) }),
      )) as { body?: Uint8Array };
      return answer.body ?? new Uint8Array();
    },
    countTokens: async ({ modelId, body }) => {
      const answer = (await client.send(
        new sdk.CountTokensCommand({ modelId, input: { invokeModel: { body: encode(body) } } }),
      )) as { inputTokens?: number };
      return answer.inputTokens;
    },
  });
}
