import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_VOICEMAIL_TEMPLATE } from '@fss/contracts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedFirm } from './support/crmSeed.ts';
import { startIntegrationServer, type IntegrationServer } from './support/integrationServer.ts';

/**
 * Slice S1 over HTTP: `GET /settings/integrations`, and the four switches David writes through
 * `POST /settings/update` reaching the routes that read them.
 */

const hex = (n: number): string => 'a1b2c3d4e5f60718'.repeat(Math.ceil(n / 16)).slice(0, n);

describe('Settings → Calling & calendar (slice S1)', () => {
  let fixture: AuthFixture;
  let server: IntegrationServer;
  let adminToken = '';
  let salespersonToken = '';
  let firmId = '';

  const command = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    commandId: randomUUID(),
    clientVersion: CURRENT_CLIENT_VERSION,
    ...extra,
  });
  async function call(origin: string, method: 'GET' | 'POST', path: string, token: string, body?: unknown) {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) as Record<string, unknown> };
  }
  const get = (path: string, token: string) => call(server.origin, 'GET', path, token);
  const update = (token: string, settingKey: string, value: unknown) =>
    call(server.origin, 'POST', '/settings/update', token, command({ settingKey, value }));

  beforeAll(async () => {
    fixture = await createAuthFixture();
    server = await startIntegrationServer(fixture);
    adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
    salespersonToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
    firmId = await seedFirm(fixture, {
      name: 'Lenox Test Law',
      regionCode: 'RI',
      postalCode: '02903',
      website: 'https://www.lenox-law.example',
      assignedUserId: fixture.alpha.salesperson.userId,
    });
  });

  afterAll(async () => {
    await server.close();
    await fixture.stop();
  });

  it('answers the defaults: phone app, calendar off, ceiling 0, the default script, credentials present, nothing spent', async () => {
    const answer = await get('/settings/integrations', salespersonToken);
    expect(answer.status, answer.text).toBe(200);
    expect(answer.body).toEqual({
      callingProvider: 'tel',
      telephonyBudget: { dailyCeilingCents: 0, maxMinutesPerCall: 30, unitPriceMicros: 14_000 },
      calendarIntegration: 'off',
      voicemailScript: DEFAULT_VOICEMAIL_TEMPLATE,
      configured: { twilioVoice: { ok: true, missing: [] }, calcom: { ok: true, missing: [] } },
      spentTodayCents: 0,
    });
  });

  it('answers the month’s cash ceiling only when asked, $25 by default, and lets only an admin change it within $0–$50 (slice P1)', async () => {
    expect((await get('/settings/integrations', adminToken)).body).not.toHaveProperty('month');
    const asked = await get('/settings/integrations?include=month', salespersonToken);
    expect(asked.status, asked.text).toBe(200);
    expect(asked.body['month']).toEqual({ ceilingCents: 2_500, spentMonthCents: 0 });

    const refused = await update(salespersonToken, 'monthly_cash_ceiling_cents', { cents: 1_000 });
    expect(refused.text).toContain('admin_only');
    for (const value of [{ cents: 5_001 }, { cents: -1 }, { cents: 12.5 }, { dollars: 10 }]) {
      const invalid = await update(adminToken, 'monthly_cash_ceiling_cents', value);
      expect(invalid.status, JSON.stringify(value)).toBeGreaterThanOrEqual(400);
      expect(invalid.text).toContain('invalid_value');
    }
    const saved = await update(adminToken, 'monthly_cash_ceiling_cents', { cents: 4_000 });
    expect(saved.status, saved.text).toBe(200);
    expect((await get('/settings/integrations?include=transcription&include=month', adminToken)).body['month']).toEqual({
      ceilingCents: 4_000,
      spentMonthCents: 0,
    });
    // Not in the settings snapshot, for the reason none of the integration keys is.
    const snapshot = await get('/settings', adminToken);
    expect(snapshot.text).not.toContain('monthly_cash_ceiling_cents');
    expect((await update(adminToken, 'monthly_cash_ceiling_cents', { cents: 2_500 })).status).toBe(200);
  });

  it('answers what is still finishing after a switch went off: GET only, two switches and two counts (slice P1)', async () => {
    const answer = await get('/settings/finishing', salespersonToken);
    expect(answer.status, answer.text).toBe(200);
    expect(answer.body).toEqual({ sending: { on: false, finishing: 0 }, research: { on: true, finishing: 0 } });
    expect((await call(server.origin, 'POST', '/settings/finishing', adminToken, {})).status).toBe(405);
  });

  it('lets any member read and only an admin write: a salesperson is refused admin_only and nothing changes', async () => {
    const refused = await update(salespersonToken, 'calling_provider', { provider: 'twilio' });
    expect(refused.status, refused.text).toBeGreaterThanOrEqual(400);
    expect(refused.text).toContain('admin_only');
    expect((await get('/settings/integrations', adminToken)).body['callingProvider']).toBe('tel');
    expect((await call(server.origin, 'POST', '/settings/integrations', adminToken, {})).status).toBe(405);
  });

  it('refuses an out-of-range budget and an empty or over-long script with invalid_value', async () => {
    for (const [key, value] of [
      ['telephony_budget', { dailyCeilingCents: 10_001, maxMinutesPerCall: 30, unitPriceMicros: 14_000 }],
      ['voicemail_script', { template: '' }],
      ['voicemail_script', { template: 'x'.repeat(2_001) }],
    ] as const) {
      const refused = await update(adminToken, key, value);
      expect(refused.text).toContain('invalid_value');
    }
  });

  it('switching calling on makes /calls/calling answer as twilio, and switching it off returns the Mac to tel:', async () => {
    expect((await get(`/calls/calling?firmId=${firmId}`, salespersonToken)).status).toBe(404);
    expect((await update(adminToken, 'telephony_budget', { dailyCeilingCents: 500, maxMinutesPerCall: 30, unitPriceMicros: 14_000 })).status).toBe(200);
    expect((await update(adminToken, 'calling_provider', { provider: 'twilio' })).status).toBe(200);
    const on = await get(`/calls/calling?firmId=${firmId}`, salespersonToken);
    expect(on.status, on.text).toBe(200);
    expect(on.body['provider']).toBe('twilio');
    expect((await get('/settings/integrations', salespersonToken)).body['callingProvider']).toBe('twilio');

    expect((await update(adminToken, 'calling_provider', { provider: 'tel' })).status).toBe(200);
    const off = await get(`/calls/calling?firmId=${firmId}`, salespersonToken);
    expect(off.status).toBe(404);
    expect(off.body['error']).toBe('not_found');
  });

  it('serves an edited voicemail script on the next /calls/calling, and the default again for a stored value that does not parse', async () => {
    await update(adminToken, 'calling_provider', { provider: 'twilio' });
    const template = 'Hi {contactFirstName}, {callerName} here for {firmName}. Call {callbackNumber}.';
    expect((await update(adminToken, 'voicemail_script', { template })).status).toBe(200);
    expect((await get(`/calls/calling?firmId=${firmId}`, salespersonToken)).body['voicemailTemplate']).toBe(template);
    expect((await get('/settings/integrations', salespersonToken)).body['voicemailScript']).toBe(template);

    await fixture.db.query(
      `UPDATE workspace_settings SET value = '{"template": 3}'::jsonb
        WHERE workspace_id = $1 AND setting_key = 'voicemail_script' AND superseded_at IS NULL`,
      [fixture.alpha.workspaceId],
    );
    expect((await get(`/calls/calling?firmId=${firmId}`, salespersonToken)).body['voicemailTemplate']).toBe(DEFAULT_VOICEMAIL_TEMPLATE);
  });

  it('reports today’s settled telephony cost in cents', async () => {
    await fixture.db.query(
      `INSERT INTO provider_ledger (workspace_id, provider_key, business_date, business_time_zone, calls, cost_cents)
       VALUES ($1, 'twilio.voice', (now() AT TIME ZONE 'America/New_York')::date, 'America/New_York', 2, 37)
       ON CONFLICT (workspace_id, provider_key, business_date) DO UPDATE SET cost_cents = 37`,
      [fixture.alpha.workspaceId],
    );
    expect((await get('/settings/integrations', salespersonToken)).body['spentTodayCents']).toBe(37);
  });

  // Sentinels are assembled at runtime so no secret-shaped literal sits in the tree or its history (gitleaks).
  const sentinel = (label: string): string => ['SENTINEL', label, '0123456789'].join('-');

  it('names missing credential fields and never a value, a length or a prefix of one', async () => {
    const sentinels = {
      account_sid: `AC${hex(32)}`,
      api_key_sid: `SK${hex(32)}`,
      api_key_secret: sentinel('api-key-secret'),
      twiml_app_sid: `AP${hex(32)}`,
      // auth_token and caller_id_e164 left out on purpose.
    };
    const calcomSentinel = sentinel('calcom-webhook-secret');
    const limited = await startIntegrationServer(fixture, {
      secretBundles: { twilioVoice: sentinels, calcom: { webhook_secret: calcomSentinel.slice(0, 4) } },
    });
    try {
      const answer = await call(limited.origin, 'GET', '/settings/integrations', adminToken);
      expect(answer.status, answer.text).toBe(200);
      expect(answer.body['configured']).toEqual({
        twilioVoice: { ok: false, missing: ['auth_token', 'caller_id_e164'] },
        calcom: { ok: false, missing: ['webhook_secret'] },
      });
      for (const secret of [...Object.values(sentinels), calcomSentinel.slice(0, 4)]) {
        expect(answer.text).not.toContain(secret);
        expect(answer.text).not.toContain(secret.slice(0, 8));
      }
    } finally {
      await limited.close();
    }

    const empty = await startIntegrationServer(fixture, { secretBundles: {} });
    try {
      const answer = await call(empty.origin, 'GET', '/settings/integrations', adminToken);
      expect((answer.body['configured'] as { twilioVoice: { missing: string[] } }).twilioVoice.missing).toHaveLength(6);
    } finally {
      await empty.close();
    }

    const complete = await startIntegrationServer(fixture, {
      secretBundles: {
        twilioVoice: { ...sentinels, auth_token: sentinel('auth-token'), caller_id_e164: '+14015550100' },
        calcom: { webhook_secret: calcomSentinel },
      },
    });
    try {
      const answer = await call(complete.origin, 'GET', '/settings/integrations', adminToken);
      expect(answer.body['configured']).toEqual({ twilioVoice: { ok: true, missing: [] }, calcom: { ok: true, missing: [] } });
      for (const secret of [...Object.values(sentinels), calcomSentinel, sentinel('auth-token'), '+14015550100']) {
        expect(answer.text).not.toContain(secret);
      }
    } finally {
      await complete.close();
    }
  });
});
