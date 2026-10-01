import type { AnthropicMessageResponse, AnthropicMessagesTransport } from '../classification/anthropicClient.ts';
import { providerErrorOf, type ProviderErrorDetail } from '../classification/providerError.ts';
import {
  buildCallSummaryRequest,
  readCallSummaryAnswer,
  type CallSummaryContent,
  type CallSummaryInput,
  type CallSummaryModel,
  type CallSummaryUsage,
} from './summaryModel.ts';

/**
 * The summary port and its Anthropic adapter (slice C3b): one request, one answer, and
 * every way the answer can be useless, each a word the job records.
 *
 * | Outcome | What happened | Charged |
 * |---|---|---|
 * | `accepted` | A summary that passed the schema. | its usage |
 * | `refusal` | `stop_reason === 'refusal'`, read before `content`. | its usage |
 * | `malformed` | No text, or text that is not JSON. | its usage |
 * | `schema_invalid` | JSON outside the schema (e.g. two sentences). | its usage |
 * | `provider_refused` | The API answered 4xx (not 408): the request was refused before any generation. Terminal. | 0 |
 * | `provider_error` | A 5xx, a 408, a timeout or a dropped connection: nobody knows what was billed. | the estimate |
 *
 * A refused or failed request carries `provider` (`classification/providerError.ts`, the one
 * helper the classifier shares): the HTTP status, the API's error type, and for a 400
 * `invalid_request_error` at most the parameter path its message starts with — never the
 * message's text, so no transcript can reach a log through it. A 4xx `invalid_request_error`
 * used to be read as an ambiguous failure and retried at an estimate; it is the API saying
 * no, before generation, and the next attempt would say no too.
 *
 * `usage` is null when the answer did not say what it cost; the caller settles that at the
 * reservation's estimate, never at zero. The SDK's error is never carried: its text can
 * quote the request body, and the request body is what a prospect said.
 */

export type CallSummaryOutcome = 'accepted' | 'refusal' | 'malformed' | 'schema_invalid' | 'provider_refused' | 'provider_error';

export type { ProviderErrorDetail } from '../classification/providerError.ts';

export interface CallSummaryAttempt {
  readonly outcome: CallSummaryOutcome;
  /** The answer's own usage, or null when it reported none (or there was no answer). */
  readonly usage: CallSummaryUsage | null;
  readonly content: CallSummaryContent | null;
  /** The server's word for the model that answered (a fallback may differ). */
  readonly answeredBy: string | null;
  /** For `provider_refused` and `provider_error`: what the API said, when it said anything. */
  readonly provider?: ProviderErrorDetail | undefined;
}

export interface CallSummaryPort {
  summarize(input: {
    readonly model: CallSummaryModel;
    readonly maxOutputTokens: number;
    readonly call: CallSummaryInput;
  }): Promise<CallSummaryAttempt>;
}

function textOf(response: AnthropicMessageResponse): string | null {
  for (const block of response.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) return block.text;
  }
  return null;
}

const count = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;

/** The usage an answer reported, or null when it did not report input and output. */
export function usageOfSummary(response: AnthropicMessageResponse): CallSummaryUsage | null {
  const usage = response.usage;
  if (usage === undefined) return null;
  const input = count(usage.input_tokens);
  const output = count(usage.output_tokens);
  if (input === null || output === null) return null;
  return {
    inputTokens: input,
    cachedInputTokens: (count(usage.cache_read_input_tokens) ?? 0) + (count(usage.cache_creation_input_tokens) ?? 0),
    outputTokens: output,
  };
}

export function anthropicCallSummarizer(options: { readonly transport: AnthropicMessagesTransport }): CallSummaryPort {
  return {
    summarize: async input => {
      const request = buildCallSummaryRequest(input);
      let response: AnthropicMessageResponse;
      try {
        response = await options.transport.create(request);
      } catch (error) {
        const provider = providerErrorOf(error);
        return {
          outcome: provider.refused ? 'provider_refused' : 'provider_error',
          usage: null,
          content: null,
          answeredBy: null,
          provider,
        };
      }
      const usage = usageOfSummary(response);
      const answeredBy = typeof response.model === 'string' ? response.model.slice(0, 64) : null;
      if (response.stop_reason === 'refusal') return { outcome: 'refusal', usage, content: null, answeredBy };
      const text = textOf(response);
      if (text === null) return { outcome: 'malformed', usage, content: null, answeredBy };
      const read = readCallSummaryAnswer(text, input.call.utterances);
      if (!read.ok) return { outcome: read.failure, usage, content: null, answeredBy };
      return { outcome: 'accepted', usage, content: read.content, answeredBy };
    },
  };
}
