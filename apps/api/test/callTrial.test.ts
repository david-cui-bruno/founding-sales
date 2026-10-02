import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CALL_TRIAL_DEFAULT_SINCE, callTrialResponseSchema } from '@fss/contracts';
import { dispatch, type ApiRequest } from '../src/server.ts';
import { localNoopSuppressionJournal } from '../src/journal/index.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';

/**
 * Slice S3T: `GET /calls/trial` through the real dispatcher. The rules are the domain test's
 * (`packages/domain/test/calls/trialReport.test.ts`); this is the wiring: a session is
 * needed, it is a read, it is 404 unless the workspace calls through Twilio (the desktop
 * hides the section then), `since` defaults to the 3a release, and a bad `since` is refused.
 */
describe('GET /calls/trial', () => {
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
    expect((await call('GET', '/calls/trial', null)).status).toBe(401);
    expect((await call('POST', '/calls/trial', adminToken, '', {})).status).toBe(405);
  });

  it('is 404 until the workspace calls through Twilio, then answers with nothing counted yet', async () => {
    expect((await call('GET', '/calls/trial', adminToken)).status).toBe(404);
    const saved = await call('POST', '/settings/update', adminToken, '', {
      commandId: crypto.randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      settingKey: 'calling_provider',
      value: { provider: 'twilio' },
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const trial = await call('GET', '/calls/trial', adminToken);
    expect(trial.status).toBe(200);
    expect(callTrialResponseSchema.parse(trial.body)).toMatchObject({
      since: CALL_TRIAL_DEFAULT_SINCE,
      progress: { answered: 0, eligible: 0, analysed: 0, fullyDecided: 0 },
      heldButExcluded: 0,
      types: [],
    });
    const later = await call('GET', '/calls/trial', adminToken, 'since=2026-10-05T00:00:00Z');
    expect(later.status).toBe(200);
    expect(callTrialResponseSchema.parse(later.body).since).toBe('2026-10-05T00:00:00.000Z');
    expect((await call('GET', '/calls/trial', adminToken, 'since=yesterday')).status).toBe(400);
  });
});
