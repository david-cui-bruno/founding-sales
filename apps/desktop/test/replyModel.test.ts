import { describe, expect, it } from 'vitest';
import { createReplyBridge } from '../src/main/replyBridge.ts';
import { createAuthedClient } from '../src/main/authedClient.ts';
import type { HttpAnswer } from '../src/main/apiClient.ts';
import { OPERATIONS } from '../src/shared/operations.ts';
import { classifierSettingsAnswer } from './support/replyAnswers.ts';

/**
 * Slice 3a, C0, item 8: the reply-suggestions model setting, through the existing
 * `POST /replies/settings/update` command. What matters here is what is *sent* — the model
 * name and nothing else — and that a refusal is shown rather than assumed saved.
 */

const HAIKU = 'claude-haiku-4-5-20251001';

function scripted(answers: Record<string, HttpAnswer | (() => HttpAnswer)>) {
  const calls: { path: string; body: Record<string, unknown> | null }[] = [];
  const api = createAuthedClient({
    baseUrl: 'https://api.example.test/',
    clientVersion: '1.0.27',
    accessToken: async () => await Promise.resolve({ token: 'token-value', generation: 0 }),
    send: async (url, init) => {
      const path = new URL(url).pathname;
      calls.push({ path, body: init.body === undefined ? null : (JSON.parse(init.body) as Record<string, unknown>) });
      const answer = answers[path];
      return await Promise.resolve((typeof answer === 'function' ? answer() : answer) ?? { status: 404, body: { error: 'not_found' } });
    },
  });
  return { api, calls };
}

const session = {
  state: async () => await Promise.resolve({ online: true, mayMutate: true, today: { businessTimeZone: 'America/New_York' } }),
};

const accepted: HttpAnswer = { status: 200, body: { status: 'accepted', replayed: false, result: {} } };

describe('the reply-suggestions model setting', () => {
  it('declares exactly the two paths it reaches, and the update is the existing command', () => {
    expect(OPERATIONS['replies.model'].kind).toBe('read');
    expect(OPERATIONS['replies.saveModel'].kind).toBe('command');
    expect(OPERATIONS['replies.saveModel'].calls).toEqual([
      { method: 'POST', path: '/replies/settings/update' },
      { method: 'POST', path: '/replies/settings' },
    ]);
  });

  it('reads the current model without touching the lane or a card', async () => {
    const { api, calls } = scripted({ '/replies/settings': { status: 200, body: classifierSettingsAnswer({ modelName: 'claude-opus-5' }) } });
    const bridge = createReplyBridge({ api, session });
    const model = await bridge.model();
    expect(model.classifier).toEqual({ enabled: true, modelName: 'claude-opus-5', effort: 'low' });
    expect(calls.map(call => call.path)).toEqual(['/replies/settings']);
  });

  it('sends the model name and nothing else, with a command id, then reads the stored value back', async () => {
    let stored = 'claude-opus-5' as 'claude-opus-5' | typeof HAIKU;
    const { api, calls } = scripted({
      '/replies/settings/update': () => {
        stored = HAIKU;
        return accepted;
      },
      '/replies/settings': () => ({ status: 200, body: classifierSettingsAnswer({ modelName: stored, effort: 'high', dailyCallCap: 90 }) }),
    });
    const bridge = createReplyBridge({ api, session });
    const saved = await bridge.saveModel({ modelName: HAIKU });
    const update = calls.find(call => call.path === '/replies/settings/update');
    expect(Object.keys(update?.body ?? {}).sort()).toEqual(['clientVersion', 'commandId', 'modelName']);
    expect(update?.body?.['modelName']).toBe(HAIKU);
    // Never an effort or a cap: those are the server's, and this command cannot move them.
    expect(update?.body).not.toHaveProperty('effort');
    expect(update?.body).not.toHaveProperty('maxOutputTokens');
    expect(update?.body).not.toHaveProperty('dailyCallCap');
    expect(calls.map(call => call.path)).toEqual(['/replies/settings/update', '/replies/settings']);
    expect(saved.classifier?.modelName).toBe(HAIKU);
    expect(saved.notice).toBe('reply_model_saved');
  });

  it('shows a refusal, and does not claim the model changed', async () => {
    const { api } = scripted({
      '/replies/settings/update': { status: 409, body: { status: 'refused', replayed: false, reason: 'admin_only' } },
      '/replies/settings': { status: 200, body: classifierSettingsAnswer({ modelName: 'claude-opus-5' }) },
    });
    const bridge = createReplyBridge({ api, session });
    await bridge.model();
    const refused = await bridge.saveModel({ modelName: HAIKU });
    expect(refused.notice).toBe('admin_only');
    expect(refused.classifier?.modelName).toBe('claude-opus-5');
  });

  it('refuses a model the contract does not name before it asks the server', () => {
    expect(OPERATIONS['replies.saveModel'].input.safeParse({ modelName: 'claude-haiku-4-5' }).success).toBe(false);
    expect(OPERATIONS['replies.saveModel'].input.safeParse({ modelName: HAIKU, effort: 'max' }).success).toBe(false);
    expect(OPERATIONS['replies.saveModel'].input.safeParse({ modelName: 'claude-opus-5' }).success).toBe(true);
  });
});
