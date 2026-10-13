import { expect, it } from 'vitest';
import { createBookingInterpretationModel } from '../src/providers/bookingInterpretationModel.ts';

it('interprets bounded booking evidence over the exact existing Haiku route without tools or fallback', async () => {
  let wire: unknown;
  const model = createBookingInterpretationModel({ accountBinding: 'controlled-model-account', fundingVerifiedUntil: '2099-01-01T00:00:00Z',
    surface: { endpointId: 'bedrock-runtime.us-east-1.amazonaws.com', converse: async request => {
      wire = request;
      return { stopReason: 'end_turn', usage: { inputTokens: 40, outputTokens: 20 },
        output: { message: { role: 'assistant', content: [{ text: JSON.stringify({ intent: 'clarify', agreement: null, slot: null, substantive: null }) }] } } };
    } } });
  const result = await model.run({ text: '{"messages":[{"text":"Which timezone?"}]}', signal: new AbortController().signal });
  expect(result).toEqual({ acceptance: 'accepted', usage: { inputTokens: 40, outputTokens: 20 }, candidate: { intent: 'clarify', agreement: null, slot: null, substantive: null } });
  expect(wire).toMatchObject({ modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', inferenceConfig: { maxTokens: 1024, temperature: 0 } });
  expect(wire).not.toHaveProperty('toolConfig');
  expect(model.inputBound('{"messages":[]}')).toBeGreaterThan(100);
});
