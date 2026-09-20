import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CLASSIFIER_PROMPT_VERSION,
  CLASSIFIER_SECRET_ENVIRONMENT_VARIABLES,
  CLASSIFIER_SYSTEM_PROMPT,
  ClassifierSecretError,
  MODEL_SUGGESTION_JSON_SCHEMA,
  anthropicReplyClassifier,
  buildClassifierRequest,
  cacheablePrefix,
  describeClassifierSecrets,
  environmentClassifierSecrets,
  excerptIsVerbatim,
  readModelSuggestion,
  staticClassifierSecrets,
  type AnthropicMessageResponse,
  type AnthropicMessagesTransport,
  type ClassifierInput,
  type ClassifierRequest,
} from '../../classification/index.ts';

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
