import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mayMutate, settingHistoryResponseSchema, wireDrift } from '@fss/contracts';
import { CONTAINER_CLIENT_VERSIONS } from '../../apps/api/src/bootstrap/main.ts';
import { createAuthFixture, type AuthFixture } from '../../apps/api/test/support/authFixture.ts';
import { issueSessionFor } from '../../apps/api/test/support/sessionFixture.ts';
import { createAdminBridge } from '../../apps/desktop/src/main/settingsBridge.ts';
import { adminViewOf } from '../../apps/desktop/src/renderer/settingsView.ts';
import { settingHistoryAnswer } from '../../apps/desktop/test/support/settingHistory.ts';
import { DESKTOP_VERSION_UNDER_TEST, desktopClient, routeAnswer, shapeOf } from './support/wireThrough.ts';

/**
 * A setting's history says what changed, not only when (release.md 8.0aj; lane g78,
 * audit item D04).
 *
 * `POST /settings/history` answers the slice's current value and every version with the
 * value it set (`readSettingHistory`, `packages/domain/settings/store.ts`). Desktop
 * 1.0.4's schema declared four fields of each version and stripped `value` and
 * `current`, and nothing drew the versions at all: the History button fetched a list of
 * dates and notes that no part of the window showed.
 *
 * ## The vacuous-pass traps, named
 *
 * **A history of one version.** One version has nothing before it but the default, so
 * "from" could be right by accident. The slice here is set twice through the real
 * command, and the second version's "from" has to be the first version's value.
 *
 * **A fixture that agrees with the parser.** `apps/desktop/test/support/settingHistory.ts`
 * is held to the route's answer key for key and type for type.
 */

describe('8.0aj: the settings history shows the values (lane g78)', () => {
  let fixture: AuthFixture;
  let adminToken = '';

  const bridge = () =>
    createAdminBridge({
      api: desktopClient(fixture, adminToken),
      session: { state: async () => await Promise.resolve({ online: true, mayMutate: true, device: { role: 'admin' as const } }) },
    });

  beforeAll(async () => {
    fixture = await createAuthFixture();
    adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it('renders each version’s value and the one it replaced, from the real route', async () => {
    const admin = bridge();
    for (const [timeZone, changeNote] of [
      ['America/Denver', 'first configuration'],
      ['America/Chicago', 'the office moved'],
    ] as const) {
      const saved = await admin.saveSetting({ settingKey: 'business_time_zone', value: { timeZone }, changeNote });
      expect(saved.notice, timeZone).toBeNull();
    }

    const state = await admin.openHistory({ settingKey: 'business_time_zone' });
    expect(state.notice).toBeNull();
    expect(state.history?.current).toEqual({ value: { timeZone: 'America/Chicago' }, version: 2 });

    const view = adminViewOf(state).history;
    expect(view?.heading).toBe('History of Workspace business zone');
    expect(view?.currentLine).toBe('In force now: version 2: {"timeZone":"America/Chicago"}');
    expect(view?.versions.map(entry => [entry.version, entry.from, entry.to, entry.current])).toEqual([
      [2, '{"timeZone":"America/Denver"}', '{"timeZone":"America/Chicago"}', true],
      [1, '{"timeZone":"America/New_York"} (the default)', '{"timeZone":"America/Denver"}', false],
    ]);
    expect(view?.versions[0]?.line).toMatch(/^Version 2, changed .+: the office moved$/u);
  });

  it('holds the desktop’s unit fixture to the route: the same keys, the same types, all the way down', async () => {
    const answer = await routeAnswer(fixture, 'POST', '/settings/history', adminToken, { settingKey: 'business_time_zone' });
    expect(answer.status).toBe(200);
    expect(wireDrift(settingHistoryResponseSchema, answer.body)).toEqual([]);
    expect(shapeOf(answer.body)).toEqual(shapeOf(settingHistoryAnswer()));
    // The two fields the defect was about, said outright.
    expect(Object.keys(answer.body as object)).toContain('current');
    expect(Object.keys((answer.body as { versions: object[] }).versions[0] ?? {})).toContain('value');
  });

  it('is a build the deployed API accepts', () => {
    expect(mayMutate(CONTAINER_CLIENT_VERSIONS, DESKTOP_VERSION_UNDER_TEST)).toBe(true);
  });
});
