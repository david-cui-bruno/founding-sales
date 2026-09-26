import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatch, type ApiRequest } from '../src/server.ts';
import { createAuthFixture, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';

/**
 * The open-in-Gmail link, through the real dispatcher with real sessions. The rule has
 * its own tests against a real PostgreSQL in `@fss/domain`; this proves the wiring.
 * (The retention, deletion and departure routes this file also covered had no caller
 * and went in wave 2, S6.)
 */
describe('the attachment link', () => {
  let fixture: AuthFixture;
  let adminToken: string;

  const options = () => ({
    session: fixture.db,
    supportedClientVersions: fixture.deps.config.supportedClientVersions,
    sendingEnabled: false,
    auth: fixture.deps,
    upgradeUrl: 'https://callie.example/downloads/mac',
  });

  const post = async (path: string, token: string | null, body: unknown) => {
    const request: ApiRequest = {
      method: 'POST',
      path,
      query: new URLSearchParams(),
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
      body,
    };
    const result = await dispatch(request, options());
    return { status: result.status, body: result.body as Record<string, unknown> };
  };

  beforeAll(async () => {
    fixture = await createAuthFixture();
    adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it('refuses the link without a session', async () => {
    expect((await post('/attachments/open', null, { mailMessageId: '00000000-0000-4000-8000-000000000000' })).status).toBe(
      401,
    );
  });

  it('answers not_found for an attachment nobody may see, and never says which reason it was', async () => {
    const outcome = await post('/attachments/open', adminToken, {
      mailMessageId: '00000000-0000-4000-8000-000000000000',
    });
    expect(outcome.status).toBe(404);
    expect(outcome.body).toEqual({ error: 'not_found', message: 'No such endpoint.' });
  });
});
