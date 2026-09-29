import { FACT_KEYS, FACT_KEY_DEFINITIONS } from './facts.ts';
import type { ExtractionRequest } from './providers.ts';

/**
 * Exactly what one extraction request says: the instructions, the output schema and
 * the one message.
 *
 * In the domain package rather than beside the adapter that sends it, and the reason is
 * `pricing.ts`. The worst case a ceiling is checked against has to include everything
 * the request carries — the instructions, the fact dictionary, the serialized schema —
 * and a bound computed from a guess at their size is not a bound. `pricing.ts` measures
 * these constants at module load, so widening the system text moves the price with it
 * and cannot quietly make the ceiling authorize a call it has not priced.
 *
 * Nothing here opens a socket or reads a secret. `anthropicExtraction.ts` is the half
 * that does, and it re-exports these so its own callers need not know they moved.
 */

export const EXTRACTION_PROMPT_VERSION = 'research.extract.1';

export const EXTRACTION_SYSTEM_TEXT = [
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

export const EXTRACTION_OUTPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
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
