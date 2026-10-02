import type { AnthropicMessageResponse, AnthropicMessagesTransport } from '../classification/anthropicClient.ts';
import { providerErrorOf, type ProviderErrorDetail } from '../classification/providerError.ts';
import { buildCallAnalysisRequest, type CallAnalysisInput, type CallAnalysisModel, type CallAnalysisUsage } from './analysisModel.ts';
import { usageOfSummary } from './summaryAdapter.ts';

/**
 * The analysis port and its Messages-API adapter (slice 3a): one request, one answer.
 *
 * | Outcome | What happened | Charged |
 * |---|---|---|
 * | `answered` | Text came back. Whether it reads is `readCallAnalysisAnswer`'s question. | its usage |
 * | `refusal` | `stop_reason === 'refusal'`, read before `content`. | its usage |
 * | `malformed` | No text. | its usage |
 * | `provider_refused` | A 4xx (not 408): refused before generation. Terminal. | 0 |
 * | `provider_error` | A 5xx, a 408, a timeout or a dropped connection. | the estimate |
 *
 * The text never reaches a log, and neither does the SDK's error (its message can quote the
 * request, which is what a prospect said): only `provider`'s status, type and parameter path.
 */

export type CallAnalysisOutcome = 'answered' | 'refusal' | 'malformed' | 'provider_refused' | 'provider_error';

export interface CallAnalysisAttempt {
  readonly outcome: CallAnalysisOutcome;
  readonly usage: CallAnalysisUsage | null;
  /** The answer's text, exactly as received, for `answered`. */
  readonly text: string | null;
  readonly answeredBy: string | null;
  readonly provider?: ProviderErrorDetail | undefined;
}

export interface CallAnalysisPort {
  analyze(input: {
    readonly model: CallAnalysisModel;
    readonly maxOutputTokens: number;
    readonly call: CallAnalysisInput;
  }): Promise<CallAnalysisAttempt>;
}

function textOf(response: AnthropicMessageResponse): string | null {
  for (const block of response.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) return block.text;
  }
  return null;
}

export function messagesCallAnalyzer(options: { readonly transport: AnthropicMessagesTransport }): CallAnalysisPort {
  return {
    analyze: async input => {
      const request = buildCallAnalysisRequest(input);
      let response: AnthropicMessageResponse;
      try {
        response = await options.transport.create(request);
      } catch (error) {
        const provider = providerErrorOf(error);
        return { outcome: provider.refused ? 'provider_refused' : 'provider_error', usage: null, text: null, answeredBy: null, provider };
      }
      const usage = usageOfSummary(response);
      const answeredBy = typeof response.model === 'string' ? response.model.slice(0, 64) : null;
      if (response.stop_reason === 'refusal') return { outcome: 'refusal', usage, text: null, answeredBy };
      const text = textOf(response);
      if (text === null) return { outcome: 'malformed', usage, text: null, answeredBy };
      return { outcome: 'answered', usage, text, answeredBy };
    },
  };
}
