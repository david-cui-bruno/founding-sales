import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CLASSIFIER_MODELS } from '@fss/contracts';
import { schemaProblems } from '../support/structuredOutputsSchema.ts';
import { providerErrorOf } from '../../classification/providerError.ts';
import { anthropicReplyClassifier } from '../../classification/adapter.ts';
import {
  CLASSIFIER_SECRET_ENVIRONMENT_VARIABLES,
  ClassifierSecretError,
  describeClassifierSecrets,
  environmentClassifierSecrets,
  staticClassifierSecrets,
  type AnthropicMessageResponse,
  type AnthropicMessagesTransport,
} from '../../classification/anthropicClient.ts';
import {
  CLASSIFIER_SYSTEM_PROMPT,
  buildClassifierRequest,
  type ClassifierInput,
  type ClassifierRequest,
} from '../../classification/prompt.ts';
import { cacheablePrefix } from '../../classification/recorded.ts';
import { MODEL_SUGGESTION_JSON_SCHEMA, excerptIsVerbatim, readModelSuggestion } from '../../classification/schema.ts';
import { CLASSIFIER_PROMPT_VERSION } from '../../classification/types.ts';

/**
 * The request we actually send, the answers we refuse, and the key we never hold.
 *
 * No database and no network. The point of this file is the *shape* of one HTTP
 * body: a recorded fixture proves the code handles an answer, and only an assertion
 * on the request proves the question was the one we meant to ask.
 */

const MESSAGE: ClassifierInput = {
  subject: 'Re: hello',
  from: 'reception@northwind.example.test',
  bodyText: 'Tuesday works. Send an invite.',
  truncated: false,
  deterministicSignals: ['scheduling_language'],
};

function fakeClient(response: AnthropicMessageResponse): {
  readonly transport: AnthropicMessagesTransport;
  readonly sent: ClassifierRequest[];
} {
  const sent: ClassifierRequest[] = [];
  return {
    sent,
    transport: {
      // The classifier never counts; the seam requires it for the extraction path.
      countTokens: async () => await Promise.resolve(0),
      create: async request => {
        sent.push(request);
        return await Promise.resolve(response);
      },
    },
  };
}

const ANSWER = JSON.stringify({
  class: 'human',
  disposition: 'interested',
  confidence: 0.88,
  supporting_excerpt: 'Tuesday works.',
  callback_proposal: null,
  model_version: 'claude-opus-5',
  prompt_version: CLASSIFIER_PROMPT_VERSION,
});

function ok(text: string = ANSWER): AnthropicMessageResponse {
  return {
    model: 'claude-opus-5',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text }],
    usage: { input_tokens: 120, output_tokens: 70, cache_read_input_tokens: 1408 },
  };
}

