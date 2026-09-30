import { describe, expect, it } from 'vitest';
import { createAuthedClient } from '../src/main/authedClient.ts';
import { createAdminBridge } from '../src/main/settingsBridge.ts';

/** The bridge half of Settings → Calling & calendar (slice S1). Fictional data only. */

const INTEGRATIONS = {
  callingProvider: 'tel',
  telephonyBudget: { dailyCeilingCents: 500, maxMinutesPerCall: 30, unitPriceMicros: 14_000 },
  calendarIntegration: 'off',
  voicemailScript: 'Hi {contactFirstName}.',
  configured: { twilioVoice: { ok: true, missing: [] }, calcom: { ok: false, missing: ['webhook_secret'] } },
  spentTodayCents: 0,
};

function scripted(answers: Record<string, { status: number; body: unknown }>) {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const api = createAuthedClient({
    baseUrl: 'https://api.example.test/',
    clientVersion: '1.4.0',
    accessToken: async () => await Promise.resolve({ token: 'token-value', generation: 0 }),
    send: async (url, init) => {
      const path = new URL(url).pathname;
      calls.push({ path, method: init.method, body: init.body === undefined ? null : JSON.parse(init.body) });
      return await Promise.resolve(answers[path] ?? { status: 404, body: { error: 'not_found' } });
    },
  });
  return { api, calls };
}

const session = (role: 'admin' | 'salesperson') => ({
  state: async () => await Promise.resolve({ online: true, mayMutate: true, device: { role } }),
});

describe('the integrations half of the administration bridge', () => {
  it('reads /settings/integrations for an admin and never for a salesperson', async () => {
    const admin = scripted({ '/settings/integrations': { status: 200, body: INTEGRATIONS } });
    const state = await createAdminBridge({ api: admin.api, session: session('admin') }).state();
    expect(state.integrations).toEqual(INTEGRATIONS);
    expect(admin.calls.filter(call => call.path === '/settings/integrations').map(call => call.method)).toEqual(['GET']);

    const salesperson = scripted({ '/settings/integrations': { status: 200, body: INTEGRATIONS } });
    const other = await createAdminBridge({ api: salesperson.api, session: session('salesperson') }).state();
    expect(other.integrations).toBeNull();
    expect(salesperson.calls.map(call => call.path)).not.toContain('/settings/integrations');
  });

  it('keeps a failed read as null, so the section says it could not read rather than showing switches', async () => {
    const { api } = scripted({});
    const state = await createAdminBridge({ api, session: session('admin') }).state();
    expect(state.integrations).toBeNull();
  });

  it('saves with /settings/update, then reads the integrations again', async () => {
    const { api, calls } = scripted({
      '/settings/integrations': { status: 200, body: INTEGRATIONS },
      '/settings/update': { status: 200, body: { status: 'accepted', replayed: false, result: {} } },
    });
    const bridge = createAdminBridge({ api, session: session('admin') });
    await bridge.state();
    calls.length = 0;
    const state = await bridge.saveIntegration({ settingKey: 'calling_provider', value: { provider: 'twilio' } });
    expect(calls.map(call => call.path)).toEqual(['/settings/update', '/settings/integrations']);
    expect(calls[0]?.body).toMatchObject({ settingKey: 'calling_provider', value: { provider: 'twilio' } });
    expect(state.integrationsNotice).toBeNull();
  });

  it('keeps a refusal on the section as its code and leaves the page notice alone', async () => {
    const refused = scripted({
      '/settings/integrations': { status: 200, body: INTEGRATIONS },
      '/settings/update': { status: 409, body: { status: 'refused', replayed: false, reason: 'admin_only' } },
    });
    const bridge = createAdminBridge({ api: refused.api, session: session('admin') });
    const before = await bridge.state();
    const state = await bridge.saveIntegration({ settingKey: 'calendar_integration', value: { integration: 'calcom' } });
    expect(state.integrationsNotice).toBe('admin_only');
    // The page banner is whatever it was: the refusal belongs to the section's row.
    expect(state.notice).toBe(before.notice);
  });
});
