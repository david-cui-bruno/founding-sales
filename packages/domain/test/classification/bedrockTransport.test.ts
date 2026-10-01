import { describe, expect, it } from 'vitest';
import { CLASSIFIER_MODELS } from '@fss/contracts';
import { anthropicReplyClassifier } from '../../classification/adapter.ts';
import {
  BEDROCK_ANTHROPIC_VERSION,
  BedrockTransportError,
  bedrockRequestOf,
  bedrockTransport,
  type BedrockRuntimeSurface,
} from '../../classification/bedrockClient.ts';
import {
  BEDROCK_MODEL_TABLE,
  MODEL_TRANSPORT_VARIABLE,
  UnmappedBedrockModelError,
  modelProviderKey,
  readModelTransport,
  transportOfProviderKey,
  transportPrice,
} from '../../classification/modelTransport.ts';
import { classifierCallCents, classifierProviderKey } from '../../classification/pricing.ts';
import { buildClassifierRequest, type ClassifierInput, type ClassifierRequest } from '../../classification/prompt.ts';
import { providerErrorOf } from '../../classification/providerError.ts';
import { CLASSIFIER_PROMPT_VERSION, SERVER_SIDE_FALLBACK_BETA } from '../../classification/types.ts';
import { CALL_SUMMARY_MODELS, buildCallSummaryRequest, callSummaryCents, callSummaryProviderKey } from '../../calls/summaryModel.ts';
import { PRICE_CENTS_PER_MILLION, admitCall, centsOf, isPricedModel, worstCaseRunCents } from '../../research/pricing.ts';
import { CREDIT_FUNDED_PROVIDER_KINDS, providerFunding } from '../../settings/funding.ts';

/**
 * Slice BR1: the Bedrock transport behind the existing adapter boundary.
 *
 * No network and no SDK: every test hands `bedrockTransport` a fake surface, so what is
 * asserted is the transport's own behaviour — the body and model id it sends, the one
 * degradation (server-side fallbacks), the substitute count, the error shape the paid-call
 * pattern reads — and the configuration, table, price and funding facts around it.
 */

const MESSAGE: ClassifierInput = {
  subject: 'Re: hello',
  from: 'reception@northwind.example.test',
  bodyText: 'Tuesday works. Send an invite.',
  truncated: false,
  deterministicSignals: ['scheduling_language'],
};

const ANSWER = JSON.stringify({
  class: 'human',
  disposition: 'interested',
  confidence: 0.88,
  supporting_excerpt: 'Tuesday works.',
  callback_proposal: null,
  model_version: 'claude-haiku-4-5-20251001',
  prompt_version: CLASSIFIER_PROMPT_VERSION,
});

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

/** A surface that records every call and answers what it is told. */
function fakeSurface(answer: {
  readonly invoke?: () => Promise<Uint8Array>;
  readonly count?: () => Promise<number | undefined>;
}): { readonly surface: BedrockRuntimeSurface; readonly invoked: { modelId: string; body: unknown }[]; readonly counted: { modelId: string; body: unknown }[] } {
  const invoked: { modelId: string; body: unknown }[] = [];
  const counted: { modelId: string; body: unknown }[] = [];
  return {
    invoked,
    counted,
    surface: {
      invokeModel: async ({ modelId, body }) => {
        invoked.push({ modelId, body: JSON.parse(body) as unknown });
        return await (answer.invoke ?? (async () => await Promise.resolve(encode({}))))();
      },
      countTokens: async ({ modelId, body }) => {
        counted.push({ modelId, body: JSON.parse(body) as unknown });
        return await (answer.count ?? (async () => await Promise.resolve(0)))();
      },
    },
  };
}

/** An AWS SDK service exception's shape: a name, a message and the HTTP status in `$metadata`. */
function awsError(name: string, status: number, message = 'service said no'): Error {
  return Object.assign(new Error(message), { name, $metadata: { httpStatusCode: status } });
}

function opusRequest(): ClassifierRequest {
  return buildClassifierRequest({ model: 'claude-opus-5', effort: 'low', maxOutputTokens: 512, message: MESSAGE });
}

