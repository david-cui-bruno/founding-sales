import type {
  AnthropicMessageResponse,
  AnthropicMessagesTransport,
} from '@fss/domain/classification/anthropicClient.ts';
import { FACT_KEYS, FACT_KEY_DEFINITIONS } from '@fss/domain/research/facts.ts';
import type {
  ExtractionAnswer,
  ExtractionProvider,
  ExtractionRequest,
  ProviderOutcome,
} from '@fss/domain/research/providers.ts';
import { MAX_EXTRACTION_OUTPUT_TOKENS, centsOf } from '@fss/domain/research/pricing.ts';
import { EXTRACTION_PROVIDER } from '@fss/domain/research/types.ts';

/**
 * The live extraction: one model call per run, over the transport the reply
 * classifier already loads.
 *
 * The same key, through the same seam, under the same rule: `loadAnthropicTransport`
 * takes `environmentClassifierSecrets`, hands the value to the SDK's constructor, and
 * the closure holds a client. Nothing in this file is a string that could be logged.
 * `bootstrap/main.ts` reuses `classifyWorkerOptions`' result rather than reading the
 * environment twice, so there is one transport and one place the key is read.
 *
 * ## The model never supplies a quote
 *
 * The request carries the blocks **by id**, and the answer is
 * `{ selections: [{ key, sourceReference, blockId }], questions, opening }` with no
 * text field at all. The quote is looked up locally by `validateFactSelections`, so a
 * model that paraphrases, drops a negation or invents a sentence cannot be believed
 * rather than being believed wrongly. That is the single rule that makes a "fact"
 * attributable to something the firm published.
 *
 * `questions` and `opening` are the exception, and the only text a model authors that
 * reaches a person. They are stored under `research_runs.brief` with
 * `generated: true` and the desktop labels them an AI suggestion.
 *
 * ## Strict JSON output, not tool use
 *
 * `output_config.format: { type: 'json_schema' }`, which is what the classifier's
 * `ClassifierRequest` already is. The transport's parameter type is that request
 * shape, so a tool-use request would have meant widening a type in the classifier's
 * own file — a file this lane does not own — for no gain: both are the same promise,
 * that the answer validates against a schema before anybody reads it.
 *
 * ## Every way the answer is useless
 *
 * A refusal, a missing text block, text that is not JSON, JSON the schema refuses,
 * or a thrown SDK error are one outcome: `provider_failure`, with the cents the call
 * cost still recorded. The run records it and the job retries under the ladder; the
 * pages the run already fetched stay.
 */

export const EXTRACTION_PROMPT_VERSION = 'research.extract.1';

const SYSTEM_TEXT = [
  'You read text a property-management firm published on its own website and say which',
  'blocks of it support which of a fixed list of facts.',
  '',
  'Rules you must follow:',
  '',
  '1. You never write a quote. You name a block by its id, and the code looks the text',
  '   up. A block id you did not see in the input is dropped.',
  '2. You select a fact key only when a block plainly supports it. Saying nothing is',
  '   correct and expected; an empty selection list is a good answer for a thin page.',
  '3. You never infer a budget, a buying intention, a deal size or a likelihood of',
  '   purchase, and there is no key for any of them. A portal link supports a software',
  '   inference. A maintenance job posting suggests something worth discussing. Neither',
  '   proves that the firm wants to buy anything.',
  '4. You do not record a person’s name, telephone number, postal address or e-mail',
  '   address. `phone_listed` means "this block shows the firm publishes a number", not',
  '   the number; `named_role` means "this block names a person with a title".',
  '',
  'You also write two short questions a salesperson could ask this firm on a first call,',
  'and one opening sentence. Both are suggestions from you, not the firm’s words, and',
  'they are shown to the reader labelled as such. Keep each under 200 characters.',
].join('\n');

const OUTPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['selections', 'questions', 'opening'],
  properties: {
    selections: {
      type: 'array',
      maxItems: 30,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'sourceReference', 'blockId'],
        properties: {
          key: { type: 'string', enum: [...FACT_KEYS] },
          sourceReference: { type: 'string', maxLength: 500 },
          blockId: { type: 'string', maxLength: 64 },
        },
      },
    },
    questions: {
      type: 'array',
      minItems: 2,
      maxItems: 2,
      items: { type: 'string', maxLength: 200 },
    },
    opening: { type: 'string', maxLength: 300 },
  },
});

/** The dictionary and the blocks, by id. The one message a run sends. */
export function extractionUserText(request: ExtractionRequest): string {
  const dictionary = FACT_KEYS.map(key => `- ${key}: ${FACT_KEY_DEFINITIONS[key]}`).join('\n');
  const pages = request.sources
    .map(source =>
      [`SOURCE ${source.sourceReference}`, ...source.blocks.map(block => `[${block.id}] ${block.text}`)].join('\n'),
    )
    .join('\n\n');
  return [
    `Firm: ${request.firmName}`,
    '',
    'Fact keys:',
    dictionary,
    '',
    'Pages:',
    pages,
  ].join('\n');
}

interface ParsedAnswer {
  readonly selections: readonly { readonly key: string; readonly sourceReference: string; readonly blockId: string }[];
  readonly questions: readonly [string, string] | null;
  readonly opening: string | null;
}

