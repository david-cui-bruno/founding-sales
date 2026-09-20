import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_ALERT_THRESHOLDS, SETTING_KEYS } from '@fss/contracts';
import { dispatch, type ApiRequest } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';

/**
 * The administration surface, through the real dispatcher with real sessions
 * (specification 10.1, 13.3, 13.4, 16.2, 8.1, Appendix F).
 *
 * The domain tests prove the rules against a real PostgreSQL. What is proved here is
 * the surface: that the endpoints are mounted, that a salesperson is refused the ones
 * that are admin-only, that a settings command answers through a command receipt, and
 * that a replay of that command returns the original version rather than writing a
 * second one.
 */
describe('the administration surface', () => {
  let fixture: AuthFixture;
  let adminToken: string;
  let salespersonToken: string;

  const options = (sendingEnabled = false) => ({
    session: fixture.db,
    supportedClientVersions: fixture.deps.config.supportedClientVersions,
    sendingEnabled,
    expectedSystemGeneration: null,
    auth: fixture.deps,
    upgradeUrl: 'https://callie.example/downloads/mac',
  });

  const call = async (
    method: string,
    path: string,
    token: string | null,
    body?: unknown,
    sendingEnabled = false,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const request: ApiRequest = {
      method,
      path,
      query: new URLSearchParams(),
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
      body,
    };
    const result = await dispatch(request, options(sendingEnabled));
    return { status: result.status, body: result.body as Record<string, unknown> };
  };

  const command = (extra: Record<string, unknown>): Record<string, unknown> => ({
    commandId: randomUUID(),
    clientVersion: CURRENT_CLIENT_VERSION,
    ...extra,
  });

  beforeAll(async () => {
    fixture = await createAuthFixture();
    adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
    salespersonToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it('refuses every administration path without a session', async () => {
    for (const [method, path] of [
      ['GET', '/settings'],
      ['POST', '/settings/update'],
      ['POST', '/settings/history'],
      ['POST', '/dashboard'],
      ['GET', '/diagnostics'],
      ['POST', '/pipeline/board'],
      ['POST', '/pipeline/stages/create'],
    ] as const) {
      const answer = await call(method, path, null, {});
      expect(answer.status, path).toBe(401);
    }
  });

  it('refuses the wrong method rather than falling through to another module', async () => {
    expect((await call('DELETE', '/settings', adminToken)).status).toBe(405);
    expect((await call('GET', '/dashboard', adminToken)).status).toBe(405);
    expect((await call('POST', '/diagnostics', adminToken, {})).status).toBe(405);
    // A mistyped settings path is nobody's, not "wrong method".
    expect((await call('POST', '/settings/updates', adminToken, {})).status).toBe(404);
  });

  it('answers every slice at its default, with the list of what lives elsewhere', async () => {
    const answer = await call('GET', '/settings', salespersonToken);
    expect(answer.status).toBe(200);
    const settings = answer.body['settings'] as readonly { settingKey: string; version: number }[];
    expect(settings.map(entry => entry.settingKey)).toEqual([...SETTING_KEYS]);
    expect(settings.every(entry => entry.version === 0)).toBe(true);
    const elsewhere = answer.body['elsewhere'] as readonly { path: string }[];
    expect(elsewhere.map(entry => entry.path)).toContain('/research/config');
    expect(elsewhere.map(entry => entry.path)).toContain('/postures/calling-window');
  });

  it('shows both halves of the production sending switch', async () => {
    // 16.2 is two switches ANDed. With the deployment flag off, an admin enabling
    // sending changes the admin half and not the effective answer.
    const off = await call('GET', '/settings', adminToken);
    expect(off.body['deploymentSendingEnabled']).toBe(false);
    expect(off.body['effectiveSendingEnabled']).toBe(false);

    const enabled = await call(
      'POST',
      '/settings/update',
      adminToken,
      command({
        settingKey: 'sending_enabled',
        value: { enabled: true, releaseGateReference: 'rehearsal-2026-09-20' },
        changeNote: 'the gate passed',
      }),
      true,
    );
    expect(enabled.status).toBe(200);
    expect(enabled.body['status']).toBe('accepted');

    const stillOff = await call('GET', '/settings', adminToken);
    expect(stillOff.body['deploymentSendingEnabled']).toBe(false);
    expect(stillOff.body['effectiveSendingEnabled']).toBe(false);

    const both = await call('GET', '/settings', adminToken, undefined, true);
    expect(both.body['deploymentSendingEnabled']).toBe(true);
    expect(both.body['effectiveSendingEnabled']).toBe(true);
  });

  it('refuses a settings command from a salesperson and accepts one from an admin', async () => {
    const refused = await call(
      'POST',
      '/settings/update',
      salespersonToken,
      command({
        settingKey: 'alert_thresholds',
        value: { ...DEFAULT_ALERT_THRESHOLDS, canaryStaleSeconds: 600 },
        changeNote: 'trying it on',
      }),
    );
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ status: 'refused', reason: 'admin_only' });

    const accepted = await call(
      'POST',
      '/settings/update',
      adminToken,
      command({
        settingKey: 'alert_thresholds',
        value: { ...DEFAULT_ALERT_THRESHOLDS, canaryStaleSeconds: 600 },
        changeNote: 'the canary was noisy',
      }),
    );
    expect(accepted.status).toBe(200);
    // The receipt carries the updated slice, which is this lane's acceptance
    // criterion: "every settings command returns the updated slice through a receipt".
    expect(accepted.body).toMatchObject({
      status: 'accepted',
      replayed: false,
      result: { previousVersion: 0, current: { settingKey: 'alert_thresholds', version: 1 } },
    });
  });

  it('replays a settings command from its receipt rather than writing a second version', async () => {
    const payload = command({
      settingKey: 'client_version_range',
      value: { minimum: '1.0.0', maximum: '1.4.0' },
      changeNote: 'the new build is out',
    });
    const first = await call('POST', '/settings/update', adminToken, payload);
    const again = await call('POST', '/settings/update', adminToken, payload);
    expect(first.body).toMatchObject({ status: 'accepted', replayed: false });
    expect(again.body).toMatchObject({ status: 'accepted', replayed: true });
    expect((again.body['result'] as { current: { version: number } }).current.version).toBe(1);

    const history = await call('POST', '/settings/history', adminToken, { settingKey: 'client_version_range' });
    expect((history.body['versions'] as readonly unknown[]).length).toBe(1);
  });

  it('refuses a value past a bound with a named reason and writes no version', async () => {
    // The envelope is valid, so this is a 409 rather than a 400: the server chose
    // the validator from the key, and the value did not pass it. 13.3's warning
    // threshold is not something a client can raise above its critical one.
    const answer = await call(
      'POST',
      '/settings/update',
      adminToken,
      command({
        settingKey: 'alert_thresholds',
        value: { ...DEFAULT_ALERT_THRESHOLDS, oldestJobAgeWarningSeconds: 1200 },
        changeNote: 'warning above critical',
      }),
    );
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ status: 'refused', reason: 'invalid_value' });
    const history = await call('POST', '/settings/history', adminToken, { settingKey: 'alert_thresholds' });
    expect((history.body['current'] as { version: number }).version).toBe(1);
  });

  it('answers the history of a key with its current version and every earlier one', async () => {
    const history = await call('POST', '/settings/history', salespersonToken, {
      settingKey: 'alert_thresholds',
    });
    expect(history.status).toBe(200);
    expect(history.body['settingKey']).toBe('alert_thresholds');
    expect((history.body['current'] as { version: number }).version).toBe(1);

    const unknownKey = await call('POST', '/settings/history', adminToken, { settingKey: 'not_a_key' });
    expect(unknownKey.status).toBe(400);
  });

  it('does not serve the slices that belong to other lanes', async () => {
    const answer = await call('GET', '/settings', adminToken);
    const keys = (answer.body['settings'] as readonly { settingKey: string }[]).map(entry => entry.settingKey);
    // The caps are G7-2's (row-level CHECKs) and the calendar is G8's (an immutable
    // version other rows freeze). This surface links to them; it does not hold them.
    expect(keys).not.toContain('sending_limits');
    expect(keys).not.toContain('holiday_calendar');
    const elsewhere = (answer.body['elsewhere'] as readonly { topic: string }[]).map(entry => entry.topic);
    expect(elsewhere).toContain('Workspace holidays');
    expect(elsewhere).toContain('Sending caps and the ramp');
  });

  it('answers the dashboard for a named window and refuses one without', async () => {
    const answer = await call('POST', '/dashboard', salespersonToken, {
      window: { from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' },
    });
    expect(answer.status).toBe(200);
    // The audience is decided from the scope and never taken from the request.
    expect(answer.body['audience']).toBe('assigned');
    expect(answer.body['sending']).toMatchObject({ available: false, owner: 'G7-2' });

    expect((await call('POST', '/dashboard', salespersonToken, {})).status).toBe(400);
    expect(
      (
        await call('POST', '/dashboard', salespersonToken, {
          window: { from: '2026-10-01T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('POST', '/dashboard', adminToken, {
          window: { from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' },
          audience: 'workspace',
        })
      ).status,
      'a request may not nominate its own audience',
    ).toBe(400);
  });

  it('answers Diagnostics with the schema, the client range and the mailbox visibility', async () => {
    const answer = await call('GET', '/diagnostics', adminToken);
    expect(answer.status).toBe(200);
    expect(answer.body['schema']).toMatchObject({ accepted: true });
    expect(answer.body['clientVersions']).toEqual(fixture.deps.config.supportedClientVersions);
    expect(answer.body['mailboxVisibility']).toBe('all');
    expect(answer.body['sending']).toMatchObject({ deploymentEnabled: false, effective: false });

    const theirs = await call('GET', '/diagnostics', salespersonToken);
    expect(theirs.body['mailboxVisibility']).toBe('own');
  });

  it('administers stages, and refuses a salesperson and a terminal stage', async () => {
    const refused = await call(
      'POST',
      '/pipeline/stages/create',
      salespersonToken,
      command({ key: 'demo', displayName: 'Demo' }),
    );
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ reason: 'admin_only' });

    const created = await call(
      'POST',
      '/pipeline/stages/create',
      adminToken,
      command({ key: 'demo', displayName: 'Demo' }),
    );
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ status: 'accepted' });

    const terminal = await call(
      'POST',
      '/pipeline/stages/rename',
      adminToken,
      command({ stageKey: 'won', displayName: 'Closed won' }),
    );
    expect(terminal.status).toBe(409);
    expect(terminal.body).toMatchObject({ reason: 'stage_terminal' });

    const stages = await call('GET', '/pipeline/stages', salespersonToken);
    const keys = (stages.body['stages'] as readonly { key: string }[]).map(entry => entry.key);
    expect(keys).toEqual(['new', 'contacting', 'engaged', 'qualified', 'proposal', 'demo', 'won', 'lost']);
  });

  it('gives the board its columns and the opportunity ids the caller may act on', async () => {
    const answer = await call('POST', '/pipeline/board', salespersonToken, {});
    expect(answer.status).toBe(200);
    const columns = answer.body['columns'] as readonly { stage: { key: string } }[];
    expect(columns.map(column => column.stage.key)).toEqual([
      'new',
      'contacting',
      'engaged',
      'qualified',
      'proposal',
      'demo',
      'won',
      'lost',
    ]);
    // No firms in this fixture, so the map is empty rather than absent: a client
    // that has to distinguish "no ids" from "no field" would get it wrong once.
    expect(answer.body['opportunityIdByFirmId']).toEqual({});
    expect(answer.body['unplacedFirms']).toEqual([]);
  });
});
