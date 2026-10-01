import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { anthropicReplyClassifier } from '@fss/domain/classification/adapter.ts';
import type { AnthropicMessagesTransport } from '@fss/domain/classification/anthropicClient.ts';
import { bedrockTransport } from '@fss/domain/classification/bedrockClient.ts';
import { CLASSIFIER_PROMPT_VERSION } from '@fss/domain/classification/types.ts';
import { centsOf } from '@fss/domain/research/pricing.ts';
import {
  classifyWorkerOptions,
  describeClassifier,
  modelTransportProblem,
  readModelTransportComposition,
  type TransportLoaders,
} from '../src/handlers/classify.ts';
import { readCallSummaryComposition } from '../src/handlers/callSummarize.ts';
import { composeResearch } from '../src/bootstrap/main.ts';
import { anthropicExtraction } from '../src/research/anthropicExtraction.ts';

/**
 * Slice BR1: which transport a worker builds from its environment, and the rule that there
 * is no automatic fallback from Bedrock to the direct API.
 *
 * The loaders are injected, so nothing here loads an SDK or reaches a provider: each loader
 * records that it was asked and hands back a transport this file controls.
 */

const MESSAGE = {
  subject: 'Re: hello',
  from: 'reception@northwind.example.test',
  bodyText: 'Tuesday works. Send an invite.',
  truncated: false,
  deterministicSignals: [],
};

function recordingLoaders(transports: { readonly anthropic: AnthropicMessagesTransport; readonly bedrock: AnthropicMessagesTransport }): {
  readonly loaders: TransportLoaders;
  readonly asked: string[];
  readonly regions: string[];
} {
  const asked: string[] = [];
  const regions: string[] = [];
  return {
    asked,
    regions,
    loaders: {
      anthropic: async () => {
        asked.push('anthropic');
        return await Promise.resolve(transports.anthropic);
      },
      bedrock: async ({ region }) => {
        asked.push('bedrock');
        regions.push(region);
        return await Promise.resolve(transports.bedrock);
      },
    },
  };
}

/** A direct-API transport that counts every request: the canary for a fallback. */
function directCanary(): { readonly transport: AnthropicMessagesTransport; readonly requests: () => number } {
  let requests = 0;
  return {
    requests: () => requests,
    transport: {
      kind: 'anthropic',
      countTokens: async () => {
        requests += 1;
        return await Promise.resolve(1);
      },
      create: async () => {
        requests += 1;
        return await Promise.resolve({ stop_reason: 'end_turn', content: [], usage: { input_tokens: 1, output_tokens: 1 } });
      },
    },
  };
}

/** A Bedrock transport over a surface that fails every request with a 503. */
function failingBedrock(): AnthropicMessagesTransport {
  const unavailable = Object.assign(new Error('unavailable'), { name: 'ServiceUnavailableException', $metadata: { httpStatusCode: 503 } });
  return bedrockTransport({
    invokeModel: async () => await Promise.reject(unavailable),
    countTokens: async () => await Promise.reject(unavailable),
  });
}

