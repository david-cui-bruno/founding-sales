import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { callAnalysisResultSchema } from '@fss/contracts';
import {
  CALL_ANALYSIS_JSON_SCHEMA,
  CALL_ANALYSIS_PROMPT_VERSION,
  CALL_ANALYSIS_SYSTEM_PROMPT,
  buildCallAnalysisRequest,
  callAnalysisCeilingCents,
  callAnalysisCents,
  callAnalysisInputTokenBound,
  callAnalysisProviderKey,
  callAnalysisUserText,
  numberedTranscriptText,
  readCallAnalysisAnswer,
  transcriptSha256,
} from '../../calls/analysisModel.ts';
import { schemaProblems } from '../support/structuredOutputsSchema.ts';
import type { CorpusCase } from '../corpus/calls/evaluate.ts';
import { answer, lines } from './analysisFixtures.ts';

/**
 * Slice 3a, A-1: the analysis request (walked by the structured-outputs rules exactly as it
 * is sent) and the reader's rules — quotes verbatim on their own line, sides correct, the
 * callback on a Them line or agreed by one, failing items dropped and counted, and an
 * unqualified buying signal read as unclear.
 */

const CORPUS = JSON.parse(readFileSync(new URL('../corpus/calls/cases.json', import.meta.url), 'utf8')) as { cases: CorpusCase[] };
const CASE_3 = CORPUS.cases.find(corpusCase => corpusCase.n === 3);
if (CASE_3 === undefined) throw new Error('case 3 is missing');

const callOf = (corpusCase: CorpusCase) => ({
  firmName: corpusCase.firmName,
  contactName: corpusCase.contactName,
  callLocalTime: corpusCase.callLocalTime,
  utterances: corpusCase.utterances,
});

/**
 * Parameters that use `anyOf` or a type list, and parameters not in `required`, counted over
 * the whole schema: structured outputs allow at most 16 and 24 per request.
 */
function complexity(node: unknown): { unions: number; optional: number } {
  let unions = 0;
  let optional = 0;
  const walk = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return;
    if (Array.isArray(value)) return value.forEach(walk);
    const schema = value as Record<string, unknown>;
    if ('anyOf' in schema || Array.isArray(schema['type'])) unions += 1;
    const properties = schema['properties'] as Record<string, unknown> | undefined;
    if (properties !== undefined) {
      const required = new Set((schema['required'] as string[] | undefined) ?? []);
      optional += Object.keys(properties).filter(key => !required.has(key)).length;
    }
    Object.values(schema).forEach(walk);
  };
  walk(node);
  return { unions, optional };
}

