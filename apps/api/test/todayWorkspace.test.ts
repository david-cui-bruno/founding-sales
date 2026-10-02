import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  firmBasicsAcceptedSchema,
  firmBasicsRefusalSchema,
  todayFirmResponseSchema,
  todayListResponseSchema,
} from '@fss/contracts';
import { dispatch, type ApiRequest } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, OUTDATED_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';

/**
 * Slice S2's API, through the real dispatcher with real sessions: a firm added with the
 * Add firm form is on `GET /today` at once, saying what it is missing; `POST
 * /crm/firms/basics` fixes it under one receipt and the next read says so; and `POST
 * /calls/log` takes an incoming call. The rules themselves are proved against PostgreSQL
 * in `@fss/domain` (`test/today/promptFirm.test.ts`, `test/calls/incomingCalls.test.ts`).
 *
 * Compatibility, which is the API's own business: the list's `blockers` and the card's
 * `basics` are new keys the installed desktop's `z.object` parsers strip, and `basics` is
 * absent from the first card version altogether.
 */
describe('the Today workspace (slice S2)', () => {
  let fixture: AuthFixture;
  let salespersonToken: string;
  let adminToken: string;

  const options = () => ({
    session: fixture.db,
    supportedClientVersions: fixture.deps.config.supportedClientVersions,
    sendingEnabled: false,
    auth: fixture.deps,
    upgradeUrl: 'https://callie.example/downloads/mac',
  });

  const call = async (
    method: 'GET' | 'POST',
    path: string,
    token: string | null,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const request: ApiRequest = {
      method,
      path,
      query: new URLSearchParams(),
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
      body,
    };
    const result = await dispatch(request, options());
    return { status: result.status, body: result.body as Record<string, unknown> };
  };

  const addFirm = async (name: string): Promise<string> => {
    const added = await call('POST', '/crm/firms/add', salespersonToken, {
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      firm: { name },
    });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    return (added.body['result'] as { firmId: string }).firmId;
  };

  const cardOf = async (firmId: string) => {
    const list = await call('GET', '/today', salespersonToken);
    expect(list.status).toBe(200);
    const parsed = todayListResponseSchema.parse(list.body);
    return parsed.cards.find(card => card.firmId === firmId);
  };

  beforeAll(async () => {
    fixture = await createAuthFixture();
    salespersonToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
    adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it('puts a firm added with Add firm on today’s list at once, saying what it is missing', async () => {
    const firmId = await addFirm('Juniper Test Property Management');
    expect(await cardOf(firmId)).toMatchObject({ lane: 'new_firm', blockers: ['no_phone', 'no_location'] });
  });

  it('fixes the basics under one receipt, replays a retry, and the next read can be called', async () => {
    const firmId = await addFirm('Larch Test Rentals');
    const body = {
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      firmId,
      phone: { number: '(401) 555-0145' },
      locality: 'Providence',
      regionCode: 'RI',
    };
    const first = await call('POST', '/crm/firms/basics', salespersonToken, body);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const accepted = firmBasicsAcceptedSchema.parse(first.body);
    expect(accepted.result).toMatchObject({ firmId, regionCode: 'RI', timeZone: 'America/New_York', blockers: [] });
    const replay = await call('POST', '/crm/firms/basics', salespersonToken, body);
    expect(firmBasicsAcceptedSchema.parse(replay.body)).toMatchObject({ replayed: true, result: accepted.result });
    expect((await cardOf(firmId))?.blockers).toEqual([]);

    const v2 = await call('POST', '/today/firm', salespersonToken, { firmId, cardVersion: 2 });
    expect(todayFirmResponseSchema.parse(v2.body).basics).toEqual({
      locality: 'Providence',
      regionCode: 'RI',
      timeZone: 'America/New_York',
      blockers: [],
    });
    // The first card version is the installed desktop's: no `basics` at all.
    const v1 = await call('POST', '/today/firm', salespersonToken, { firmId });
    expect(v1.status).toBe(200);
    expect(Object.keys(v1.body)).not.toContain('basics');
  });

  it('names each field at fault, refuses another salesperson’s firm and an outdated client', async () => {
    const firmId = await addFirm('Rowan Test Homes');
    const refused = await call('POST', '/crm/firms/basics', salespersonToken, {
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      firmId,
      phone: { number: '555' },
      timeZone: 'Nowhere/Special',
    });
    expect(refused.status).toBe(409);
    expect(firmBasicsRefusalSchema.parse(refused.body)).toMatchObject({
      reason: 'invalid_input',
      issues: [
        { field: 'phone', code: 'phone_invalid' },
        { field: 'timeZone', code: 'time_zone_invalid' },
      ],
    });

    const adminFirm = await call('POST', '/crm/firms/add', adminToken, {
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      firm: { name: 'Admin Test Holdings' },
    });
    const adminFirmId = (adminFirm.body['result'] as { firmId: string }).firmId;
    const notYours = await call('POST', '/crm/firms/basics', salespersonToken, {
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      firmId: adminFirmId,
      regionCode: 'RI',
    });
    expect(notYours.body['reason']).toBe('not_assigned');

    const outdated = await call('POST', '/crm/firms/basics', salespersonToken, {
      commandId: randomUUID(),
      clientVersion: OUTDATED_CLIENT_VERSION,
      firmId,
      regionCode: 'RI',
    });
    expect(outdated.status).toBe(426);
    expect((await call('POST', '/crm/firms/basics', null, {})).status).toBe(401);
    expect((await call('GET', '/crm/firms/basics', salespersonToken)).status).toBe(405);
  });

  it('logs an incoming call, and refuses one that names a placed call’s binding', async () => {
    const firmId = await addFirm('Alder Test Management');
    const logged = await call('POST', '/calls/log', salespersonToken, {
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      firmId,
      outcome: 'interested',
      direction: 'inbound',
      durationSeconds: 180,
      occurredAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      note: 'Called back from the mobile number',
    });
    expect(logged.status, JSON.stringify(logged.body)).toBe(200);
    const { rows } = await fixture.db.query<{ direction: string; duration_seconds: number }>(
      'SELECT direction, duration_seconds FROM call_logs WHERE firm_id = $1',
      [firmId],
    );
    expect(rows).toEqual([{ direction: 'inbound', duration_seconds: 180 }]);

    const unanswered = await call('POST', '/calls/log', salespersonToken, {
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      firmId,
      outcome: 'no_answer',
      direction: 'inbound',
    });
    expect(unanswered.status).toBe(409);
    expect(unanswered.body['reason']).toBe('invalid_input');
  });
});
