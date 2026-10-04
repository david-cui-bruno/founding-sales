import { routeOfTransport } from '../classification/routedTransport.ts';
import type { AnthropicMessagesTransport } from '../classification/anthropicClient.ts';
import { providerErrorOf } from '../classification/providerError.ts';
import { bedrockModelOf } from '../classification/modelTransport.ts';
import { usageOfSummary, type CallSummaryAttempt } from '../calls/summaryAdapter.ts';
import { buildMeetingAnalysisRequest, validateMeetingAnalysisAnswer, type ValidatedMeetingAnalysis } from './analysisModel.ts';
import { MEETING_ANALYSIS_LIMITS, type MeetingAnalysisInput } from './analysisInput.ts';
import type { ClassifierRequest } from '../classification/prompt.ts';
import type { MeetingResult } from './outcomeTypes.ts';
export interface MeetingAnalysisCall { model: string; purpose: 'extract' | 'merge'; maxOutputTokens: number; input: MeetingAnalysisInput; prior?: readonly ValidatedMeetingAnalysis[] }
export interface MeetingAnalysisAttempt { outcome: CallSummaryAttempt['outcome']; content: ValidatedMeetingAnalysis | null; usage: CallSummaryAttempt['usage']; }
export interface PreparedMeetingAnalysis { request: ClassifierRequest; inputTokens: number; }
export interface MeetingAnalysisPort {
  readonly kind: 'bedrock' | 'unavailable';
  prepare(input: MeetingAnalysisCall): Promise<MeetingResult<PreparedMeetingAnalysis>>;
  run(input: MeetingAnalysisCall, prepared?: PreparedMeetingAnalysis): Promise<MeetingAnalysisAttempt>;
}
export function meetingAnalysisPort(options: { transport: AnthropicMessagesTransport }): MeetingAnalysisPort {
  const prepare = async (input: MeetingAnalysisCall): Promise<MeetingResult<PreparedMeetingAnalysis>> => {
    if (options.transport.kind !== 'bedrock' || routeOfTransport(options.transport)(input.model) !== 'bedrock' || bedrockModelOf(input.model) === undefined) return { ok: false, reason: 'route_unavailable' };
    const limit = input.purpose === 'extract' ? MEETING_ANALYSIS_LIMITS.extractOutput : MEETING_ANALYSIS_LIMITS.mergeOutput;
    if (input.maxOutputTokens !== limit) return { ok: false, reason: 'invalid_configuration' };
    const request = buildMeetingAnalysisRequest(input);
    const bytes = Buffer.byteLength(JSON.stringify(request));
    if (bytes > MEETING_ANALYSIS_LIMITS.requestBytes) return { ok: false, reason: 'input_too_large' };
    let inputTokens = bytes;
    try { const counted = await options.transport.countTokens(request); if (Number.isSafeInteger(counted) && counted >= 0) inputTokens = counted; } catch { /* UTF-8 byte count is a conservative upper bound. */ }
    if (inputTokens > MEETING_ANALYSIS_LIMITS.inputTokens) return { ok: false, reason: 'input_too_large' };
    return { ok: true, value: { request, inputTokens } };
  };
  return { kind: options.transport.kind === 'bedrock' && routeOfTransport(options.transport)('claude-haiku-4-5') === 'bedrock' ? 'bedrock' : 'unavailable', prepare, run: async (input, prepared) => {
    if (options.transport.kind !== 'bedrock' || routeOfTransport(options.transport)(input.model) !== 'bedrock' || bedrockModelOf(input.model) === undefined) return { outcome: 'provider_refused', usage: null, content: null };
    const built = prepared === undefined ? await prepare(input) : { ok: true as const, value: prepared };
    if (!built.ok) return { outcome: 'provider_refused', usage: null, content: null };
    try {
      const response = await options.transport.create(built.value.request);
      const usage = usageOfSummary(response);
      if (response.stop_reason === 'refusal') return { outcome: 'refusal', usage, content: null };
      if (response.stop_reason === 'max_tokens') return { outcome: 'malformed', usage, content: null };
      const text = (response.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join('');
      const answer = validateMeetingAnalysisAnswer(text, input.input);
      return answer.ok ? { outcome: 'accepted', usage, content: answer.value } : { outcome: answer.reason === 'malformed' ? 'malformed' : 'schema_invalid', usage, content: null };
    } catch (error) { return { outcome: providerErrorOf(error).refused ? 'provider_refused' : 'provider_error', usage: null, content: null }; }
  } };
}