describe('A-1: the analysis request', () => {
  it('passes the structured-outputs walker as sent for case 3, with no union and no optional parameter', () => {
    const request = buildCallAnalysisRequest({ model: 'claude-haiku-4-5-20251001', maxOutputTokens: 3000, call: callOf(CASE_3) });
    expect(request.output_config.format.type).toBe('json_schema');
    expect(schemaProblems(request.output_config.format.schema)).toEqual([]);
    expect(complexity(request.output_config.format.schema)).toEqual({ unions: 0, optional: 0 });
    expect(request.output_config.format.schema).toBe(CALL_ANALYSIS_JSON_SCHEMA);
  });

  it('numbers each line, labels it You or Them by channel, fences the transcript, and sends Haiku without effort or fallbacks', () => {
    const request = buildCallAnalysisRequest({ model: 'claude-haiku-4-5-20251001', maxOutputTokens: 3000, call: callOf(CASE_3) });
    expect(request.model).toBe('claude-haiku-4-5-20251001');
    expect(request.output_config).not.toHaveProperty('effort');
    expect(request).not.toHaveProperty('fallbacks');
    expect(request.system).toEqual([{ type: 'text', text: CALL_ANALYSIS_SYSTEM_PROMPT }]);
    const text = callAnalysisUserText(callOf(CASE_3));
    expect(text).toContain(`prompt_version: ${CALL_ANALYSIS_PROMPT_VERSION}`);
    expect(text).toContain('call_local_time: Monday 2026-10-05 10:15');
    expect(numberedTranscriptText(CASE_3.utterances).split('\n')[1]).toMatch(/^\[#2 \d+:\d{2}\] Them: Good timing/u);
    const sonnet = buildCallAnalysisRequest({ model: 'claude-sonnet-5-5', maxOutputTokens: 6000, call: callOf(CASE_3) });
    expect(sonnet.output_config.effort).toBe('low');
    expect(sonnet.fallbacks).toBe('default');
  });

  it('prices like the summary: the byte bound and max_tokens, Bedrock at its own rate, under its own provider key', () => {
    const request = buildCallAnalysisRequest({ model: 'claude-haiku-4-5-20251001', maxOutputTokens: 3000, call: callOf(CASE_3) });
    expect(callAnalysisInputTokenBound(request)).toBe(Buffer.byteLength(JSON.stringify(request), 'utf8'));
    expect(callAnalysisCeilingCents('claude-haiku-4-5-20251001', 1_000_000, 0)).toBe(100);
    expect(callAnalysisCeilingCents('claude-haiku-4-5-20251001', 1_000_000, 0, 'bedrock')).toBe(110);
    expect(callAnalysisCents('claude-haiku-4-5-20251001', { inputTokens: 3000, cachedInputTokens: 0, outputTokens: 800 }, 'bedrock')).toBe(1);
    expect(callAnalysisProviderKey('bedrock')).toBe('aws_bedrock.call_analysis');
    expect(callAnalysisProviderKey('anthropic')).toBe('anthropic_call_analysis');
  });

  it('hashes the transcript revision: stable for the same lines, different when a word moves', () => {
    const one = lines(['Y', 'Hello'], ['T', 'Hi there']);
    expect(transcriptSha256(one)).toBe(transcriptSha256(lines(['Y', 'Hello'], ['T', 'Hi there'])));
    expect(transcriptSha256(one)).not.toBe(transcriptSha256(lines(['Y', 'Hello'], ['T', 'Hi  there.'])));
    expect(transcriptSha256(one)).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe('A-1: reading an answer', () => {
  const CALL = lines(
    ['Y', 'Hi Dana, David from Callie. Can I call you Tuesday at 2?'], // 1
    ['T', 'Sure, that works. We are evaluating a couple of tools.'], // 2
    ['T', 'What does it cost? Please stop calling my cell.'], // 3
    ['Y', 'I will send pricing by Friday.'], // 4
    ['T', 'Talk to Sarah Kim, she runs maintenance.'], // 5
    ['Y', 'Okay.'], // 6
  );

  it('refuses text that is not JSON, and JSON that is not the schema', () => {
    expect(readCallAnalysisAnswer('not json', CALL)).toEqual({ ok: false, failure: 'malformed' });
    expect(readCallAnalysisAnswer(JSON.stringify({ summary: 'x' }), CALL)).toEqual({ ok: false, failure: 'schema_invalid' });
    const extra = { ...(JSON.parse(answer()) as object), extra: 1 };
    expect(readCallAnalysisAnswer(JSON.stringify(extra), CALL)).toEqual({ ok: false, failure: 'schema_invalid' });
  });

  it('keeps a verbatim Them quote and drops a paraphrase, a wrong line, and a quote from the wrong side', () => {
    const read = readCallAnalysisAnswer(
      answer({
        interest: {
          level: 'buying_signal',
          signals: [
            { kind: 'evaluation', quote: 'we are EVALUATING a couple of tools', line: 2 },
            { kind: 'evaluation', quote: 'we are comparing tools', line: 2 },
            { kind: 'demo_request', quote: 'We are evaluating', line: 3 },
            { kind: 'demo_request', quote: 'Can I call you Tuesday', line: 1 },
            { kind: 'demo_request', quote: 'Okay', line: 99 },
          ],
        },
      }),
      CALL,
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.result.interest.signals).toEqual([
      { kind: 'evaluation', ref: { line: 2, side: 'them', start: 5, end: 9, quote: 'we are EVALUATING a couple of tools' } },
    ]);
    expect(read.result.interest.level).toBe('buying_signal');
    expect(read.result.dropped).toEqual({ signals: 4 });
    expect(callAnalysisResultSchema.safeParse(read.result).success).toBe(true);
  });

  it('reads a buying signal with no surviving qualifying signal as unclear: a bare pricing question does not qualify', () => {
    const pricing = answer({
      interest: { level: 'buying_signal', signals: [{ kind: 'pricing_question', quote: 'What does it cost?', line: 3 }] },
    });
    const read = readCallAnalysisAnswer(pricing, CALL);
    expect(read.ok && read.result.interest.level).toBe('unclear');
    expect(read.ok && read.result.dropped['buying_signal']).toBe(1);
    // Q3's other reading, for the evaluation only.
    const wide = readCallAnalysisAnswer(pricing, CALL, { qualifyingSignals: ['demo_request', 'evaluation', 'adoption_question', 'pricing_question'] });
    expect(wide.ok && wide.result.interest.level).toBe('buying_signal');
    // A dropped qualifying signal does not keep the level either.
    const invented = readCallAnalysisAnswer(answer({ interest: { level: 'buying_signal', signals: [{ kind: 'demo_request', quote: 'show us a demo', line: 2 }] } }), CALL);
    expect(invented.ok && invented.result.interest.level).toBe('unclear');
  });

  it('keeps a callback David proposed only when a Them line within two lines agreed to it', () => {
    const proposed = { requested: true, exact: true, phrase: 'Can I call you Tuesday at 2', line: 1, day: 'tuesday' as const, date_text: 'Tuesday', time: '2' };
    const agreed = readCallAnalysisAnswer(answer({ callback: { ...proposed, agreed_line: 2 } }), CALL);
    expect(agreed.ok && agreed.result.callback?.agreed).toEqual({ line: 2, side: 'them', start: 5, end: 9 });
    expect(agreed.ok && agreed.result.callback?.dateText).toBe('Tuesday');
    for (const agreedLine of [0, 4, 6]) {
      const read = readCallAnalysisAnswer(answer({ callback: { ...proposed, agreed_line: agreedLine } }), CALL);
      expect(read.ok && read.result.callback).toBeNull();
      expect(read.ok && read.result.dropped['callback']).toBe(1);
    }
  });

  it('keeps day and time words only when they were said in the phrase or its agreed line', () => {
    const read = readCallAnalysisAnswer(
      answer({ callback: { requested: true, exact: true, phrase: 'Can I call you Tuesday', line: 1, agreed_line: 2, day: 'wednesday', date_text: 'Wednesday', time: '2' } }),
      CALL,
    );
    expect(read.ok && read.result.callback?.dateText).toBeNull();
    expect(read.ok && read.result.callback?.time).toBeNull();
    expect(read.ok && read.result.dropped).toMatchObject({ date_text: 1, time: 1 });
  });

  it('takes a stop, a wrong number and a referral only from Them, and a commitment only from its speaker', () => {
    const read = readCallAnalysisAnswer(
      answer({
        stop: { requested: true, scope: 'this_number', quote: 'Please stop calling my cell', line: 3 },
        referral: { given: true, name: 'Sarah Kim', role: 'runs maintenance', quote: 'Talk to Sarah Kim', line: 5 },
        commitments: [
          { speaker: 'you', quote: 'I will send pricing by Friday', line: 4, due_phrase: 'by Friday' },
          { speaker: 'them', quote: 'I will send pricing by Friday', line: 4, due_phrase: '' },
          { speaker: 'you', quote: 'Okay', line: 6, due_phrase: 'tomorrow' },
        ],
      }),
      CALL,
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.result.stop?.ref.line).toBe(3);
    expect(read.result.referral).toMatchObject({ name: 'Sarah Kim', role: 'runs maintenance' });
    expect(read.result.commitments.map(c => [c.speaker, c.ref.line, c.duePhrase])).toEqual([
      ['you', 4, 'by Friday'],
      ['you', 6, null],
    ]);
    expect(read.result.dropped).toEqual({ commitments: 1, due_phrase: 1 });

    const youStop = readCallAnalysisAnswer(answer({ stop: { requested: true, scope: 'this_number', quote: 'Okay', line: 6 } }), CALL);
    expect(youStop.ok && youStop.result.stop).toBeNull();
    const unheardName = readCallAnalysisAnswer(answer({ referral: { given: true, name: 'Bob Tran', role: '', quote: 'Talk to Sarah Kim', line: 5 } }), CALL);
    expect(unheardName.ok && unheardName.result.referral).toBeNull();
  });

  it('keeps another number only when Them said those digits', () => {
    const call = lines(['Y', 'Is this Harbor Lane?'], ['T', 'Wrong number. Harbor Lane is 617 555 0199.']);
    const said = readCallAnalysisAnswer(answer({ wrong_number: { is_wrong: true, quote: 'Wrong number', line: 2, other_number_given: '(617) 555-0199' } }), call);
    expect(said.ok && said.result.wrongNumber).toMatchObject({ otherNumberGiven: '6175550199' });
    const invented = readCallAnalysisAnswer(answer({ wrong_number: { is_wrong: true, quote: 'Wrong number', line: 2, other_number_given: '617 555 0100' } }), call);
    expect(invented.ok && invented.result.wrongNumber).toMatchObject({ otherNumberGiven: null });
  });
});