describe('FSS_MODEL_TRANSPORT selects the transport, and nothing else does', () => {
  it('is the direct API when unset or anthropic, Bedrock when bedrock, and a named problem otherwise', () => {
    expect(readModelTransport({})).toEqual({ kind: 'anthropic', problem: null });
    expect(readModelTransport({ [MODEL_TRANSPORT_VARIABLE]: ' anthropic ' })).toEqual({ kind: 'anthropic', problem: null });
    expect(readModelTransport({ [MODEL_TRANSPORT_VARIABLE]: 'bedrock' })).toEqual({ kind: 'bedrock', problem: null });
    expect(readModelTransport({ [MODEL_TRANSPORT_VARIABLE]: 'Bedrock' })).toEqual({ kind: null, problem: MODEL_TRANSPORT_VARIABLE });
    expect(readModelTransport({ [MODEL_TRANSPORT_VARIABLE]: 'bedrock,anthropic' })).toEqual({ kind: null, problem: MODEL_TRANSPORT_VARIABLE });
  });
});

describe('the one model table', () => {
  it('maps every model a classifier, summary or research request may name to a US inference profile', () => {
    const models = new Set<string>([...CLASSIFIER_MODELS, ...CALL_SUMMARY_MODELS, ...Object.keys(PRICE_CENTS_PER_MILLION)]);
    for (const model of models) {
      const row = BEDROCK_MODEL_TABLE[model];
      expect(row, model).toBeDefined();
      expect(row?.inferenceProfileId.startsWith('us.anthropic.'), model).toBe(true);
      // The profile is the foundation model behind a `us.` prefix.
      expect(row?.inferenceProfileId, model).toBe(`us.${row?.foundationModelId ?? ''}`);
    }
  });

  it('names the profiles listed in us-east-1 and the Price List rates read on 1 October 2026', () => {
    expect(BEDROCK_MODEL_TABLE['claude-haiku-4-5-20251001']).toEqual({
      inferenceProfileId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      foundationModelId: 'anthropic.claude-haiku-4-5-20251001-v1:0',
      countTokens: true,
      inputCentsPerMillion: 110,
      outputCentsPerMillion: 550,
    });
    expect(BEDROCK_MODEL_TABLE['claude-haiku-4-5']).toBe(BEDROCK_MODEL_TABLE['claude-haiku-4-5-20251001']);
    expect(BEDROCK_MODEL_TABLE['claude-opus-5']).toMatchObject({ inferenceProfileId: 'us.anthropic.claude-opus-5', countTokens: false, inputCentsPerMillion: 550, outputCentsPerMillion: 2_750 });
    expect(BEDROCK_MODEL_TABLE['claude-sonnet-5-5']).toMatchObject({ inferenceProfileId: 'us.anthropic.claude-sonnet-5-5', countTokens: false, inputCentsPerMillion: 220, outputCentsPerMillion: 1_100 });
  });

  it('prices nothing it cannot map', () => {
    expect(() => transportPrice('bedrock', 'claude-unknown-9', { input: 1, output: 1 })).toThrow(UnmappedBedrockModelError);
    expect(transportPrice('anthropic', 'claude-unknown-9', { input: 1, output: 2 })).toEqual({ input: 1, output: 2 });
  });
});