describe('the request sent to the provider', () => {
  it('is exactly this, on Claude Opus 5', async () => {
    const client = fakeClient(ok());
    await anthropicReplyClassifier({
      transport: client.transport,
      model: 'claude-opus-5',
      effort: 'low',
      maxOutputTokens: 512,
    }).classify(MESSAGE);

    expect(client.sent.length).toBe(1);
    const request = client.sent[0] as ClassifierRequest;

    expect(request.model).toBe('claude-opus-5');
    expect(request.max_tokens).toBe(512);
    // The stable prompt first, with the cache breakpoint on it.
    expect(request.system).toEqual([
      { type: 'text', text: CLASSIFIER_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ]);
    // Structured output through `output_config.format`, never a prefill.
    expect(request.output_config).toEqual({
      effort: 'low',
      format: { type: 'json_schema', schema: MODEL_SUGGESTION_JSON_SCHEMA },
    });
    // The server-side fallback, in the scalar form and with its own beta flag.
    expect(request.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(request.fallbacks).toBe('default');
    // One volatile user turn, after the breakpoint, carrying the message and nothing
    // that would change between two identical classifications.
    expect(request.messages.length).toBe(1);
    expect(request.messages[0]?.role).toBe('user');
    const content = request.messages[0]?.content ?? '';
    expect(content).toContain(`prompt_version: ${CLASSIFIER_PROMPT_VERSION}`);
    expect(content).toContain('Tuesday works. Send an invite.');
    expect(content).toContain('deterministic_signals: scheduling_language');

    // No assistant prefill, no `thinking`, no sampling parameters: all three are
    // either rejected or deprecated on this model family.
    expect(Object.keys(request).sort()).toEqual([
      'betas',
      'fallbacks',
      'max_tokens',
      'messages',
      'model',
      'output_config',
      'system',
    ]);
  });

  it('omits the parameters Claude Haiku 4.5 rejects', async () => {
    const client = fakeClient(ok());
    await anthropicReplyClassifier({
      transport: client.transport,
      model: 'claude-haiku-4-5',
      effort: 'low',
      maxOutputTokens: 512,
    }).classify(MESSAGE);

    const request = client.sent[0] as ClassifierRequest;
    // `output_config.effort` is a 400 on Haiku 4.5, and the server-side fallback is
    // an Opus 5 feature. Neither is sent.
    expect(request.output_config.effort).toBeUndefined();
    expect(request.betas).toBeUndefined();
    expect(request.fallbacks).toBeUndefined();
    expect(request.output_config.format.type).toBe('json_schema');
  });

  it('builds a byte-identical cacheable prefix every time', () => {
    const first = buildClassifierRequest({
      model: 'claude-opus-5',
      effort: 'low',
      maxOutputTokens: 512,
      message: MESSAGE,
    });
    const second = buildClassifierRequest({
      model: 'claude-opus-5',
      effort: 'low',
      maxOutputTokens: 512,
      message: { ...MESSAGE, bodyText: 'Something else entirely.', subject: null },
    });
    // The volatile turn differs; the prefix the provider matches on does not.
    expect(first.messages[0]?.content).not.toBe(second.messages[0]?.content);
    expect(cacheablePrefix(first)).toBe(cacheablePrefix(second));
    expect(createHash('sha256').update(cacheablePrefix(first)).digest('hex')).toBe(
      createHash('sha256').update(cacheablePrefix(second)).digest('hex'),
    );
  });

  it('reports the cached tokens the answer carried', async () => {
    const client = fakeClient(ok());
    const attempt = await anthropicReplyClassifier({
      transport: client.transport,
      model: 'claude-opus-5',
      effort: 'low',
      maxOutputTokens: 512,
    }).classify(MESSAGE);
    expect(attempt.ok).toBe(true);
    expect(attempt.call.cachedInputTokens).toBe(1408);
    expect(attempt.call.inputTokens).toBe(120);
    expect(attempt.call.outputTokens).toBe(70);
  });
});

describe('an answer that cannot be used', () => {
  const classifier = (response: AnthropicMessageResponse) =>
    anthropicReplyClassifier({
      transport: fakeClient(response).transport,
      model: 'claude-opus-5',
      effort: 'low',
      maxOutputTokens: 512,
    });

  it('checks stop_reason before it reads content', async () => {
    // A refusal is an HTTP 200 whose content is not the answer. If `content` were
    // read first this would be a perfectly good-looking classification.
    const attempt = await classifier({
      model: 'claude-opus-5',
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'cyber' },
      content: [{ type: 'text', text: ANSWER }],
      usage: { input_tokens: 120, output_tokens: 0 },
    }).classify(MESSAGE);
    expect(attempt.ok).toBe(false);
    expect(attempt.call.outcome).toBe('refusal');
    expect(attempt.call.refusalCategory).toBe('cyber');
  });

  it('calls prose malformed and a bad field schema_invalid', async () => {
    const prose = await classifier(ok('Probably a person, I would say.')).classify(MESSAGE);
    expect(prose.call.outcome).toBe('malformed');

    const bad = await classifier(ok(JSON.stringify({ ...JSON.parse(ANSWER), confidence: 3 }))).classify(MESSAGE);
    expect(bad.call.outcome).toBe('schema_invalid');

    const empty = await classifier({ model: 'claude-opus-5', stop_reason: 'end_turn', content: [] }).classify(
      MESSAGE,
    );
    expect(empty.call.outcome).toBe('malformed');
  });

  it('throws away the whole answer when the quote is not in the message', async () => {
    const fabricated = JSON.stringify({
      ...(JSON.parse(ANSWER) as Record<string, unknown>),
      supporting_excerpt: 'I will get back to you next week.',
    });
    const attempt = await classifier(ok(fabricated)).classify(MESSAGE);
    expect(attempt.ok).toBe(false);
    expect(attempt.call.outcome).toBe('excerpt_unverified');
  });

  it('records a provider error without carrying the message into the record', async () => {
    const attempt = await anthropicReplyClassifier({
      transport: {
        countTokens: async () => await Promise.resolve(0),
        create: async () => {
          await Promise.resolve();
          throw new Error('400 invalid_request_error: body was reception@northwind.example.test');
        },
      },
      model: 'claude-opus-5',
      effort: 'low',
      maxOutputTokens: 512,
    }).classify(MESSAGE);
    expect(attempt.ok).toBe(false);
    expect(attempt.call.outcome).toBe('provider_error');
    // Nothing in the record can contain an address; there is nowhere to put one.
    expect(JSON.stringify(attempt.call)).not.toContain('northwind');
  });

  it('takes the served model from the response, not from the model’s own claim', async () => {
    // After a server-side fallback the answer came from a different model, and the
    // response's `model` is the only field that says so.
    const answered = JSON.stringify({ ...(JSON.parse(ANSWER) as Record<string, unknown>), model_version: 'gpt-fake' });
    const attempt = await classifier({
      model: 'claude-opus-4-8',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: answered }],
      usage: { input_tokens: 10, output_tokens: 10 },
    }).classify(MESSAGE);
    expect(attempt.ok).toBe(true);
    if (!attempt.ok) return;
    expect(attempt.suggestion.modelVersion).toBe('claude-opus-4-8');
    expect(attempt.suggestion.promptVersion).toBe(CLASSIFIER_PROMPT_VERSION);
  });
});

