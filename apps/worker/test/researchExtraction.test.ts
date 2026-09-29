import { describe, expect, it } from 'vitest';
import type {
  AnthropicMessageResponse,
  AnthropicMessagesTransport,
} from '@fss/domain/classification/anthropicClient.ts';
import { validateFactSelections } from '@fss/domain/research/facts.ts';
import { MAX_EXTRACTION_OUTPUT_TOKENS } from '@fss/domain/research/pricing.ts';
import { anthropicExtraction, extractionUserText, parseExtractionAnswer } from '../src/research/anthropicExtraction.ts';

/**
 * The extraction adapter, over a fake transport. Nothing here reaches Anthropic.
 *
 * The one rule that matters most is the one a test can state plainly: the request
 * carries blocks **by id** and the answer has no text field, so a model cannot supply
 * a quote. Everything else — refusals, malformed answers, the token arithmetic — is
 * about not letting a useless answer look like a fact.
 */

const sources = [
  {
    sourceReference: 'https://example.test/',
    firstParty: true,
    blocks: [
      { id: 'b1', text: 'We manage residential property for owners.' },
      { id: 'b2', text: 'Our maintenance team handles every work order.' },
    ],
  },
];
const request = { sources, firmName: 'Northwind Test Holdings' };

function transportOf(response: AnthropicMessageResponse | Error): AnthropicMessagesTransport & {
  readonly seen: unknown[];
} {
  const seen: unknown[] = [];
  return {
    seen,
    create: async body => {
      seen.push(body);
      if (response instanceof Error) throw response;
      await Promise.resolve();
      return response;
    },
  };
}

const answered = (value: unknown, usage = { input_tokens: 4_000, output_tokens: 200 }): AnthropicMessageResponse => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  usage,
});

describe('the request', () => {
  it('sends the blocks by id and the key dictionary, and never asks for a quote', async () => {
    const transport = transportOf(answered({ selections: [], questions: ['a?', 'b?'], opening: 'hello' }));
    await anthropicExtraction({ transport, modelName: 'claude-haiku-4-5' }).extract(request);
    const body = transport.seen[0] as Record<string, unknown>;
    expect(body['model']).toBe('claude-haiku-4-5');
    expect(body['max_tokens']).toBe(MAX_EXTRACTION_OUTPUT_TOKENS);
    // Claude Haiku 4.5 returns a 400 for `output_config.effort`; the request omits it.
    expect((body['output_config'] as Record<string, unknown>)['effort']).toBeUndefined();
    const content = (body['messages'] as { content: string }[])[0]?.content ?? '';
    expect(content).toContain('[b1] We manage residential property for owners.');
    expect(content).toContain('target_fit:');
    // The schema admits no text field on a selection at all.
    const schema = JSON.stringify((body['output_config'] as { format: { schema: unknown } }).format.schema);
    expect(schema).toContain('blockId');
    expect(schema).not.toContain('"quote"');
  });

  it('names the firm and every fact key exactly once', () => {
    const text = extractionUserText(request);
    expect(text).toContain('Firm: Northwind Test Holdings');
    expect([...text.matchAll(/^- target_fit:/gmu)].length).toBe(1);
  });
});

describe('the answer', () => {
  it('reads selections, the two questions and the opening, and prices the call', async () => {
    const transport = transportOf(
      answered({
        selections: [{ key: 'target_fit', sourceReference: 'https://example.test/', blockId: 'b1' }],
        questions: ['How do you take work orders?', 'Who handles them?'],
        opening: 'I saw your maintenance page.',
      }),
    );
    const outcome = await anthropicExtraction({ transport, modelName: 'claude-haiku-4-5' }).extract(request);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.selections).toEqual([
      { key: 'target_fit', sourceReference: 'https://example.test/', blockId: 'b1' },
    ]);
    expect(outcome.value.questions).toEqual(['How do you take work orders?', 'Who handles them?']);
    expect(outcome.value.inputTokens).toBe(4_000);
    // 4 000 input at 100c/M is 0.4c and 200 output at 500c/M is 0.1c: half a cent,
    // rounded up, is one.
    expect(outcome.costCents).toBe(1);
  });

  it('looks every quote up locally, so the model’s text is never the fact', async () => {
    const transport = transportOf(
      answered({
        selections: [{ key: 'target_fit', sourceReference: 'https://example.test/', blockId: 'b1' }],
        questions: ['a?', 'b?'],
        opening: 'hi',
      }),
    );
    const outcome = await anthropicExtraction({ transport, modelName: 'claude-haiku-4-5' }).extract(request);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const { facts } = validateFactSelections(outcome.value.selections, sources);
    expect(facts[0]?.quote).toBe('We manage residential property for owners.');
  });

  it('passes an unknown block on so validation counts it, rather than hiding it', async () => {
    const transport = transportOf(
      answered({
        selections: [{ key: 'target_fit', sourceReference: 'https://example.test/', blockId: 'b99' }],
        questions: ['a?', 'b?'],
        opening: 'hi',
      }),
    );
    const outcome = await anthropicExtraction({ transport, modelName: 'claude-haiku-4-5' }).extract(request);
    expect(outcome.ok && outcome.value.selections.length).toBe(1);
    const { facts, refused } = validateFactSelections(outcome.ok ? outcome.value.selections : [], sources);
    expect(facts).toEqual([]);
    expect(refused[0]?.refusal).toBe('unknown_block');
  });

  it('is a provider_failure on a refusal, no text, bad JSON, or a thrown error — and still costs', async () => {
    const cases: readonly { readonly response: AnthropicMessageResponse | Error; readonly code: string; readonly cents: number }[] = [
      {
        response: { stop_reason: 'refusal', usage: { input_tokens: 4_000, output_tokens: 10 } },
        code: 'model_refusal',
        cents: 1,
      },
      { response: { content: [], usage: { input_tokens: 4_000, output_tokens: 0 } }, code: 'no_answer', cents: 1 },
      {
        response: { content: [{ type: 'text', text: 'not json' }], usage: { input_tokens: 4_000, output_tokens: 5 } },
        code: 'malformed_answer',
        cents: 1,
      },
      { response: new Error('timeout'), code: 'provider_error', cents: 0 },
    ];
    for (const entry of cases) {
      const outcome = await anthropicExtraction({
        transport: transportOf(entry.response),
        modelName: 'claude-haiku-4-5',
      }).extract(request);
      expect(outcome.ok, entry.code).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.failureCode).toBe(entry.code);
      // A model that burned tokens and gave nothing back has spent the budget.
      expect(outcome.costCents).toBe(entry.cents);
    }
  });

  it('reads a generated pair only when both halves are there', () => {
    expect(parseExtractionAnswer('{"selections":[],"questions":["one"],"opening":"hi"}')).toMatchObject({
      questions: null,
      opening: 'hi',
    });
    expect(parseExtractionAnswer('{"selections":[],"questions":["a","b"],"opening":""}')).toMatchObject({
      questions: ['a', 'b'],
      opening: null,
    });
    expect(parseExtractionAnswer('[]')).toBeNull();
    expect(parseExtractionAnswer('{"questions":["a","b"]}')).toBeNull();
  });
});