describe('the worker builds the transport FSS_MODEL_TRANSPORT names, and only that one', () => {
  // A generated value: nothing in this repository is a credential.
  const key = randomBytes(24).toString('base64url');

  it('builds Bedrock from AWS_REGION with no key, and never loads the direct API even when a key is present', async () => {
    const direct = directCanary();
    const recording = recordingLoaders({ anthropic: direct.transport, bedrock: failingBedrock() });
    const options = await classifyWorkerOptions(
      { FSS_MODEL_TRANSPORT: 'bedrock', AWS_REGION: 'us-east-1', FSS_LLM_CLASSIFIER_API_KEY: key },
      undefined,
      recording.loaders,
    );
    expect(recording.asked).toEqual(['bedrock']);
    expect(recording.regions).toEqual(['us-east-1']);
    expect(options?.transport.kind).toBe('bedrock');
    expect(describeClassifier(options)).toEqual({ classifier_configured: true, classifier_enabled: true, model_transport: 'bedrock' });
    expect(JSON.stringify(describeClassifier(options))).not.toContain(key);

    const keyless = await classifyWorkerOptions({ FSS_MODEL_TRANSPORT: 'bedrock', AWS_REGION: 'us-east-1' }, undefined, recording.loaders);
    expect(keyless?.transport.kind).toBe('bedrock');
  });

  it('has no automatic fallback: a Bedrock failure is the paid-call pattern’s ambiguous failure, and the direct API is never asked', async () => {
    const direct = directCanary();
    const recording = recordingLoaders({ anthropic: direct.transport, bedrock: failingBedrock() });
    const options = await classifyWorkerOptions(
      { FSS_MODEL_TRANSPORT: 'bedrock', AWS_REGION: 'us-east-1', FSS_LLM_CLASSIFIER_API_KEY: key },
      undefined,
      recording.loaders,
    );
    if (options === undefined) throw new Error('no options');
    const classifier = anthropicReplyClassifier({ transport: options.transport, model: 'claude-haiku-4-5', effort: 'low', maxOutputTokens: 512 });
    const attempt = await classifier.classify(MESSAGE);
    expect(attempt.call.outcome).toBe('provider_error');
    expect(attempt.provider).toEqual({ status: 503, type: 'ServiceUnavailableException', parameter: null, refused: false });
    expect(attempt.usageReported).toBe(false);
    // The research count fails too, and is not answered by anybody else.
    await expect(options.transport.countTokens({ ...MESSAGE_REQUEST })).rejects.toThrow();
    expect(direct.requests()).toBe(0);
    expect(recording.asked).toEqual(['bedrock']);
  });

  it('builds the direct API from the key when unset or anthropic, as before', async () => {
    const direct = directCanary();
    for (const environment of [{ FSS_LLM_CLASSIFIER_API_KEY: key }, { FSS_LLM_CLASSIFIER_API_KEY: key, FSS_MODEL_TRANSPORT: 'anthropic' }]) {
      const recording = recordingLoaders({ anthropic: direct.transport, bedrock: failingBedrock() });
      const options = await classifyWorkerOptions(environment, undefined, recording.loaders);
      expect(recording.asked).toEqual(['anthropic']);
      expect(options?.transport.kind).toBe('anthropic');
    }
  });

  it('builds nothing, and names why, for a bad value, a Bedrock worker with no region, or a direct worker with no key', async () => {
    const recording = recordingLoaders({ anthropic: directCanary().transport, bedrock: failingBedrock() });
    const cases: readonly [Readonly<Record<string, string>>, string][] = [
      [{ FSS_MODEL_TRANSPORT: 'vertex', FSS_LLM_CLASSIFIER_API_KEY: key, AWS_REGION: 'us-east-1' }, 'FSS_MODEL_TRANSPORT'],
      [{ FSS_MODEL_TRANSPORT: 'bedrock', FSS_LLM_CLASSIFIER_API_KEY: key }, 'AWS_REGION'],
      [{ FSS_MODEL_TRANSPORT: 'anthropic', AWS_REGION: 'us-east-1' }, 'anthropic:absent'],
      [{}, 'anthropic:absent'],
    ];
    for (const [environment, problem] of cases) {
      expect(await readModelTransportComposition(environment, recording.loaders)).toEqual({ transport: null, problem });
      expect(modelTransportProblem(environment)).toBe(problem);
      expect(await classifyWorkerOptions(environment, undefined, recording.loaders)).toBeUndefined();
    }
    // Not one of them loaded anything, and in particular a bad Bedrock configuration did not
    // become the direct API.
    expect(recording.asked).toEqual([]);
  });
});

describe('the transport decides the key and the price of every model call the worker composes', () => {
  const bedrock = bedrockTransport({ invokeModel: async () => await Promise.resolve(new Uint8Array()), countTokens: async () => await Promise.resolve(1) });
  const classifier = { transport: bedrock, processEnabled: true } as const;

  it('hands the summary composition the transport kind', () => {
    expect(readCallSummaryComposition(classifier, {}).options?.transport).toBe('bedrock');
    expect(readCallSummaryComposition({ transport: directCanary().transport, processEnabled: true }, {}).options?.transport).toBe('anthropic');
  });

  it('files research extraction under aws_bedrock.extraction and prices it at the Bedrock rate', async () => {
    expect(composeResearch(classifier).extraction?.providerKey).toBe('aws_bedrock.extraction');
    expect(composeResearch({ transport: directCanary().transport, processEnabled: true }).extraction?.providerKey).toBe('anthropic_extraction');

    const usage = { input_tokens: 400_000, output_tokens: 20_000 };
    const answering = bedrockTransport({
      invokeModel: async () =>
        await Promise.resolve(
          new TextEncoder().encode(
            JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ selections: [], questions: null, opening: null }) }], usage }),
          ),
        ),
      countTokens: async () => await Promise.resolve(1),
    });
    const outcome = await anthropicExtraction({ transport: answering }).extract({
      sources: [{ sourceReference: 'https://northgate.example.test/', blocks: [{ id: 'b1', text: 'We manage 40 buildings.' }] }],
      firmName: 'Northgate',
      modelName: 'claude-haiku-4-5',
      maxOutputTokens: 600,
    });
    const bedrockCents = centsOf('claude-haiku-4-5', { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }, 'bedrock');
    expect(outcome.costCents).toBe(bedrockCents);
    expect(bedrockCents).toBeGreaterThan(centsOf('claude-haiku-4-5', { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }));
  });
});

const MESSAGE_REQUEST = {
  model: 'claude-haiku-4-5',
  max_tokens: 16,
  system: [{ type: 'text' as const, text: `prompt ${CLASSIFIER_PROMPT_VERSION}` }],
  messages: [{ role: 'user' as const, content: 'hello' }],
  output_config: { format: { type: 'json_schema' as const, schema: { type: 'object' } } },
};
