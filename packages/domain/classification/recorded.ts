import { createHash } from 'node:crypto';
import type {
  AnthropicMessageResponse,
  AnthropicMessagesTransport,
} from './anthropicClient.ts';
import type { ClassifierRequest } from './prompt.ts';

/**
 * The recorded transport every test uses (16.1: "LLM classifier harness: fixed
 * labeled corpus, schema failures, prompt/model versioning, adversarial wording,
 * explicit opt-outs, false-automated protection, and low-confidence fallback").
 *
 * It is a *transport*, not a classifier. Everything the adapter does — the request
 * it builds, the refusal check, the schema read, the excerpt verification — runs for
 * real against it, so the fixture exercises the code that will run in production and
 * not a second implementation of it.
 *
 * ## The cache is simulated, and that is the point
 *
 * The brief asks for a proven cache hit in recorded mode. A fake that always
 * reported `cache_read_input_tokens: 4096` would prove nothing: the thing worth
 * proving is that the *prefix does not change between calls*, and only a fake that
 * derives its answer from the bytes it was sent can tell you that.
 *
 * So this transport hashes the cacheable prefix — the system blocks and the
 * `output_config` — exactly as the provider matches it, and reports a cache write on
 * the first request carrying a given prefix and a cache read on every later one. A
 * request whose prefix drifted by one byte reports a write again, and
 * `packages/domain/test/classification/corpus.test.ts` fails. That is the same
 * signal `usage.cache_read_input_tokens` gives against the live API, produced by the
 * same cause.
 *
 * ## The fixtures are synthetic
 *
 * `test/corpus/replies/**` contains no real person, firm or address; every address
 * is under `example.test` (RFC 6761) and every telephone number is in the NANP
 * 555-01XX fictional block. There is no API key anywhere in this file or those.
 */

/** A recorded answer for one corpus case, keyed by the case's stable id. */
export interface RecordedAnswer {
  /** The raw text the model returned. A string on purpose: malformed cases are strings. */
  readonly text?: string | undefined;
  readonly stopReason?: string | undefined;
  readonly refusalCategory?: string | undefined;
  readonly model?: string | undefined;
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  /** Set to throw instead of answering: the `provider_error` case. */
  readonly throws?: boolean | undefined;
}

export interface RecordedCall {
  readonly request: ClassifierRequest;
  readonly prefixHash: string;
  readonly cacheRead: number;
}

export interface RecordedAnthropicTransport extends AnthropicMessagesTransport {
  readonly calls: readonly RecordedCall[];
  /** How many distinct cacheable prefixes have been seen. One, in a healthy run. */
  prefixCount(): number;
}

/**
 * The bytes the provider matches a cache on: tools, then system, then messages, in
 * that order, up to the last `cache_control` breakpoint. There are no tools here and
 * the breakpoint is on the single system block, so the prefix is `output_config`
 * plus the system blocks — and the model id, because a cache is model-scoped.
 */
export function cacheablePrefix(request: ClassifierRequest): string {
  return JSON.stringify({
    model: request.model,
    output_config: request.output_config,
    system: request.system,
  });
}

/** How the fixture keys an answer: the body of the volatile turn, hashed. */
export function corpusRequestKey(request: ClassifierRequest): string {
  const content = request.messages.map(message => message.content).join('\n');
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

export interface RecordedTransportOptions {
  /**
   * Answers by the key the corpus assigns. A key the corpus does not know throws,
   * loudly: a fixture that silently answered "uncertain" for an unrecorded message
   * would make a broken corpus look like a cautious classifier.
   */
  readonly answers: ReadonlyMap<string, RecordedAnswer>;
  /** How a request keys into `answers`. The corpus uses its own case ids. */
  readonly keyOf?: ((request: ClassifierRequest) => string) | undefined;
  /** Reported as `cache_read_input_tokens` on a prefix that has been seen before. */
  readonly cachedPrefixTokens?: number | undefined;
}

export function recordedAnthropicTransport(options: RecordedTransportOptions): RecordedAnthropicTransport {
  const seenPrefixes = new Set<string>();
  const calls: RecordedCall[] = [];
  const keyOf = options.keyOf ?? corpusRequestKey;
  const cachedPrefixTokens = options.cachedPrefixTokens ?? 1408;

  return {
    calls,
    prefixCount: () => seenPrefixes.size,
    create: async (request: ClassifierRequest): Promise<AnthropicMessageResponse> => {
      await Promise.resolve();
      const key = keyOf(request);
      const answer = options.answers.get(key);
      if (answer === undefined) {
        throw new Error(`the recorded corpus has no answer for ${key}; re-record before adding a case`);
      }

      const prefix = createHash('sha256').update(cacheablePrefix(request)).digest('hex');
      const warm = seenPrefixes.has(prefix);
      seenPrefixes.add(prefix);
      calls.push({ request, prefixHash: prefix, cacheRead: warm ? cachedPrefixTokens : 0 });

      if (answer.throws === true) throw new Error('the provider refused the connection');

      const volatileTokens = answer.inputTokens ?? 120;
      return {
        model: answer.model ?? request.model,
        stop_reason: answer.stopReason ?? 'end_turn',
        stop_details:
          answer.stopReason === 'refusal'
            ? { type: 'refusal', category: answer.refusalCategory ?? null }
            : null,
        content: answer.text === undefined ? [] : [{ type: 'text', text: answer.text }],
        usage: {
          input_tokens: volatileTokens,
          output_tokens: answer.outputTokens ?? 90,
          cache_creation_input_tokens: warm ? 0 : cachedPrefixTokens,
          cache_read_input_tokens: warm ? cachedPrefixTokens : 0,
        },
      };
    },
  };
}