/** An SDK `APIError` as the SDK builds it: status, the parsed body, its own message. */
class FakeApiError extends Error {
  constructor(
    readonly status: number,
    readonly error: unknown,
  ) {
    super(`${String(status)} ${JSON.stringify(error)}`);
  }
}

describe('a request the API refuses', () => {
  const throwing = (error: unknown) =>
    anthropicReplyClassifier({
      transport: { countTokens: async () => await Promise.resolve(0), create: async () => await Promise.reject(error) },
      model: 'claude-opus-5',
      effort: 'low',
      maxOutputTokens: 512,
    });

  it('calls a 400 invalid_request_error refused before generation, with the API’s own type and message', async () => {
    const message = "output_config.format.schema: Invalid schema: Enum value 'interested' does not match declared type '['string', 'null']'";
    const attempt = await throwing(new FakeApiError(400, { type: 'error', error: { type: 'invalid_request_error', message } })).classify(MESSAGE);
    expect(attempt.ok).toBe(false);
    expect(attempt.call.outcome).toBe('provider_error');
    expect(attempt.usageReported).toBe(false);
    // Only the parameter path the API's sentence starts with (C3 follow-up review).
    expect(attempt.provider).toEqual({ status: 400, type: 'invalid_request_error', parameter: 'output_config.format.schema', refused: true });
  });

  it('never lets the message text through a provider error: no message, only a leading parameter path of a 400', async () => {
    const CANARY = 'canary reply body 2b9c please call me Tuesday';
    for (const [status, type, message] of [
      [400, 'invalid_request_error', `messages.0.content: "${CANARY}" is not allowed`],
      [400, 'invalid_request_error', `messages.0.content: "she wrote \\"${CANARY}\\"" is not allowed`],
      [400, 'invalid_request_error', `messages.0.content: ${CANARY}`],
      [400, 'invalid_request_error', `${CANARY}: bad`],
      [400, 'invalid_request_error', `bad value '${CANARY}`],
      [400, 'invalid_request_error', `${'x'.repeat(170)} ${CANARY}`],
      [413, 'request_too_large', `messages.0.content: ${CANARY}`],
      [500, 'api_error', CANARY],
    ] as const) {
      const attempt = await throwing(new FakeApiError(status, { type: 'error', error: { type, message } })).classify(MESSAGE);
      expect(JSON.stringify(attempt), `${String(status)} ${type}`).not.toContain('canary');
      expect(attempt.provider).toMatchObject({
        status,
        type,
        parameter: status === 400 && message.startsWith('messages.0.content:') ? 'messages.0.content' : null,
      });
    }
  });

  it('calls a 5xx, a 408 and a dropped connection ambiguous, and keeps no long message', async () => {
    const overloaded = await throwing(new FakeApiError(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })).classify(MESSAGE);
    expect(overloaded.provider).toMatchObject({ status: 529, refused: false });
    const timeout = await throwing(new FakeApiError(408, { type: 'error', error: { type: 'timeout_error', message: 'x' } })).classify(MESSAGE);
    expect(timeout.provider).toMatchObject({ status: 408, refused: false });
    const dropped = await throwing(new Error('socket hang up')).classify(MESSAGE);
    expect(dropped.provider).toEqual({ status: null, type: null, parameter: null, refused: false });
    expect(dropped.call.outcome).toBe('provider_error');
    expect(providerErrorOf(new FakeApiError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'm'.repeat(1000) } })).parameter).toBeNull();
  });
});

