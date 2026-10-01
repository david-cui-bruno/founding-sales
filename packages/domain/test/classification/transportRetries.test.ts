import { describe, expect, it, vi } from 'vitest';

/**
 * Slice P1: the shared Anthropic transport makes no automatic retries. The SDK's default
 * of two re-sent a paid request after a timeout or a 5xx without asking the pause switch
 * again and with no reservation for it; each caller owns its retry instead.
 */
const constructed: Record<string, unknown>[] = [];

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    readonly beta = { messages: { create: async () => await Promise.resolve({}), countTokens: async () => await Promise.resolve({ input_tokens: 1 }) } };
    constructor(configuration: Record<string, unknown>) {
      constructed.push(configuration);
    }
  },
}));

describe('the shared Anthropic transport', () => {
  it('is built with maxRetries 0', async () => {
    const { loadAnthropicTransport } = await import('../../classification/anthropicClient.ts');
    const key = ['FAKE', 'anthropic', 'key', '0123456789'].join('-');
    await loadAnthropicTransport({
      secrets: { read: async () => await Promise.resolve(key), names: () => ['llm_classifier_api_key'] },
    });
    expect(constructed).toHaveLength(1);
    expect(constructed[0]?.['maxRetries']).toBe(0);
  });
});
