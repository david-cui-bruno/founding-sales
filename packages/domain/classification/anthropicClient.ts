import type { ClassifierRequest } from './prompt.ts';

/**
 * The one place this repository is allowed to know the Anthropic SDK exists.
 *
 * The shape is G7's KMS adapter and G5's CloudWatch sink, for the three reasons
 * `docs/decisions/g7-kms-adapter.md` gives and one more of its own:
 *
 * * the API process never classifies anything and should not load an SDK it will
 *   never call;
 * * a laptop with no API key must be able to run the whole test suite;
 * * the transport is one method, so a fake is a handful of lines and nothing in a
 *   test can reach the network;
 * * and the specifier is a **variable**, so the SDK is not in the static module
 *   graph of any process. A literal specifier would put the client — and its
 *   credential resolution — inside the closure of everything that imports
 *   `@fss/domain/classification`, including the reply-card read.
 *
 * `AnthropicMessagesTransport` is the narrowed SDK: one method, taking the request
 * `buildClassifierRequest` produced and returning the parts of a message this lane
 * reads. It is deliberately not the SDK's own parameter type. Importing that type
 * would be a static import of the package, and the point of the seam is that there
 * is none.
 *
 * No test exercises `loadAnthropicTransport`. Every test uses
 * `recordedAnthropicTransport` from `recorded.ts`, whose fixtures are synthetic.
 */

export interface AnthropicUsage {
  readonly input_tokens?: number | null;
  readonly output_tokens?: number | null;
  readonly cache_creation_input_tokens?: number | null;
  readonly cache_read_input_tokens?: number | null;
}

export interface AnthropicTextBlock {
  readonly type: string;
  readonly text?: string;
}

/** What a response says, narrowed to the fields the classifier reads. */
export interface AnthropicMessageResponse {
  readonly model?: string;
  readonly stop_reason?: string | null;
  readonly stop_details?: { readonly type?: string; readonly category?: string | null } | null;
  readonly content?: readonly AnthropicTextBlock[];
  readonly usage?: AnthropicUsage;
}

export interface AnthropicMessagesTransport {
  /** One non-streaming message. Throws on an API error, as the SDK does. */
  create(request: ClassifierRequest): Promise<AnthropicMessageResponse>;
}

/** Where the API key comes from. Mirrors `mail/secretProvider.ts`'s seam exactly. */
export const CLASSIFIER_SECRET_NAMES = ['llm_classifier_api_key'] as const;
export type ClassifierSecretName = (typeof CLASSIFIER_SECRET_NAMES)[number];

/**
 * The environment variable the ECS task definition's `secrets` block injects the
 * Secrets Manager entry `fss-prod/llm-classifier-api-key` into. The *name* is here;
 * the value is never in a file, a fixture, a test or a log line.
 */
export const CLASSIFIER_SECRET_ENVIRONMENT_VARIABLES: Readonly<Record<ClassifierSecretName, string>> =
  Object.freeze({ llm_classifier_api_key: 'FSS_LLM_CLASSIFIER_API_KEY' });

export class ClassifierSecretError extends Error {
  constructor(readonly secretName: string) {
    // Names the secret, never its value.
    super(`the secret ${secretName} is not configured`);
    this.name = 'ClassifierSecretError';
  }
}

export interface ClassifierSecretProvider {
  /** Throws `ClassifierSecretError` rather than returning a placeholder. Fails closed. */
  read(name: ClassifierSecretName): Promise<string>;
  /** Which names this provider can answer. Never the values. */
  names(): readonly ClassifierSecretName[];
}

/**
 * Read the injected value once, at construction, and hold nothing else. The same
 * rule `environmentSecretProvider` follows in the mail lane: the environment object
 * is read here and never again, so a later mutation of `process.env` cannot change
 * what the process believes its key is halfway through its life.
 */
export function environmentClassifierSecrets(
  environment: Readonly<Record<string, string | undefined>>,
): ClassifierSecretProvider {
  const held = new Map<ClassifierSecretName, string>();
  for (const name of CLASSIFIER_SECRET_NAMES) {
    const value = environment[CLASSIFIER_SECRET_ENVIRONMENT_VARIABLES[name]];
    if (value !== undefined && value.trim().length > 0) held.set(name, value);
  }
  return {
    read: async name => {
      await Promise.resolve();
      const value = held.get(name);
      if (value === undefined) throw new ClassifierSecretError(name);
      return value;
    },
    names: () => [...held.keys()],
  };
}

/** A provider over values the caller made. Tests use `randomBytes`, never a literal. */
export function staticClassifierSecrets(
  values: Readonly<Partial<Record<ClassifierSecretName, string>>>,
): ClassifierSecretProvider {
  const held = new Map<ClassifierSecretName, string>();
  for (const name of CLASSIFIER_SECRET_NAMES) {
    const value = values[name];
    if (value !== undefined && value.length > 0) held.set(name, value);
  }
  return {
    read: async name => {
      await Promise.resolve();
      const value = held.get(name);
      if (value === undefined) throw new ClassifierSecretError(name);
      return value;
    },
    names: () => [...held.keys()],
  };
}

/** For the startup line: which secrets are configured, and no value. */
export function describeClassifierSecrets(provider: ClassifierSecretProvider): {
  readonly configuredSecrets: string;
} {
  return { configuredSecrets: [...provider.names()].sort().join(' ') };
}

interface SdkClient {
  readonly beta: { readonly messages: { create(body: unknown): Promise<AnthropicMessageResponse> } };
}

/**
 * Build the real transport. The only function in the repository that loads the
 * Anthropic SDK and the only one that can reach the provider.
 *
 * `client.beta.messages.create` rather than `client.messages.create`, because the
 * server-side `fallbacks` parameter and its beta flag live on the beta path and the
 * beta path is a superset: a request with no `betas` behaves exactly as the stable
 * one. One code path for both models is worth more than shaving a namespace.
 *
 * The key is read here, passed to the constructor, and never held by this module:
 * the closure holds a client, and a client is not a string that can be logged or
 * serialized into an error body.
 */
export async function loadAnthropicTransport(options: {
  readonly secrets: ClassifierSecretProvider;
  readonly maxRetries?: number | undefined;
  readonly timeoutMilliseconds?: number | undefined;
}): Promise<AnthropicMessagesTransport> {
  const specifier = '@anthropic-ai/sdk';
  const sdk = (await import(specifier)) as {
    default: new (configuration: {
      apiKey: string;
      maxRetries?: number;
      timeout?: number;
    }) => SdkClient;
  };
  const client = new sdk.default({
    apiKey: await options.secrets.read('llm_classifier_api_key'),
    // Two retries is the SDK default and the right one here: a classification is
    // idempotent from the provider's point of view and a transient 429 costs
    // nothing but latency. The job's own ladder is what handles the rest.
    maxRetries: options.maxRetries ?? 2,
    // Milliseconds in the TypeScript SDK. A classification that has taken half a
    // minute is one the worker should give the lease back for.
    timeout: options.timeoutMilliseconds ?? 30_000,
  });
  return {
    create: async request => await client.beta.messages.create(request),
  };
}