describe('the request Bedrock is sent', () => {
  it('is the built request with the model in the URL, the Bedrock version added, and every validation-bearing field intact', () => {
    const request = buildClassifierRequest({ model: 'claude-haiku-4-5-20251001', effort: 'low', maxOutputTokens: 512, message: MESSAGE });
    const prepared = bedrockRequestOf(request);
    expect(prepared.inferenceProfileId).toBe('us.anthropic.claude-haiku-4-5-20251001-v1:0');
    const { model: _model, ...rest } = request;
    expect(JSON.parse(prepared.body)).toEqual({ anthropic_version: BEDROCK_ANTHROPIC_VERSION, ...rest });
    // The strict schema and the cache breakpoint travel: Bedrock accepts both.
    expect(JSON.parse(prepared.body)).toMatchObject({
      output_config: { format: { type: 'json_schema' } },
      system: [{ cache_control: { type: 'ephemeral' } }],
    });
  });

  it('degrades server-side fallbacks explicitly: the beta flag and the parameter are removed, effort and the schema are not', () => {
    const request = opusRequest();
    // The control: the direct API's request for Opus 5 carries both.
    expect(request.betas).toEqual([SERVER_SIDE_FALLBACK_BETA]);
    expect(request.fallbacks).toBe('default');
    const body = JSON.parse(bedrockRequestOf(request).body) as Record<string, unknown>;
    expect(body).not.toHaveProperty('fallbacks');
    expect(body).not.toHaveProperty('betas');
    expect(body).not.toHaveProperty('anthropic_beta');
    expect(body['output_config']).toEqual(request.output_config);
    expect((body['output_config'] as { effort?: string }).effort).toBe('low');
  });

  it('passes any other beta flag on as anthropic_beta', () => {
    const request = { ...opusRequest(), betas: [SERVER_SIDE_FALLBACK_BETA, 'some-other-beta-2026-01-01'] };
    expect(JSON.parse(bedrockRequestOf(request).body)).toMatchObject({ anthropic_beta: ['some-other-beta-2026-01-01'] });
  });

  it('degrades the summary request for Sonnet 5.5 the same way', () => {
    const request = buildCallSummaryRequest({
      model: 'claude-sonnet-5-5',
      maxOutputTokens: 4_000,
      call: { firmName: 'Northgate', contactName: null, utterances: [{ speaker: 0, start: 0, end: 1, text: 'Hello.' }] },
    });
    expect(request.fallbacks).toBe('default');
    const body = JSON.parse(bedrockRequestOf(request).body) as Record<string, unknown>;
    expect(body).not.toHaveProperty('fallbacks');
    expect(body).not.toHaveProperty('betas');
    expect(body['output_config']).toEqual(request.output_config);
  });

  it('refuses a model with no row before any request, as a refusal the paid-call pattern settles at zero', async () => {
    const fake = fakeSurface({});
    const transport = bedrockTransport(fake.surface);
    const request = { ...opusRequest(), model: 'claude-unknown-9' };
    const thrown = await transport.create(request).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(BedrockTransportError);
    expect(providerErrorOf(thrown)).toEqual({ status: 400, type: 'model_unmapped', parameter: null, refused: true });
    expect(fake.invoked).toEqual([]);
  });
});

