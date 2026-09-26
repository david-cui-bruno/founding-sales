import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RELEASE_RECORD_SCHEMA_ID,
  SETTING_KEYS,
  pipelineBoardResponseSchema,
  pipelineStagesResponseSchema,
  publishedClientVersions,
  settingHistoryResponseSchema,
  wireDrift,
} from '@fss/contracts';
import { putReleaseRecord } from '@fss/domain/release';
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
/**
 * The API image the fixture deployment "runs", and the worker beside it (lane g71).
 * Fictional: repeated hex letters, never a digest anybody built.
 */
const RUNNING_API_DIGEST = `sha256:${'a'.repeat(64)}`;
const RUNNING_WORKER_DIGEST = `sha256:${'b'.repeat(64)}`;

describe('the administration surface', () => {
  let fixture: AuthFixture;
  let adminToken: string;
  let salespersonToken: string;

  // `null` is a deployment that never said which image it is; a default parameter
  // cannot be `undefined`, because `undefined` selects the default.
  const options = (sendingEnabled = false, imageDigest: string | null = RUNNING_API_DIGEST) => ({
    session: fixture.db,
    supportedClientVersions: fixture.deps.config.supportedClientVersions,
    sendingEnabled,
    auth: fixture.deps,
    upgradeUrl: 'https://callie.example/downloads/mac',
    ...(imageDigest === null ? {} : { imageDigest }),
  });

  const call = async (
    method: string,
    path: string,
    token: string | null,
    body?: unknown,
    sendingEnabled = false,
    imageDigest: string | null = RUNNING_API_DIGEST,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const request: ApiRequest = {
      method,
      path,
      query: new URLSearchParams(),
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
      body,
    };
    const result = await dispatch(request, options(sendingEnabled, imageDigest));
    // What a socket carries: JSON, so an instant is a string here as it is on the Mac.
    return { status: result.status, body: JSON.parse(JSON.stringify(result.body ?? null)) as Record<string, unknown> };
  };

  /** The release record a green rehearsal wrote, stored the way `fss admin release-record put` stores it. */
  const storeRecord = async (reference: string, suite = 'pass'): Promise<void> => {
    const stored = await putReleaseRecord(
      { db: fixture.db },
      {
        schema: RELEASE_RECORD_SCHEMA_ID,
        releaseGateReference: reference,
        rehearsalPrefix: 'fss-rh-fixture',
        recordedAt: '2026-09-20T12:00:00Z',
        suite,
        artifacts: { api: RUNNING_API_DIGEST, worker: RUNNING_WORKER_DIGEST, desktopCommitStamp: 'e'.repeat(40) },
        rehearsalScenarios: {},
        enablesSending: false,
      },
    );
    expect(stored.ok, JSON.stringify(stored)).toBe(true);
  };

  const enableCommand = (reference: string) =>
    command({
      settingKey: 'sending_enabled',
      value: { enabled: true, releaseGateReference: reference },
      changeNote: `rehearsal ${reference} passed; digests match production`,
    });

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
    expect(elsewhere.map(entry => entry.path)).toContain('/postures/calling-window');
  });

  it('shows both halves of the production sending switch', async () => {
    // 16.2 is two switches ANDed. With the deployment flag off, an admin enabling
    // sending changes the admin half and not the effective answer.
    const off = await call('GET', '/settings', adminToken);
    expect(off.body['deploymentSendingEnabled']).toBe(false);
    expect(off.body['effectiveSendingEnabled']).toBe(false);

    // Lane g71: the reference names a stored record whose API digest is this API's.
    await storeRecord('rehearsal-2026-09-20');
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

    // Lane g71: the same attestation read by an API running a different image is not
    // in force here, and the page says so — which is what the worker's gate says too.
    const redeployed = await call('GET', '/settings', adminToken, undefined, true, `sha256:${'f'.repeat(64)}`);
    expect(redeployed.body['deploymentSendingEnabled']).toBe(true);
    expect(redeployed.body['effectiveSendingEnabled']).toBe(false);
    const diagnostics = await call('GET', '/diagnostics', adminToken, undefined, true, `sha256:${'f'.repeat(64)}`);
    expect(diagnostics.body['sending']).toEqual({ deploymentEnabled: true, adminEnabled: false, effective: false });
    const bound = await call('GET', '/diagnostics', adminToken, undefined, true);
    expect(bound.body['sending']).toEqual({ deploymentEnabled: true, adminEnabled: true, effective: true });

    // Turned off again, so the refusal cases below start from a disabled workspace.
    const withdrawn = await call(
      'POST',
      '/settings/update',
      adminToken,
      command({
        settingKey: 'sending_enabled',
        value: { enabled: false, releaseGateReference: null },
        changeNote: 'withdrawn',
      }),
      true,
      'unknown',
    );
    expect(withdrawn.body['status']).toBe('accepted');
  });

  describe('an enable of production sending, bound to the release record (lane g71)', () => {
    it('refuses a reference no stored record carries', async () => {
      const answer = await call('POST', '/settings/update', adminToken, enableCommand('fss-rh-nobody-ran-this'));
      expect(answer.status).toBe(409);
      expect(answer.body).toMatchObject({ status: 'refused', reason: 'release_record_unknown' });
    });

    it('refuses a record whose suite did not pass', async () => {
      await storeRecord('fss-rh-fixture-failed', 'fail');
      const answer = await call('POST', '/settings/update', adminToken, enableCommand('fss-rh-fixture-failed'));
      expect(answer.status).toBe(409);
      expect(answer.body).toMatchObject({ status: 'refused', reason: 'release_record_not_passing' });
    });

    it('refuses when this API is not the image the rehearsal certified', async () => {
      await storeRecord('fss-rh-fixture-mismatch');
      const answer = await call(
        'POST',
        '/settings/update',
        adminToken,
        enableCommand('fss-rh-fixture-mismatch'),
        true,
        `sha256:${'f'.repeat(64)}`,
      );
      expect(answer.status).toBe(409);
      expect(answer.body).toMatchObject({ status: 'refused', reason: 'release_record_digest_mismatch' });
    });

    it('refuses, failing closed, when the API does not know which image it is', async () => {
      await storeRecord('fss-rh-fixture-identity');
      for (const imageDigest of ['unknown', null]) {
        const answer = await call(
          'POST',
          '/settings/update',
          adminToken,
          enableCommand('fss-rh-fixture-identity'),
          true,
          imageDigest,
        );
        expect(answer.status, String(imageDigest)).toBe(409);
        expect(answer.body).toMatchObject({ status: 'refused', reason: 'release_record_identity_unknown' });
      }
      const settings = await call('GET', '/settings', adminToken, undefined, true);
      expect(settings.body['effectiveSendingEnabled']).toBe(false);
    });

    it('accepts the passing record whose API digest is this API’s, which is the positive control', async () => {
      await storeRecord('fss-rh-fixture-accepted');
      const answer = await call('POST', '/settings/update', adminToken, enableCommand('fss-rh-fixture-accepted'), true);
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ status: 'accepted' });
    });
  });

  it('refuses a settings command from a salesperson and accepts one from an admin', async () => {
    const refused = await call(
      'POST',
      '/settings/update',
      salespersonToken,
      command({
        settingKey: 'business_time_zone',
        value: { timeZone: 'America/Chicago' },
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
        settingKey: 'business_time_zone',
        value: { timeZone: 'America/Chicago' },
        changeNote: 'the founder moved',
      }),
    );
    expect(accepted.status).toBe(200);
    // The receipt carries the updated slice, which is this lane's acceptance
    // criterion: "every settings command returns the updated slice through a receipt".
    expect(accepted.body).toMatchObject({
      status: 'accepted',
      replayed: false,
      result: { previousVersion: 0, current: { settingKey: 'business_time_zone', version: 1 } },
    });
  });

  it('replays a settings command from its receipt rather than writing a second version', async () => {
    const payload = command({
      settingKey: 'business_time_zone',
      value: { timeZone: 'America/Denver' },
      changeNote: 'moved again',
    });
    const first = await call('POST', '/settings/update', adminToken, payload);
    const again = await call('POST', '/settings/update', adminToken, payload);
    expect(first.body).toMatchObject({ status: 'accepted', replayed: false });
    expect(again.body).toMatchObject({ status: 'accepted', replayed: true });
    expect((again.body['result'] as { current: { version: number } }).current.version).toBe(2);

    const history = await call('POST', '/settings/history', adminToken, { settingKey: 'business_time_zone' });
    expect((history.body['versions'] as readonly unknown[]).length).toBe(2);
    // D04: the value each version set and the value in force now are on the wire, and
    // the contract declares both, so the Mac can show what changed and not only when.
    expect(wireDrift(settingHistoryResponseSchema, history.body)).toEqual([]);
    const parsed = settingHistoryResponseSchema.parse(history.body);
    expect(parsed.versions[0]?.value).toEqual({ timeZone: 'America/Denver' });
    expect(parsed.current).toEqual({ value: { timeZone: 'America/Denver' }, version: 2 });
  });

  it('refuses a value its key does not accept with a named reason and writes no version', async () => {
    // The envelope is valid, so this is a 409 rather than a 400: the server chose
    // the validator from the key, and the value did not pass it.
    const answer = await call(
      'POST',
      '/settings/update',
      adminToken,
      command({
        settingKey: 'business_time_zone',
        value: { timeZone: 'nowhere' },
        changeNote: 'not a zone',
      }),
    );
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ status: 'refused', reason: 'invalid_value' });
    const history = await call('POST', '/settings/history', adminToken, { settingKey: 'business_time_zone' });
    expect((history.body['current'] as { version: number }).version).toBe(2);
  });

  it('answers the history of a key with its current version and every earlier one', async () => {
    const history = await call('POST', '/settings/history', salespersonToken, {
      settingKey: 'business_time_zone',
    });
    expect(history.status).toBe(200);
    expect(history.body['settingKey']).toBe('business_time_zone');
    expect((history.body['current'] as { version: number }).version).toBe(2);

    const unknownKey = await call('POST', '/settings/history', adminToken, { settingKey: 'not_a_key' });
    expect(unknownKey.status).toBe(400);
  });

  it('accepts a save with no note and records "Changed on the Mac" (D5)', async () => {
    const saved = await call(
      'POST',
      '/settings/update',
      adminToken,
      command({ settingKey: 'business_time_zone', value: { timeZone: 'America/Phoenix' } }),
    );
    expect(saved.status).toBe(200);
    const history = await call('POST', '/settings/history', adminToken, { settingKey: 'business_time_zone' });
    const parsed = settingHistoryResponseSchema.parse(history.body);
    expect(parsed.versions[0]?.changeNote).toBe('Changed on the Mac');
    expect(parsed.current?.version).toBe(3);
  });

  it('refuses the two retired slices as malformed requests', async () => {
    for (const settingKey of ['alert_thresholds', 'client_version_range']) {
      const history = await call('POST', '/settings/history', adminToken, { settingKey });
      expect(history.status, settingKey).toBe(400);
      const update = await call(
        'POST',
        '/settings/update',
        adminToken,
        command({ settingKey, value: {}, changeNote: 'a retired slice' }),
      );
      expect(update.status, settingKey).toBe(400);
    }
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
    // G8's calendar has a path now, not a "pending" string, and the current
    // calendar rides along in the snapshot so the page can offer an edit of it.
    const holidays = (answer.body['elsewhere'] as readonly { topic: string; path: string }[]).find(
      entry => entry.topic === 'Workspace holidays',
    );
    expect(holidays?.path).toBe('/sequences/holidays');
    // G8's empty calendar, not an error: weekends are in the rule, so a workspace
    // that observes no holidays is a correctly configured workspace.
    expect(answer.body['holidayCalendar']).toEqual({ version: 'none.1', dates: [] });
  });

  it('answers the dashboard for a named window and refuses one without', async () => {
    const answer = await call('POST', '/dashboard', salespersonToken, {
      window: { from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' },
    });
    expect(answer.status).toBe(200);
    // The audience is decided from the scope and never taken from the request.
    expect(answer.body['audience']).toBe('assigned');
    // Every figure is real. Sending carries the two counts the Mac shows (S6).
    expect(answer.body['sending']).toEqual({ available: true, sent: 0, held: 0 });
    expect(answer.body['enrollments']).toMatchObject({ available: true, started: 0 });
    expect(answer.body['classifier']).toMatchObject({ available: true, callsAttempted: 0 });

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
    expect(answer.body['clientVersions']).toEqual(publishedClientVersions(fixture.deps.config.supportedClientVersions));
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
    expect(wireDrift(pipelineStagesResponseSchema, stages.body)).toEqual([]);
    const keys = (stages.body['stages'] as readonly { key: string }[]).map(entry => entry.key);
    expect(keys).toEqual(['new', 'contacting', 'engaged', 'qualified', 'proposal', 'demo', 'won', 'lost']);
  });

  it('gives the board its columns and the opportunity ids the caller may act on', async () => {
    const answer = await call('POST', '/pipeline/board', salespersonToken, {});
    expect(answer.status).toBe(200);
    expect(wireDrift(pipelineBoardResponseSchema, answer.body)).toEqual([]);
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