/** The first text block's text, or null. */
function textOf(response: AnthropicMessageResponse): string | null {
  for (const block of response.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
      return block.text;
    }
  }
  return null;
}

/**
 * Read the answer, or null.
 *
 * Shape-checked here rather than trusted: `output_config` is a promise the provider
 * makes and not one this code may rely on, and a malformed answer that reached
 * `validateFactSelections` would be refused there anyway — but with a less useful
 * reason than `provider_failure`.
 */
export function parseExtractionAnswer(text: string): ParsedAnswer | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const rawSelections = record['selections'];
  if (!Array.isArray(rawSelections)) return null;

  const selections: { key: string; sourceReference: string; blockId: string }[] = [];
  for (const entry of rawSelections) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const key = row['key'];
    const sourceReference = row['sourceReference'];
    const blockId = row['blockId'];
    if (typeof key !== 'string' || typeof sourceReference !== 'string' || typeof blockId !== 'string') continue;
    // An unknown key or an unknown block is *not* dropped here: it is passed on so
    // `validateFactSelections` counts it, which is where the drift the dashboard
    // would show becomes visible.
    selections.push({ key, sourceReference, blockId });
  }

  const rawQuestions = record['questions'];
  const questions =
    Array.isArray(rawQuestions) &&
    rawQuestions.length === 2 &&
    typeof rawQuestions[0] === 'string' &&
    typeof rawQuestions[1] === 'string' &&
    rawQuestions[0].trim() !== '' &&
    rawQuestions[1].trim() !== ''
      ? ([rawQuestions[0], rawQuestions[1]] as const)
      : null;
  const rawOpening = record['opening'];
  const opening = typeof rawOpening === 'string' && rawOpening.trim() !== '' ? rawOpening : null;
  return { selections, questions, opening };
}

export interface AnthropicExtractionOptions {
  readonly transport: AnthropicMessagesTransport;
  /** `research_settings.model_name`. Must have a reviewed price row. */
  readonly modelName: string;
  readonly maxOutputTokens?: number | undefined;
}

export function anthropicExtraction(options: AnthropicExtractionOptions): ExtractionProvider {
  const maxOutputTokens = Math.min(options.maxOutputTokens ?? MAX_EXTRACTION_OUTPUT_TOKENS, MAX_EXTRACTION_OUTPUT_TOKENS);

  return {
    providerKey: EXTRACTION_PROVIDER,
    extract: async (input: ExtractionRequest): Promise<ProviderOutcome<ExtractionAnswer>> => {
      let response: AnthropicMessageResponse;
      try {
        response = await options.transport.create({
          model: options.modelName,
          max_tokens: maxOutputTokens,
          // No `cache_control`. Prompt caching pays 1.25× on the write and 0.1× on a
          // read, so it only saves money when the same prefix is sent again — and it is
          // not: every run's message is a different firm's pages, and the only constant
          // part is the system text, which is far too small to be worth a cache write.
          // Caching here was a 25% surcharge on the one thing that repeats and no
          // saving at all on the rest, and it made the priced worst case wrong.
          system: [{ type: 'text', text: SYSTEM_TEXT }],
          messages: [{ role: 'user', content: extractionUserText(input) }],
          // No `effort`: Claude Haiku 4.5 returns a 400 for it (`MODEL_CAPABILITIES`),
          // and there is no thinking to ask for. Temperature is left at the model
          // default, which for a schema-constrained extraction is the same answer.
          output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
        });
      } catch {
        // The error is deliberately not carried out of here. An SDK error message can
        // quote a request body, and a request body is a firm's published pages plus
        // the prompt — nothing secret, but nothing a ledger row needs either.
        return { ok: false, failureCode: 'provider_error', costCents: 0 };
      }

      const inputTokens = response.usage?.input_tokens ?? 0;
      const outputTokens = response.usage?.output_tokens ?? 0;
      // Read even though this request enables no caching: a category nobody reads is a
      // category the ceilings cannot see, and a cache write is *dearer* than an
      // ordinary input token. If a later change re-enables caching, or the provider
      // reports these for its own reasons, the ledger already counts them.
      const cacheWriteTokens = response.usage?.cache_creation_input_tokens ?? 0;
      const cacheReadTokens = response.usage?.cache_read_input_tokens ?? 0;
      // Priced whatever happened next: a refusal and a malformed answer both cost the
      // tokens they burned, and a ledger that only counted successes would be a budget
      // that a broken model could walk straight through.
      const costCents = centsOf(options.modelName, {
        inputTokens,
        outputTokens,
        cacheWriteTokens,
        cacheReadTokens,
      });

      if (response.stop_reason === 'refusal') return { ok: false, failureCode: 'model_refusal', costCents };
      const text = textOf(response);
      if (text === null) return { ok: false, failureCode: 'no_answer', costCents };
      const parsed = parseExtractionAnswer(text);
      if (parsed === null) return { ok: false, failureCode: 'malformed_answer', costCents };

      return {
        ok: true,
        value: {
          selections: parsed.selections,
          questions: parsed.questions,
          opening: parsed.opening,
          modelName: options.modelName,
          inputTokens,
          outputTokens,
        },
        costCents,
      };
    },
  };
}