describe('the transport', () => {
  it('says it is Bedrock, sends to the profile and returns the body Bedrock answered', async () => {
    const answer = { model: 'claude-haiku-4-5-20251001', stop_reason: 'end_turn', content: [{ type: 'text', text: ANSWER }], usage: { input_tokens: 10, output_tokens: 5 } };
    const fake = fakeSurface({ invoke: async () => await Promise.resolve(encode(answer)) });
    const transport = bedrockTransport(fake.surface);
    expect(transport.kind).toBe('bedrock');
    const request = buildClassifierRequest({ model: 'claude-haiku-4-5', effort: 'low', maxOutputTokens: 512, message: MESSAGE });
    expect(await transport.create(request)).toEqual(answer);
    expect(fake.invoked.map(call => call.modelId)).toEqual(['us.anthropic.claude-haiku-4-5-20251001-v1:0']);
  });

  it('keeps every adapter check: a refusal is a refusal, malformed text is malformed, a bad schema is schema_invalid, a fabricated excerpt is refused', async () => {
    const cases: readonly [unknown, string][] = [
      [{ stop_reason: 'refusal', content: [{ type: 'text', text: ANSWER }], usage: { input_tokens: 1, output_tokens: 1 } }, 'refusal'],
      [{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }], usage: { input_tokens: 1, output_tokens: 1 } }, 'malformed'],
      [{ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ class: 'human' }) }], usage: { input_tokens: 1, output_tokens: 1 } }, 'schema_invalid'],
      [
        { stop_reason: 'end_turn', content: [{ type: 'text', text: ANSWER.replace('Tuesday works.', 'Monday works.') }], usage: { input_tokens: 1, output_tokens: 1 } },
        'excerpt_unverified',
      ],
      [{ stop_reason: 'end_turn', content: [{ type: 'text', text: ANSWER }], usage: { input_tokens: 1, output_tokens: 1 } }, 'accepted'],
    ];
    for (const [answer, outcome] of cases) {
      const fake = fakeSurface({ invoke: async () => await Promise.resolve(encode(answer)) });
      const classifier = anthropicReplyClassifier({ transport: bedrockTransport(fake.surface), model: 'claude-haiku-4-5', effort: 'low', maxOutputTokens: 512 });
      expect((await classifier.classify(MESSAGE)).call.outcome, outcome).toBe(outcome);
    }
  });

  it('reports AWS errors in the shape the paid-call pattern reads: 4xx refused, 5xx/408/socket/timeout ambiguous', async () => {
    const cases: readonly [unknown, ReturnType<typeof providerErrorOf>][] = [
      [
        awsError('ValidationException', 400, 'output_config.effort: Extra inputs are not permitted'),
        { status: 400, type: 'invalid_request_error', parameter: 'output_config.effort', refused: true },
      ],
      // A message that does not start with a request parameter keeps nothing (providerError.ts's rule).
      [awsError('ValidationException', 400, 'invalid beta flag'), { status: 400, type: 'invalid_request_error', parameter: null, refused: true }],
      [awsError('AccessDeniedException', 403), { status: 403, type: 'AccessDeniedException', parameter: null, refused: true }],
      [awsError('ThrottlingException', 429), { status: 429, type: 'ThrottlingException', parameter: null, refused: true }],
      [awsError('ModelTimeoutException', 408), { status: 408, type: 'ModelTimeoutException', parameter: null, refused: false }],
      [awsError('InternalServerException', 500), { status: 500, type: 'InternalServerException', parameter: null, refused: false }],
      [awsError('ServiceUnavailableException', 503), { status: 503, type: 'ServiceUnavailableException', parameter: null, refused: false }],
      [Object.assign(new Error('socket hang up'), { name: 'Error' }), { status: null, type: null, parameter: null, refused: false }],
      [Object.assign(new Error('timed out'), { name: 'TimeoutError', $metadata: {} }), { status: null, type: null, parameter: null, refused: false }],
    ];
    for (const [thrown, expected] of cases) {
      const fake = fakeSurface({ invoke: async () => await Promise.reject(thrown) });
      const caught = await bedrockTransport(fake.surface).create(opusRequest()).catch((error: unknown) => error);
      expect(caught).toBeInstanceOf(BedrockTransportError);
      expect(providerErrorOf(caught), String((thrown as Error).name)).toEqual(expected);
    }
  });

  it('never carries the request or a non-400 message in the error it throws', async () => {
    const canary = 'Tuesday works. Send an invite.';
    for (const [name, status] of [['InternalServerException', 500], ['ValidationException', 400], ['AccessDeniedException', 403]] as const) {
      const fake = fakeSurface({ invoke: async () => await Promise.reject(awsError(name, status, `boom near "${canary}"`)) });
      const caught = await bedrockTransport(fake.surface).create(opusRequest()).catch((error: unknown) => error);
      expect((caught as Error).message).not.toContain(canary);
      // Only a 400 invalid_request_error keeps its message, for the leading parameter path, and
      // providerErrorOf keeps nothing of it here because it does not start with one.
      expect(providerErrorOf(caught).parameter).toBeNull();
      if (status !== 400) expect(JSON.stringify(caught)).not.toContain(canary);
    }
  });

  it('reads a 200 whose body is not JSON as ambiguous, never as an answer', async () => {
    const fake = fakeSurface({ invoke: async () => await Promise.resolve(new TextEncoder().encode('<html>')) });
    const caught = await bedrockTransport(fake.surface).create(opusRequest()).catch((error: unknown) => error);
    expect(providerErrorOf(caught)).toEqual({ status: null, type: null, parameter: null, refused: false });
  });
});

describe('token counting', () => {
  const haiku = (): ClassifierRequest =>
    buildClassifierRequest({ model: 'claude-haiku-4-5', effort: 'low', maxOutputTokens: 512, message: MESSAGE });

  it('asks CountTokens on the foundation model (not the profile) with the exact body InvokeModel would get', async () => {
    const fake = fakeSurface({ count: async () => await Promise.resolve(192.7) });
    const transport = bedrockTransport(fake.surface);
    expect(await transport.countTokens(haiku())).toBe(192);
    expect(fake.counted).toEqual([{ modelId: 'anthropic.claude-haiku-4-5-20251001-v1:0', body: JSON.parse(bedrockRequestOf(haiku()).body) as unknown }]);
  });

  it('refuses a count that is not a number, so an absent answer is never read as "it fits"', async () => {
    for (const value of [undefined, Number.NaN, -1]) {
      const fake = fakeSurface({ count: async () => await Promise.resolve(value) });
      await expect(bedrockTransport(fake.surface).countTokens(haiku())).rejects.toThrow();
    }
    const failing = fakeSurface({ count: async () => await Promise.reject(awsError('ThrottlingException', 429)) });
    await expect(bedrockTransport(failing.surface).countTokens(haiku())).rejects.toBeInstanceOf(BedrockTransportError);
  });

  it('substitutes the body byte length, an upper bound, for a model Bedrock cannot count, and calls nothing', async () => {
    const fake = fakeSurface({});
    const request = opusRequest();
    const counted = await bedrockTransport(fake.surface).countTokens(request);
    expect(counted).toBe(Buffer.byteLength(bedrockRequestOf(request).body, 'utf8'));
    expect(fake.counted).toEqual([]);
    // Larger than any tokenizer's count of the same body: at least one byte per token.
    expect(counted).toBeGreaterThan(JSON.stringify(request.messages).length);
  });
});