describe('the output schema the request carries', () => {
  it('keeps every structured-outputs rule, for every classifier model', () => {
    for (const model of CLASSIFIER_MODELS) {
      const request = buildClassifierRequest({ model, effort: 'low', maxOutputTokens: 512, message: MESSAGE });
      expect(schemaProblems(request.output_config.format.schema), model).toEqual([]);
    }
  });

  it('finds the shapes the API refused', () => {
    const refused = { type: 'object', additionalProperties: false, required: ['d'], properties: { d: { type: ['string', 'null'], enum: ['interested', null] } } };
    expect(schemaProblems(refused)).toContain('$.properties.d: enum beside a type list ["string","null"]');
    expect(schemaProblems({ type: 'number', minimum: 0, maximum: 1 })).toEqual(['$: minimum is not supported', '$: maximum is not supported']);
    expect(schemaProblems({ type: 'string', maxLength: 5 })).toEqual(['$: maxLength is not supported']);
    expect(schemaProblems(MODEL_SUGGESTION_JSON_SCHEMA)).toEqual([]);
  });

  it('is pinned with the prompt version: a changed schema needs a new version', () => {
    // Editing the schema without bumping CLASSIFIER_PROMPT_VERSION makes two corpora comparable
    // when they answered different questions. Update the digest and the version together.
    expect(createHash('sha256').update(JSON.stringify(MODEL_SUGGESTION_JSON_SCHEMA)).digest('hex')).toBe('3f6c46478ca448c8c45d23d5350577a68c5aa378757fed4dd15b849d96318ff1');
    expect(CLASSIFIER_PROMPT_VERSION).toBe('g7b.replies.2');
  });
});

describe('the limits the provider schema no longer states', () => {
  const base = JSON.parse(ANSWER) as Record<string, unknown>;
  const read = (patch: Record<string, unknown>) => readModelSuggestion(JSON.stringify({ ...base, ...patch }));

  it('are enforced when the answer is read', () => {
    expect(read({ confidence: 1 }).ok).toBe(true);
    expect(read({ confidence: 0 }).ok).toBe(true);
    expect(read({ confidence: 1.01 }).ok).toBe(false);
    expect(read({ confidence: -0.01 }).ok).toBe(false);
    expect(read({ supporting_excerpt: 'x'.repeat(500) }).ok).toBe(true);
    expect(read({ supporting_excerpt: 'x'.repeat(501) }).ok).toBe(false);
    const callback = (local: string, zone: string | null) => ({ callback_proposal: { local_date_time: local, time_zone: zone } });
    expect(read(callback('t'.repeat(120), null)).ok).toBe(true);
    expect(read(callback('t'.repeat(121), null)).ok).toBe(false);
    expect(read(callback('Tuesday', 'z'.repeat(64))).ok).toBe(true);
    expect(read(callback('Tuesday', 'z'.repeat(65))).ok).toBe(false);
    expect(read({ model_version: 'm'.repeat(64) }).ok).toBe(true);
    expect(read({ model_version: 'm'.repeat(65) }).ok).toBe(false);
    expect(read({ prompt_version: 'p'.repeat(65) }).ok).toBe(false);
  });
});

