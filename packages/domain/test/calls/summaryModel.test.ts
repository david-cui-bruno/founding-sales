import { describe, expect, it } from 'vitest';
import { anthropicCallSummarizer, usageOfSummary } from '../../calls/summaryAdapter.ts';
import {
  CALL_SUMMARY_PROMPT_VERSION,
  CALL_SUMMARY_SYSTEM_PROMPT,
  buildCallSummaryRequest,
  callSummaryCeilingCents,
  callSummaryCents,
  callSummaryInputTokenBound,
  callSummaryUserText,
  readCallSummaryAnswer,
  sentenceCount,
  sideOfSpeaker,
  verbatimIn,
} from '../../calls/summaryModel.ts';
import type { AnthropicMessageResponse } from '../../classification/anthropicClient.ts';

/**
 * Slice C3b: the summary's request, its price, and what is kept of an answer — the schema,
 * the quotes checked against the side that said them, the due phrases against the call.
 */

const UTTERANCES = [
  { speaker: 0, start: 1, end: 5, text: 'Hi, this is David from Callie. I will send the proposal by Friday.' },
  { speaker: 1, start: 6, end: 9, text: 'Thursday the ninth at two thirty works. Put it on the calendar.' },
];
const CALL = { firmName: 'Brightline Property Group', contactName: 'Marisol Okafor', utterances: UTTERANCES };

const answer = (patch: Record<string, unknown> = {}): string =>
  JSON.stringify({
    summary: 'You reached Marisol. You offered a proposal. She agreed to a demo.',
    next_steps: [{ action: 'Send the proposal', owner: 'you', due: 'by Friday' }],
    commitments: [{ speaker: 'you', quote: 'I will send the proposal by Friday' }],
    prompt_version: CALL_SUMMARY_PROMPT_VERSION,
    ...patch,
  });

describe('the summary request', () => {
  it('labels each line You or Them by channel, fences the transcript, and names the firm and contact', () => {
    const text = callSummaryUserText(CALL);
    expect(text).toContain('firm: Brightline Property Group');
    expect(text).toContain('contact: Marisol Okafor');
    expect(text).toContain('[0:01] You: Hi, this is David from Callie.');
    expect(text).toContain('[0:06] Them: Thursday the ninth');
    expect(text.indexOf('transcript_begins')).toBeLessThan(text.indexOf('[0:01]'));
    expect(sideOfSpeaker(0)).toBe('you');
    expect(sideOfSpeaker(1)).toBe('them');
    expect(sideOfSpeaker(2)).toBeNull();
  });

  it('sends Haiku 4.5 with no effort and no fallbacks, and Sonnet 5.5 at low effort with the default fallbacks', () => {
    const haiku = buildCallSummaryRequest({ model: 'claude-haiku-4-5-20251001', maxOutputTokens: 1500, call: CALL });
    expect(haiku.model).toBe('claude-haiku-4-5-20251001');
    expect(haiku.max_tokens).toBe(1500);
    expect(haiku.output_config).not.toHaveProperty('effort');
    expect(haiku.output_config.format.type).toBe('json_schema');
    expect(haiku).not.toHaveProperty('fallbacks');
    expect(haiku.system).toEqual([{ type: 'text', text: CALL_SUMMARY_SYSTEM_PROMPT }]);
    const sonnet = buildCallSummaryRequest({ model: 'claude-sonnet-5-5', maxOutputTokens: 4000, call: CALL });
    expect(sonnet.output_config.effort).toBe('low');
    expect(sonnet.fallbacks).toBe('default');
    expect(sonnet.betas).toEqual(['server-side-fallback-2026-07-01']);
  });

  it('prices the bound from the request bytes and max_tokens, doubled for a model with fallbacks', () => {
    const request = buildCallSummaryRequest({ model: 'claude-haiku-4-5-20251001', maxOutputTokens: 1500, call: CALL });
    const bound = callSummaryInputTokenBound(request);
    expect(bound).toBe(Buffer.byteLength(JSON.stringify(request), 'utf8'));
    expect(callSummaryCeilingCents('claude-haiku-4-5-20251001', 1_000_000, 0)).toBe(100);
    expect(callSummaryCeilingCents('claude-haiku-4-5-20251001', 0, 1_000_000)).toBe(500);
    expect(callSummaryCeilingCents('claude-sonnet-5-5', 1_000_000, 0)).toBe(400);
    expect(callSummaryCents('claude-haiku-4-5-20251001', { inputTokens: 2000, cachedInputTokens: 0, outputTokens: 400 })).toBe(1);
    expect(callSummaryCents('claude-sonnet-5-5', { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 100_000 })).toBe(300);
  });
});

