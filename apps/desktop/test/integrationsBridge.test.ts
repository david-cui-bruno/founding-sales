import { describe, expect, it } from 'vitest';
import { createAuthedClient } from '../src/main/authedClient.ts';
import { createAdminBridge } from '../src/main/settingsBridge.ts';
import { outboundStatusAnswer } from './support/outboundStatus.ts';

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
  const calls: { path: string; method: string; body: unknown; search: string }[] = [];
  const api = createAuthedClient({
    baseUrl: 'https://api.example.test/',
    clientVersion: '1.4.0',
    accessToken: async () => await Promise.resolve({ token: 'token-value', generation: 0 }),
    send: async (url, init) => {
      const path = new URL(url).pathname;
      calls.push({ path, method: init.method, body: init.body === undefined ? null : JSON.parse(init.body), search: new URL(url).search });
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

  it('reads what is finishing again after a paid switch is saved, so the line shows at once (P1 final round, #7)', async () => {
    const answers: Record<string, { status: number; body: unknown }> = {
      '/settings/integrations': { status: 200, body: INTEGRATIONS },
      '/settings/update': { status: 200, body: { status: 'accepted', replayed: false, result: {} } },
    };
    const { api, calls } = scripted(answers);
    const bridge = createAdminBridge({ api, session: session('admin') });
    expect((await bridge.state()).paidFinishing ?? null).toBeNull();
    answers['/settings/finishing'] = {
      status: 200,
      body: { sending: { on: true, finishing: 0 }, research: { on: true, finishing: 0 }, transcription: { on: false, finishing: 1 } },
    };
    calls.length = 0;
    const state = await bridge.saveIntegration({
      settingKey: 'call_transcription',
      value: { enabled: false, dailyCeilingCents: 50, unitPriceMicros: 4_300 },
    });
    expect(calls.map(call => call.path)).toEqual(['/settings/update', '/settings/integrations', '/settings/finishing']);
    expect(state.paidFinishing).toEqual({ transcription: { on: false, finishing: 1 } });
    // A setting that starts no paid request reads nothing more.
    calls.length = 0;
    await bridge.saveIntegration({ settingKey: 'calendar_integration', value: { integration: 'calcom' } });
    expect(calls.map(call => call.path)).toEqual(['/settings/update', '/settings/integrations']);
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

// Slice C2: the transcription row's values are asked for by name, so an S1 desktop's strict
// reader never meets them, and this one gets them.
describe('the transcription half of the integrations read', () => {
  it('asks for transcription by name and keeps what comes back', async () => {
    const withTranscription = {
      ...INTEGRATIONS,
      transcription: {
        setting: { enabled: true, dailyCeilingCents: 200, unitPriceMicros: 4_300 },
        configured: { ok: false, missing: ['api_key'] },
        spentTodayCents: 3,
      },
    };
    const admin = scripted({ '/settings/integrations': { status: 200, body: withTranscription } });
    const state = await createAdminBridge({ api: admin.api, session: session('admin') }).state();
    // Slice P1 asks for the month by name beside it.
    expect(admin.calls.find(call => call.path === '/settings/integrations')?.search).toBe('?include=transcription&include=month&include=credits&include=meeting_transcription&include=meeting_analysis&include=meeting_follow_through&include=meeting_auto_recording');
    expect(state.integrations?.transcription).toEqual(withTranscription.transcription);
  });

  it('saves the transcription setting through /settings/update', async () => {
    const { api, calls } = scripted({
      '/settings/integrations': { status: 200, body: INTEGRATIONS },
      '/settings/update': { status: 200, body: { status: 'accepted', replayed: false, result: {} } },
    });
    const bridge = createAdminBridge({ api, session: session('admin') });
    await bridge.state();
    calls.length = 0;
    await bridge.saveIntegration({ settingKey: 'call_transcription', value: { enabled: true, dailyCeilingCents: 100, unitPriceMicros: 4_300 } });
    expect(calls[0]?.body).toMatchObject({ settingKey: 'call_transcription', value: { enabled: true, dailyCeilingCents: 100 } });
  });
});

// Slice P1: the month's cash limit, asked for by name; and what is still finishing.
describe('the month and finishing halves of the administration reads', () => {
  it('asks for the month by name and keeps it, and saves the limit through /settings/update', async () => {
    const withMonth = { ...INTEGRATIONS, month: { ceilingCents: 2_500, spentMonthCents: 340 } };
    const { api, calls } = scripted({
      '/settings/integrations': { status: 200, body: withMonth },
      '/settings/update': { status: 200, body: { status: 'accepted', replayed: false, result: {} } },
    });
    const bridge = createAdminBridge({ api, session: session('admin') });
    const state = await bridge.state();
    expect(state.integrations?.month).toEqual({ ceilingCents: 2_500, spentMonthCents: 340 });
    calls.length = 0;
    await bridge.saveIntegration({ settingKey: 'monthly_cash_ceiling_cents', value: { cents: 4_000 } });
    expect(calls[0]?.body).toMatchObject({ settingKey: 'monthly_cash_ceiling_cents', value: { cents: 4_000 } });
  });

  it('reads /settings/finishing after the sending status, and keeps no line when it is not answered', async () => {
    const status = outboundStatusAnswer();
    const answered = scripted({
      '/outbound/status': { status: 200, body: status },
      '/settings/finishing': {
        status: 200,
        body: {
          sending: { on: false, finishing: 1 },
          research: { on: true, finishing: 0 },
          transcription: { on: false, finishing: 2 },
          classification: { on: false, finishing: 1 },
        },
      },
    });
    const state = await createAdminBridge({ api: answered.api, session: session('admin') }).state();
    expect(answered.calls.filter(call => call.path === '/settings/finishing').map(call => call.method)).toEqual(['GET']);
    expect(state.sendingAdmin?.finishing).toEqual({ on: false, finishing: 1 });
    // The same answer carries transcription and reply reading to Calling & calendar (fix round 2).
    expect(state.paidFinishing).toEqual({ transcription: { on: false, finishing: 2 }, classification: { on: false, finishing: 1 } });

    const older = scripted({ '/outbound/status': { status: 200, body: status } });
    const without = await createAdminBridge({ api: older.api, session: session('admin') }).state();
    expect(without.sendingAdmin).not.toBeNull();
    expect(without.sendingAdmin?.finishing).toBeNull();
    expect(without.paidFinishing).toBeNull();
  });
});
