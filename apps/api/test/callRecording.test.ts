import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedContact, seedFirm } from './support/crmSeed.ts';
import { PUBLIC_ORIGIN, startIntegrationServer, type IntegrationServer } from './support/integrationServer.ts';

/**
 * Slice C1 over HTTP: the calling status, the firm's call history, the review of a parked
 * firm, and the recording proxy — the audio read from Twilio with the account's key and
 * handed back as bytes, never a URL, to the firm's own salesperson only.
 */

const PHONE = '+14015550187';
const CALLER_ID = '+14015550100';
const AUDIO = Buffer.from('ID3 not really an mp3, but bytes all the same');

describe('calling status, history and recordings (slice C1)', () => {
  let fixture: AuthFixture;
  let server: IntegrationServer;
  let adminToken = '';
  let salespersonToken = '';
  let betaToken = '';
  let firmId = '';
  let contactId = '';
  let routeId = '';
  let identityId = '';
  let sessionId = '';
  let recordingSid = '';
  const twilioRequests: { url: string; authorization: string | undefined }[] = [];

  const command = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    commandId: randomUUID(),
    clientVersion: CURRENT_CLIENT_VERSION,
    ...extra,
  });

  async function post(path: string, token: string, body: unknown = {}) {
    const response = await fetch(`${server.origin}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) as Record<string, unknown> };
  }

  async function get(path: string, token: string) {
    const response = await fetch(`${server.origin}${path}`, { headers: { authorization: `Bearer ${token}` } });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) as Record<string, unknown> };
  }

  let voiceTwiml = '';
  async function twilio(path: string, params: Record<string, string>): Promise<number> {
    const response = await fetch(`${server.origin}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': server.twilioSign(`${PUBLIC_ORIGIN}${path}`, params),
      },
      body: new URLSearchParams(params).toString(),
    });
    const text = await response.text();
    if (path === '/integrations/twilio/voice') voiceTwiml = text;
    return response.status;
  }

  const resultOf = (answer: { body: Record<string, unknown> }): Record<string, unknown> =>
    (answer.body['result'] ?? {}) as Record<string, unknown>;

  beforeAll(async () => {
    fixture = await createAuthFixture();
    server = await startIntegrationServer(fixture, {
      callerIdE164: CALLER_ID,
      recordingHttp: async (url, init) => {
        twilioRequests.push({ url, authorization: init.headers['authorization'] });
        return await Promise.resolve(
          new Response(AUDIO, { status: 200, headers: { 'content-type': 'audio/mpeg' } }),
        );
      },
    });
    adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
    salespersonToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
    betaToken = (await issueSessionFor(fixture, fixture.beta, fixture.beta.admin)).accessToken;
    for (const [settingKey, value] of [
      ['calling_provider', { provider: 'twilio' }],
      ['telephony_budget', { dailyCeilingCents: 500, maxMinutesPerCall: 30, unitPriceMicros: 14_000 }],
    ] as const) {
      expect((await post('/settings/update', adminToken, command({ settingKey, value }))).status).toBe(200);
    }
    expect(
      (await post('/settings/update', betaToken, command({ settingKey: 'calling_provider', value: { provider: 'twilio' } }))).status,
    ).toBe(200);
    firmId = await seedFirm(fixture, {
      name: 'Lenox Test Law',
      regionCode: 'RI',
      postalCode: '02903',
      website: 'https://www.lenox-law.example',
      assignedUserId: fixture.alpha.salesperson.userId,
    });
    expect((await post('/firms/resolve-zone', adminToken, command({ firmId }))).status).toBe(200);
    contactId = await seedContact(fixture, { firmId, fullName: 'Dana Example' });
    const phone = await post(
      '/contacts/routes/add',
      salespersonToken,
      command({ firmId, contactId, routeKind: 'phone', value: PHONE, source: 'salesperson', technicalValidation: 'passed', associationConfidence: 0.95 }),
    );
    routeId = String(resultOf(phone)['id']);
    const identity = await post('/calling-identities/register', salespersonToken, command({ e164: CALLER_ID }));
    identityId = String((resultOf(identity)['identity'] as { id?: string } | undefined)?.id);
    expect((await post('/postures/allow', adminToken, command({ states: ['RI'], confirmed: true }))).status).toBe(200);

    // One placed, recorded call.
    const created = await post(
      '/calls/session',
      salespersonToken,
      command({ firmId, contactId, routeId, routeVersion: 1, callingIdentityId: identityId }),
    );
    expect(created.status, created.text).toBe(200);
    sessionId = String(resultOf(created)['sessionId']);
    const parent = `CA${randomBytes(16).toString('hex')}`;
    const identityParam = `client:${fixture.alpha.salesperson.userId}`;
    expect(
      await twilio('/integrations/twilio/voice', {
        AccountSid: server.accountSid,
        CallSid: parent,
        From: identityParam,
        Caller: identityParam,
        sessionId,
      }),
    ).toBe(200);
    expect(
      await twilio('/integrations/twilio/status', {
        AccountSid: server.accountSid,
        CallSid: parent,
        DialCallSid: `CA${randomBytes(16).toString('hex')}`,
        DialCallStatus: 'completed',
        DialCallDuration: '95',
      }),
    ).toBe(200);
    recordingSid = `RE${randomBytes(16).toString('hex')}`;
    expect(
      await twilio('/integrations/twilio/recording', {
        AccountSid: server.accountSid,
        CallSid: parent,
        RecordingSid: recordingSid,
        RecordingUrl: `https://api.twilio.com/2010-04-01/Accounts/${server.accountSid}/Recordings/${recordingSid}`,
        RecordingDuration: '90',
        RecordingStatus: 'completed',
      }),
    ).toBe(200);
  });

  afterAll(async () => {
    await server.close();
    await fixture.stop();
  });

  it('dials with answerOnBridge, so the Mac rings until the prospect answers', () => {
    expect(voiceTwiml).toContain(' answerOnBridge="true">');
    expect(voiceTwiml).toContain(`>${PHONE}</Number>`);
  });

  it('answers the calling status: attempt 2 of 4 after the placed call, the voicemail template, the caller and their own number', async () => {
    const status = await get(`/calls/calling?firmId=${firmId}`, salespersonToken);
    expect(status.status, status.text).toBe(200);
    expect(status.body).toMatchObject({
      provider: 'twilio',
      cadence: { unansweredAttempts: 1, nextAttempt: 2, limit: 4, parked: false },
      callbackNumber: CALLER_ID,
    });
    expect(String(status.body['voicemailTemplate'])).toContain('{callbackNumber}');
    expect(status.text).not.toContain(PHONE);
  });

  it('lists the firm’s calls with their duration and whether there is a recording, and nothing else', async () => {
    const history = await get(`/calls/history?firmId=${firmId}`, salespersonToken);
    expect(history.status, history.text).toBe(200);
    expect(history.body['calls']).toEqual([
      expect.objectContaining({ sessionId, firmId, status: 'completed', durationSeconds: 95, hasRecording: true }),
    ]);
    expect(history.text).not.toContain('api.twilio.com');
    expect(history.text).not.toContain(recordingSid);
    expect(history.text).not.toContain(PHONE);
  });

  it('proxies the recording from Twilio with the account key, as bytes and never a URL', async () => {
    const answer = await get(`/calls/recording?sessionId=${sessionId}`, salespersonToken);
    expect(answer.status, answer.text).toBe(200);
    expect(answer.body).toEqual({ sessionId, contentType: 'audio/mpeg', audioBase64: AUDIO.toString('base64') });
    expect(answer.text).not.toContain('twilio.com');
    expect(twilioRequests.at(-1)?.url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${server.accountSid}/Recordings/${recordingSid}.mp3`,
    );
    expect(twilioRequests.at(-1)?.authorization).toMatch(/^Basic [A-Za-z0-9+/=]+$/u);
  });

  it('answers 404 for a session of a firm that is not the caller’s, or of another workspace, without asking Twilio', async () => {
    const before = twilioRequests.length;
    // Another workspace.
    expect((await get(`/calls/recording?sessionId=${sessionId}`, betaToken)).status).toBe(404);
    expect((await get(`/calls/history?firmId=${firmId}`, betaToken)).status).toBe(404);
    // Not the calling-off answer (`not_found`), which the Mac reads as "use the phone app".
    const status = await get(`/calls/calling?firmId=${firmId}`, betaToken);
    expect(status.status).toBe(404);
    expect(status.body['error']).toBe('firm_unknown');
    // The same workspace, but the firm is now somebody else's.
    await fixture.db.query('UPDATE firms SET assigned_user_id = $2 WHERE id = $1', [firmId, fixture.alpha.admin.userId]);
    try {
      expect((await get(`/calls/recording?sessionId=${sessionId}`, salespersonToken)).status).toBe(404);
      expect((await get(`/calls/history?firmId=${firmId}`, salespersonToken)).status).toBe(404);
      // An unknown session reads the same.
      expect((await get(`/calls/recording?sessionId=${randomUUID()}`, adminToken)).status).toBe(404);
    } finally {
      await fixture.db.query('UPDATE firms SET assigned_user_id = $2 WHERE id = $1', [firmId, fixture.alpha.salesperson.userId]);
    }
    expect(twilioRequests.length).toBe(before);
  });

  it('refuses to resume a firm that is not parked', async () => {
    const resumed = await post('/calls/cadence/resume', salespersonToken, command({ firmId }));
    expect(resumed.status).toBe(409);
    expect(resumed.body['reason']).toBe('invalid_input');
  });
});
