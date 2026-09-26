import { REPLY_CLASSES, REPLY_DISPOSITIONS } from '@fss/contracts';
import type { CallbackProposal, ModelSuggestion } from './types.ts';

/**
 * The strict output schema, and the parser that refuses anything else
 * (specification 12.4; structured outputs through `output_config.format`).
 *
 * Two rules shape this file.
 *
 * **The schema is a constant, byte for byte.** `output_config.format` is rendered
 * into the request before `system` and before `messages`, so a schema built freshly
 * on each call — a `Set` iterated in insertion order, an object spread whose key
 * order depends on a branch — would change the cached prefix and every request would
 * be a cache miss. It is frozen, its keys are written out in order, and
 * `packages/domain/test/classification/adapter.test.ts` asserts the serialized bytes
 * are identical across two builds.
 *
 * **Parsing is separate from validating, and both fail into `uncertain`.** A model
 * may return prose around its JSON, a truncated object, or a well-formed object with
 * a confidence of 3. Each of those is a different bug and none of them may become a
 * classification: `readModelSuggestion` returns a discriminated failure the caller
 * records as the call's outcome, and the message stays exactly as the deterministic
 * layer left it.
 *
 * There is deliberately no zod schema here even though the repository has zod. The
 * JSON Schema is the thing sent to the provider, and a zod schema beside it would be
 * a second definition that can disagree with the first; the hand-written reader below
 * is checked against the same constant.
 */

/** JSON Schema draft the provider accepts: object, closed, every field required. */
export const MODEL_SUGGESTION_JSON_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'class',
    'disposition',
    'confidence',
    'supporting_excerpt',
    'callback_proposal',
    'model_version',
    'prompt_version',
  ],
  properties: {
    class: {
      type: 'string',
      enum: [...REPLY_CLASSES],
      description:
        'What kind of message this is. A suggestion only: FSS decides, and it never releases a message on this field alone.',
    },
    disposition: {
      type: ['string', 'null'],
      enum: [...REPLY_DISPOSITIONS, null],
      description: 'The standard disposition a salesperson would most likely pick, or null.',
    },
    confidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: 'How sure you are, from 0 to 1.',
    },
    supporting_excerpt: {
      type: ['string', 'null'],
      maxLength: 500,
      description:
        'A short verbatim substring of the message that supports the answer, copied exactly, or null. Never paraphrase: the text is checked against the message and a quote that is not in it is discarded.',
    },
    callback_proposal: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['local_date_time', 'time_zone'],
      properties: {
        local_date_time: {
          type: 'string',
          maxLength: 120,
          description: 'The local date and time the sender proposed, in their own words.',
        },
        time_zone: {
          type: ['string', 'null'],
          maxLength: 64,
          description: 'An IANA time zone if the message named one, otherwise null.',
        },
      },
      description: 'A callback the sender proposed. A proposal only; FSS never commits it without a person.',
    },
    model_version: { type: 'string', maxLength: 64, description: 'The model answering.' },
    prompt_version: { type: 'string', maxLength: 64, description: 'The prompt version you were given.' },
  },
});

/** The serialized schema, computed once, so the request builder concatenates nothing. */
export const MODEL_SUGGESTION_SCHEMA_JSON = JSON.stringify(MODEL_SUGGESTION_JSON_SCHEMA);

export type SuggestionReadFailure = 'malformed' | 'schema_invalid';

export type SuggestionRead =
  | { readonly ok: true; readonly suggestion: ModelSuggestion }
  | { readonly ok: false; readonly failure: SuggestionReadFailure };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readCallbackProposal(value: unknown): CallbackProposal | null | 'invalid' {
  if (value === null) return null;
  // Absent is not the same as null. Every field in the schema is `required`, so a
  // missing one is a model that did not answer the question it was asked, and the
  // reader is where that becomes `schema_invalid` rather than a quiet default.
  if (value === undefined) return 'invalid';
  if (!isRecord(value)) return 'invalid';
  const local = value['local_date_time'];
  const zone = value['time_zone'];
  if (typeof local !== 'string' || local.trim().length === 0 || local.length > 120) return 'invalid';
  if (zone !== null && zone !== undefined && (typeof zone !== 'string' || zone.length > 64)) return 'invalid';
  return { localDateTime: local.trim(), timeZone: typeof zone === 'string' && zone.length > 0 ? zone : null };
}

/**
 * Read one answer, or say which way it was wrong.
 *
 * `malformed` means nothing parseable came back — no text block, prose with no JSON,
 * a truncated object. `schema_invalid` means it parsed and did not satisfy the
 * contract above. The distinction is worth a column because the two have different
 * fixes: the first is usually `max_tokens`, the second is usually the prompt.
 */
export function readModelSuggestion(raw: string): SuggestionRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, failure: 'malformed' };
  }
  if (!isRecord(parsed)) return { ok: false, failure: 'malformed' };

  const klass = parsed['class'];
  if (typeof klass !== 'string' || !(REPLY_CLASSES as readonly string[]).includes(klass)) {
    return { ok: false, failure: 'schema_invalid' };
  }

  const disposition = parsed['disposition'];
  if (
    disposition !== null &&
    (typeof disposition !== 'string' || !(REPLY_DISPOSITIONS as readonly string[]).includes(disposition))
  ) {
    return { ok: false, failure: 'schema_invalid' };
  }

  const confidence = parsed['confidence'];
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { ok: false, failure: 'schema_invalid' };
  }

  const excerpt = parsed['supporting_excerpt'];
  if (excerpt !== null && (typeof excerpt !== 'string' || excerpt.length > 500)) {
    return { ok: false, failure: 'schema_invalid' };
  }

  const callback = readCallbackProposal(parsed['callback_proposal']);
  if (callback === 'invalid') return { ok: false, failure: 'schema_invalid' };

  const modelVersion = parsed['model_version'];
  const promptVersion = parsed['prompt_version'];
  if (typeof modelVersion !== 'string' || typeof promptVersion !== 'string') {
    return { ok: false, failure: 'schema_invalid' };
  }

  return {
    ok: true,
    suggestion: {
      class: klass as ModelSuggestion['class'],
      disposition: (disposition ?? null) as ModelSuggestion['disposition'],
      confidence,
      supportingExcerpt: typeof excerpt === 'string' && excerpt.trim().length > 0 ? excerpt : null,
      callbackProposal: callback,
      modelVersion,
      promptVersion,
    },
  };
}

/**
 * Whether the excerpt is really in the message (the brief: "verbatim substring of
 * the input, verified by the code").
 *
 * Whitespace is normalized on both sides and nothing else is. A model that reflowed
 * a quoted line across a wrap is quoting the message; a model that changed a word is
 * not, and the difference has to survive the fact that an email body arrives with
 * hard wraps the reader never saw. Case is *not* folded: "STOP" and "stop" are
 * different claims about what somebody wrote.
 */
export function excerptIsVerbatim(excerpt: string, input: string): boolean {
  const flatten = (text: string): string => text.replace(/\s+/gu, ' ').trim();
  const needle = flatten(excerpt);
  if (needle.length === 0) return false;
  return flatten(input).includes(needle);
}