describe('who pays, and at what price', () => {
  it('files Bedrock calls under aws_bedrock.*, credit-funded, and keeps the direct API keys cash', () => {
    expect(classifierProviderKey('bedrock')).toBe('aws_bedrock.classifier');
    expect(callSummaryProviderKey('bedrock')).toBe('aws_bedrock.call_summary');
    expect(modelProviderKey('extraction', 'bedrock')).toBe('aws_bedrock.extraction');
    expect(classifierProviderKey('anthropic')).toBe('anthropic_classifier');
    expect(callSummaryProviderKey('anthropic')).toBe('anthropic_call_summary');
    expect(modelProviderKey('extraction', 'anthropic')).toBe('anthropic_extraction');
    for (const purpose of ['classifier', 'call_summary', 'extraction'] as const) {
      expect(providerFunding(modelProviderKey(purpose, 'bedrock'))).toBe('credits');
      expect(providerFunding(modelProviderKey(purpose, 'anthropic'))).toBe('cash');
      expect(transportOfProviderKey(modelProviderKey(purpose, 'bedrock'))).toBe('bedrock');
      expect(transportOfProviderKey(modelProviderKey(purpose, 'anthropic'))).toBe('anthropic');
      // The ledger's key shape (`provider_ledger_provider_key_shape`).
      expect(modelProviderKey(purpose, 'bedrock')).toMatch(/^[a-z][a-z0-9_.-]{1,63}$/u);
    }
    expect(CREDIT_FUNDED_PROVIDER_KINDS).toEqual(['aws_bedrock', 'aws_transcribe']);
  });

  it('prices each Bedrock call at the Bedrock rate and each direct call at the first-party rate', () => {
    const usage = { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 };
    expect(classifierCallCents('claude-haiku-4-5', usage)).toBe(600);
    expect(classifierCallCents('claude-haiku-4-5', usage, 'bedrock')).toBe(660);
    expect(classifierCallCents('claude-opus-5', usage, 'bedrock')).toBe(3_300);
    expect(callSummaryCents('claude-haiku-4-5-20251001', usage)).toBe(600);
    expect(callSummaryCents('claude-haiku-4-5-20251001', usage, 'bedrock')).toBe(660);
    expect(callSummaryCents('claude-sonnet-5-5', usage, 'bedrock')).toBe(1_320);
    // Research, with its cache multipliers.
    expect(centsOf('claude-haiku-4-5', { inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 1_000_000, cacheReadTokens: 1_000_000 }, 'bedrock')).toBe(
      Math.ceil(110 + 110 * 1.25 + 110 * 0.1),
    );
  });

  it('bounds and admits research on the reservation’s own transport', () => {
    const input = { modelName: 'claude-haiku-4-5', maxPagesPerFirm: 4, maxPageBytes: 200_000 };
    const direct = worstCaseRunCents(input);
    const bedrock = worstCaseRunCents({ ...input, transport: 'bedrock' });
    expect(bedrock).toBeGreaterThanOrEqual(direct);
    expect(isPricedModel('claude-haiku-4-5', 'bedrock')).toBe(true);
    // A snapshot that holds exactly the direct API's cents admits there; a Bedrock snapshot
    // with the same cents is refused once the 10% dearer rate no longer fits.
    const snapshot = { modelName: 'claude-haiku-4-5', maxInputTokens: 1_000_000, maxOutputTokens: 1, cents: 101 };
    expect(admitCall(snapshot, 900_000).kind).toBe('call');
    expect(admitCall({ ...snapshot, transport: 'bedrock' }, 900_000)).toEqual({ kind: 'refuse', reason: 'cents' });
  });
});