describe('reading an answer', () => {
  it('keeps a valid answer whose quotes are its sides’ own words', () => {
    const read = readCallSummaryAnswer(answer(), UTTERANCES);
    expect(read).toEqual({
      ok: true,
      content: {
        summary: 'You reached Marisol. You offered a proposal. She agreed to a demo.',
        nextSteps: [{ action: 'Send the proposal', owner: 'you', due: 'by Friday' }],
        commitments: [{ speaker: 'you', quote: 'I will send the proposal by Friday' }],
        droppedCommitments: 0,
        droppedDue: 0,
      },
    });
  });

  it('drops a quote the other side said, an invented quote, and one that joins two lines; nulls a due phrase nobody said', () => {
    const read = readCallSummaryAnswer(
      answer({
        commitments: [
          { speaker: 'them', quote: 'I will send the proposal by Friday' },
          { speaker: 'them', quote: 'We will sign the contract today' },
          { speaker: 'you', quote: 'by Friday. Thursday the ninth' },
          { speaker: 'them', quote: 'put it on the calendar' },
        ],
        next_steps: [{ action: 'Book the demo', owner: null, due: 'October 9 at 2:30 PM' }],
      }),
      UTTERANCES,
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.content.commitments).toEqual([{ speaker: 'them', quote: 'put it on the calendar' }]);
    expect(read.content.droppedCommitments).toBe(3);
    expect(read.content.nextSteps).toEqual([{ action: 'Book the demo', owner: null, due: null }]);
    expect(read.content.droppedDue).toBe(1);
  });

  it('refuses text that is not JSON, and JSON outside the schema', () => {
    expect(readCallSummaryAnswer('Here is the summary: …', UTTERANCES)).toEqual({ ok: false, failure: 'malformed' });
    for (const patch of [
      { summary: 'One sentence only.' },
      { summary: 'One. Two. Three. Four. Five. Six. Seven.' },
      { next_steps: Array.from({ length: 6 }, () => ({ action: 'x', owner: null, due: null })) },
      { next_steps: [{ action: 'Call back', owner: 'David', due: null }] },
      { commitments: [{ speaker: 'prospect', quote: 'yes' }] },
      { extra: true },
    ]) {
      expect(readCallSummaryAnswer(answer(patch), UTTERANCES), JSON.stringify(patch)).toEqual({ ok: false, failure: 'schema_invalid' });
    }
  });

  it('counts sentences, and matches word for word with case and punctuation folded', () => {
    expect(sentenceCount('You called. They said no. That is all.')).toBe(3);
    expect(verbatimIn('put it on the calendar', 'Yes, that works. Put it on the calendar.')).toBe(true);
    expect(verbatimIn('put it on calendar', 'Put it on the calendar.')).toBe(false);
    expect(verbatimIn('on the cal', 'Put it on the calendar.')).toBe(false);
  });
});

describe('the adapter', () => {
  const respond = (response: AnthropicMessageResponse | Error) =>
    anthropicCallSummarizer({
      transport: {
        countTokens: async () => await Promise.resolve(1),
        create: async () => (response instanceof Error ? await Promise.reject(response) : await Promise.resolve(response)),
      },
    });
  const input = { model: 'claude-haiku-4-5-20251001' as const, maxOutputTokens: 1500, call: CALL };

  it('says what an answer cost, or null when it did not report both counts', () => {
    expect(usageOfSummary({ usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 } })).toEqual({
      inputTokens: 10,
      cachedInputTokens: 3,
      outputTokens: 5,
    });
    expect(usageOfSummary({ usage: { output_tokens: 5 } })).toBeNull();
    expect(usageOfSummary({})).toBeNull();
  });

  it('turns every way an answer can fail into a word, and never carries the error text', async () => {
    const usage = { input_tokens: 10, output_tokens: 5 };
    expect(await respond(new Error('socket hang up: I will send the proposal by Friday')).summarize(input)).toEqual({
      outcome: 'provider_error',
      usage: null,
      content: null,
      answeredBy: null,
    });
    expect((await respond({ stop_reason: 'refusal', content: [{ type: 'text', text: answer() }], usage }).summarize(input)).outcome).toBe('refusal');
    expect((await respond({ stop_reason: 'end_turn', content: [], usage }).summarize(input)).outcome).toBe('malformed');
    expect((await respond({ stop_reason: 'end_turn', content: [{ type: 'text', text: answer({ summary: 'Short.' }) }], usage }).summarize(input)).outcome).toBe(
      'schema_invalid',
    );
    const ok = await respond({ model: 'claude-haiku-4-5-20251001', stop_reason: 'end_turn', content: [{ type: 'text', text: answer() }], usage }).summarize(input);
    expect(ok.outcome).toBe('accepted');
    expect(ok.usage).toEqual({ inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 });
    expect(ok.answeredBy).toBe('claude-haiku-4-5-20251001');
  });
});