describe('the excerpt check', () => {
  it('accepts a quote across a hard wrap and refuses a changed word', () => {
    const body = 'We would need this to work with\nour existing procurement flow.';
    expect(excerptIsVerbatim('work with our existing procurement flow', body)).toBe(true);
    expect(excerptIsVerbatim('work with our existing purchasing flow', body)).toBe(false);
    // Case is a claim about what somebody wrote, so it is not folded.
    expect(excerptIsVerbatim('OUR EXISTING PROCUREMENT FLOW', body)).toBe(false);
    expect(excerptIsVerbatim('   ', body)).toBe(false);
  });
});

describe('the schema reader', () => {
  it('requires every field the schema declares required', () => {
    const complete = JSON.parse(ANSWER) as Record<string, unknown>;
    expect(readModelSuggestion(JSON.stringify(complete)).ok).toBe(true);
    for (const field of MODEL_SUGGESTION_JSON_SCHEMA['required'] as string[]) {
      const missing = { ...complete };
      delete missing[field];
      // Nullable is not optional: three of these may be `null` and none of them may
      // be absent, because the schema declares every one of them required.
      expect(readModelSuggestion(JSON.stringify(missing)).ok, field).toBe(false);
      const explicitNull = { ...complete, [field]: null };
      const nullable = ['disposition', 'supporting_excerpt', 'callback_proposal'];
      expect(readModelSuggestion(JSON.stringify(explicitNull)).ok, `${field} as null`).toBe(
        nullable.includes(field),
      );
    }
  });

  it('refuses a callback proposal that is not an object with a local time', () => {
    const base = JSON.parse(ANSWER) as Record<string, unknown>;
    expect(readModelSuggestion(JSON.stringify({ ...base, callback_proposal: 'tuesday' })).ok).toBe(false);
    expect(
      readModelSuggestion(JSON.stringify({ ...base, callback_proposal: { local_date_time: '', time_zone: null } })).ok,
    ).toBe(false);
    const good = readModelSuggestion(
      JSON.stringify({ ...base, callback_proposal: { local_date_time: 'next Tuesday', time_zone: 'America/New_York' } }),
    );
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.suggestion.callbackProposal).toEqual({
        localDateTime: 'next Tuesday',
        timeZone: 'America/New_York',
      });
    }
  });
});

describe('the API key', () => {
  it('is named, never held, and never printed', async () => {
    // Generated now: no literal in this repository is a credential.
    const value = createHash('sha256').update(String(Date.now())).digest('hex');
    const provider = staticClassifierSecrets({ llm_classifier_api_key: value });
    expect(await provider.read('llm_classifier_api_key')).toBe(value);
    expect(describeClassifierSecrets(provider)).toEqual({ configuredSecrets: 'llm_classifier_api_key' });
    expect(JSON.stringify(describeClassifierSecrets(provider))).not.toContain(value);
  });

  it('fails closed when the deployment was given none', async () => {
    const provider = environmentClassifierSecrets({});
    expect(provider.names()).toEqual([]);
    await expect(provider.read('llm_classifier_api_key')).rejects.toBeInstanceOf(ClassifierSecretError);
    // The error names the secret and not its value.
    await expect(provider.read('llm_classifier_api_key')).rejects.toThrow('llm_classifier_api_key');
  });

  it('reads the environment once, at construction', async () => {
    const value = createHash('sha256').update('two').digest('hex');
    const environment: Record<string, string | undefined> = {
      [CLASSIFIER_SECRET_ENVIRONMENT_VARIABLES.llm_classifier_api_key]: value,
    };
    const provider = environmentClassifierSecrets(environment);
    environment[CLASSIFIER_SECRET_ENVIRONMENT_VARIABLES.llm_classifier_api_key] = 'changed-later';
    expect(await provider.read('llm_classifier_api_key')).toBe(value);
  });
});
