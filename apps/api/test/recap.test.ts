import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callRecapResponseSchema, RECAP_SMALL_SAMPLE_BELOW } from '@fss/contracts';
import { dispatch, type ApiRequest } from '../src/server.ts';
import { localNoopSuppressionJournal } from '../src/journal/index.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';

/**
 * Slice 3a, lane C — C-3: `GET /calls/recap` through the real dispatcher. The rules are the
 * domain test's; this is the wiring: a session is needed, it is a read, it is 404 unless the
 * workspace calls through Twilio, a bad date is refused, and a day with no analysed calls is
 * a small sample rather than an error.
 */
describe('GET /calls/recap', () => {
  let fixture: AuthFixture;
  let adminToken: string;

  const options = () => ({
    session: fixture.db,
    supportedClientVersions: fixture.deps.config.supportedClientVersions,
    sendingEnabled: false,
    auth: fixture.deps,
    suppressionJournal: localNoopSuppressionJournal(),
  });
  const call = async (method: 'GET' | 'POST', path: string, token: string | null, query = '', body: unknown = undefined) => {
    const request: ApiRequest = {
      method,
      path,
      query: new URLSearchParams(query),
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
      body,
    };
    const result = await dispatch(request, options());
    return { status: result.status, body: JSON.parse(JSON.stringify(result.body ?? null)) as unknown };
  };

  beforeAll(async () => {
    fixture = await createAuthFixture();
    adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
  });
  afterAll(async () => {
    await fixture.stop();
  });

  it('needs a session, and is a read', async () => {
    expect((await call('GET', '/calls/recap', null)).status).toBe(401);
    expect((await call('POST', '/calls/recap', adminToken, '', {})).status).toBe(405);
  });

  it('is 404 until the workspace calls through Twilio, then answers a day with no calls as a small sample', async () => {
    expect((await call('GET', '/calls/recap', adminToken)).status).toBe(404);
    const saved = await call('POST', '/settings/update', adminToken, '', {
      commandId: crypto.randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      settingKey: 'calling_provider',
      value: { provider: 'twilio' },
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const recap = await call('GET', '/calls/recap', adminToken);
    expect(recap.status).toBe(200);
    expect(callRecapResponseSchema.parse(recap.body)).toMatchObject({ callsAnalysed: 0, smallSample: true, objections: [], coaching: null });
    expect(RECAP_SMALL_SAMPLE_BELOW).toBe(5);
    expect((await call('GET', '/calls/recap', adminToken, 'date=2026-10-01')).status).toBe(200);
    expect((await call('GET', '/calls/recap', adminToken, 'date=yesterday')).status).toBe(400);
  });
});
