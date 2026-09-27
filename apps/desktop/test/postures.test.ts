import { describe, expect, it } from 'vitest';
import type { PostureReferenceResponse, SettingsSnapshot, StatePostureView } from '@fss/contracts';
import { createAuthedClient } from '../src/main/authedClient.ts';
import { createAdminBridge } from '../src/main/settingsBridge.ts';
import { allowStatesIssues, businessZoneOf, postureSection } from '../src/renderer/postureView.ts';
import { adminViewOf } from '../src/renderer/settingsView.ts';
import type { AdminState, AllowStatesInput } from '../src/renderer/settingsContract.ts';

/**
 * The "OK to call" list (lane g84, audit item G04; wave 2, S4.2 and D5): its checks, its
 * view and the bridge that sends it. No Electron and no DOM; `e2e/postures.spec.ts`
 * presses the section.
 *
 * Since wave 2 there is no date and no review to get wrong: several states, one
 * confirmation, and the server records the statements and the citations from the release.
 */

const REFERENCE: PostureReferenceResponse = {
  rulesRevision: 2,
  statements: [
    { key: 'federal_rules_apply', text: 'Federal rules apply.' },
    { key: 'state_rules_checked', text: 'I checked the state rules.' },
  ],
  federalCitations: [{ title: 'TCPA', url: 'https://example.test/tcpa', quote: 'A quoted line.' }],
  states: [
    { state: 'AL', name: 'Alabama', rule: null },
    {
      state: 'RI',
      name: 'Rhode Island',
      rule: { summary: 'Rhode Island summary.', citations: [{ title: 'R.I. law', url: 'https://example.test/ri', quote: 'Quoted.' }] },
    },
  ],
};

const USER_ID = '11111111-1111-4111-8111-111111111111';

const posture = (overrides: Partial<StatePostureView> = {}): StatePostureView => ({
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
  state: 'RI',
  revision: 1,
  effectiveFrom: '2026-09-01T05:00:00.000Z',
  effectiveTo: null,
  reviewAt: '2027-09-01T05:00:00.000Z',
  rulesRevision: 2,
  confirmedStatements: ['federal_rules_apply', 'state_rules_checked'],
  sources: [],
  confirmedByUserId: USER_ID,
  revokedAt: null,
  ...overrides,
});

const input = (overrides: Partial<AllowStatesInput> = {}): AllowStatesInput => ({
  states: ['MA'],
  confirmed: true,
  note: '  Read the registration page.  ',
  ...overrides,
});

const settingsBody: SettingsSnapshot = {
  settings: [
    {
      settingKey: 'business_time_zone',
      value: { timeZone: 'America/Chicago' },
      version: 1,
      changedAt: '2026-09-19T10:00:00.000Z',
      changedByUserId: USER_ID,
      changeNote: null,
    },
  ],
  elsewhere: [{ topic: 'State postures', path: '/postures', ownedBy: 'G4 policy' }],
  holidayCalendar: { version: 'none.1', dates: [] },
  deploymentSendingEnabled: false,
  effectiveSendingEnabled: false,
};

const adminState = (overrides: Partial<AdminState> = {}): AdminState => ({
  screen: 'settings',
  role: 'admin',
  online: true,
  mayMutate: true,
  notice: null,
  settings: null,
  dashboard: null,
  diagnostics: null,
  stages: [],
  history: null,
  sendingAdmin: null,
  sendingReadError: null,
  callingNumbers: null,
  postures: { reference: REFERENCE, records: [], readError: null },
  ...overrides,
});

interface HttpAnswer {
  readonly status: number;
  readonly body: unknown;
}

function scriptedApi(answer: (path: string) => HttpAnswer | undefined) {
  const calls: { path: string; body: unknown }[] = [];
  const api = createAuthedClient({
    baseUrl: 'https://api.example.test/',
    clientVersion: '1.0.5',
    accessToken: async () => await Promise.resolve({ token: 'token-value', generation: 0 }),
    send: async (url, init) => {
      const path = new URL(url).pathname;
      calls.push({ path, body: init.body === undefined ? null : JSON.parse(init.body) });
      return await Promise.resolve(answer(path) ?? { status: 404, body: { error: 'not_found' } });
    },
  });
  return { api, calls };
}

const session = (role: 'admin' | 'salesperson' = 'admin') => ({ online: true, mayMutate: true, device: { role } });

describe('the checks before the list is sent', () => {
  it('passes a chosen, confirmed list', () => {
    expect(allowStatesIssues({ states: ['MA', 'RI'], confirmed: true, note: '' })).toEqual([]);
  });

  it('names every field at fault, as the server would refuse it', () => {
    const issues = allowStatesIssues({ states: [], confirmed: false, note: 'n'.repeat(1001) });
    expect(issues.map(issue => issue.field)).toEqual(['states', 'confirmed', 'note']);
    expect(issues.find(issue => issue.field === 'confirmed')?.text).toBe(
      'Confirm that you have read the rules quoted for these states.',
    );
  });

  it('refuses more states than the command takes', () => {
    const many = Array.from({ length: 61 }, (_value, index) => `S${String(index)}`);
    expect(allowStatesIssues({ states: many, confirmed: true, note: '' }).map(issue => issue.field)).toEqual(['states']);
  });
});

describe('the postures section', () => {
  const now = new Date('2026-09-25T15:00:00.000Z');

  it('lists the states on the list, and offers the quoted ones first among the rest', () => {
    const state = adminState({
      postures: {
        reference: REFERENCE,
        readError: null,
        records: [
          posture(),
          posture({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3', state: 'AL', revokedAt: '2026-08-01T00:00:00.000Z' }),
        ],
      },
    });
    const section = postureSection(state, 'America/New_York', now);
    // A revoked posture is not on the list, and its state is offered again.
    expect(section?.rows.map(row => [row.state, row.canRevoke])).toEqual([['RI', true]]);
    expect(section?.rows[0]?.line).toBe('Rhode Island (RI) — since 2026-09-01');
    expect(section?.summary).toContain('on this list: RI.');
    expect(section?.stateOptions.map(option => option.value)).toEqual(['AL']);
    expect(section?.rules['RI']?.summary).toBe('Rhode Island summary.');
    expect(section?.rules['AL']).toBeNull();
    expect(section?.editable).toBe(true);
  });

  it('is read-only to a salesperson, and says so', () => {
    const section = postureSection(adminState({ role: 'salesperson' }), 'America/New_York', now);
    expect(section?.editable).toBe(false);
    expect(section?.notEditableBecause).toBe('Only an admin can change this list.');
  });

  it('says when the postures could not be read, and offers nothing to record', () => {
    const section = postureSection(
      adminState({ postures: { reference: null, records: null, readError: 'offline' } }),
      'America/New_York',
      now,
    );
    expect(section?.unread).toMatch(/^Callie could not read which states you call\./u);
    expect(section?.editable).toBe(false);
  });

  it('is absent before the bridge has read anything', () => {
    expect(postureSection(adminState({ postures: null }), 'America/New_York', now)).toBeNull();
  });

  it("takes the business zone from the settings, New York before they are read", () => {
    expect(businessZoneOf(null)).toBe('America/New_York');
    expect(businessZoneOf(settingsBody)).toBe('America/Chicago');
  });
});

describe('the administration bridge and the "OK to call" list', () => {
  it('reads the reference once, sends the list with one confirmation and reads it again', async () => {
    const lists = [
      { status: 200, body: { postures: [] } },
      { status: 200, body: { postures: [posture({ state: 'MA', effectiveFrom: '2026-10-01T05:00:00.000Z' })] } },
    ];
    const { api, calls } = scriptedApi(path => {
      if (path === '/settings') return { status: 200, body: settingsBody };
      if (path === '/pipeline/stages') return { status: 200, body: { stages: [] } };
      if (path === '/postures/reference') return { status: 200, body: REFERENCE };
      if (path === '/postures') return lists.shift();
      if (path === '/postures/allow') {
        return {
          status: 200,
          body: {
            status: 'accepted',
            replayed: false,
            result: { postures: [posture({ state: 'MA' })], added: ['MA'], alreadyAllowed: [] },
          },
        };
      }
      return undefined;
    });
    const bridge = createAdminBridge({ api, session: { state: async () => await Promise.resolve(session()) } });
    const before = await bridge.state();
    expect(before.postures?.records).toEqual([]);
    expect(before.postures?.reference?.statements).toHaveLength(2);

    const after = await bridge.allowStates(input());
    expect(after.notice).toBe('posture_recorded');
    expect(after.postures?.records?.map(row => row.state)).toEqual(['MA']);
    expect(calls.find(call => call.path === '/postures/allow')?.body).toMatchObject({
      states: ['MA'],
      confirmed: true,
      note: 'Read the registration page.',
      clientVersion: '1.0.5',
    });
    expect(calls.filter(call => call.path === '/postures/reference')).toHaveLength(1);
    expect(calls.filter(call => call.path === '/postures')).toHaveLength(2);
    expect(adminViewOf(after).notice).toBe('Added. Callie can call firms in those states now.');
  });

  it('says so when every state named was already on the list', async () => {
    const { api } = scriptedApi(path => {
      if (path === '/settings') return { status: 200, body: settingsBody };
      if (path === '/pipeline/stages') return { status: 200, body: { stages: [] } };
      if (path === '/postures/reference') return { status: 200, body: REFERENCE };
      if (path === '/postures') return { status: 200, body: { postures: [posture()] } };
      if (path === '/postures/allow') {
        return {
          status: 200,
          body: { status: 'accepted', replayed: false, result: { postures: [posture()], added: [], alreadyAllowed: ['RI'] } },
        };
      }
      return undefined;
    });
    const bridge = createAdminBridge({ api, session: { state: async () => await Promise.resolve(session()) } });
    await bridge.state();
    const again = await bridge.allowStates(input({ states: ['RI'] }));
    expect(again.notice).toBe('posture_already_allowed');
    expect(adminViewOf(again).notice).toBe('Those states were already on the list.');
  });

  it("keeps the server's refusal as the notice", async () => {
    const { api } = scriptedApi(path => {
      if (path === '/settings') return { status: 200, body: settingsBody };
      if (path === '/pipeline/stages') return { status: 200, body: { stages: [] } };
      if (path === '/postures/reference') return { status: 200, body: REFERENCE };
      if (path === '/postures') return { status: 200, body: { postures: [posture()] } };
      if (path === '/postures/allow') return { status: 409, body: { status: 'refused', replayed: false, reason: 'invalid_input' } };
      return undefined;
    });
    const bridge = createAdminBridge({ api, session: { state: async () => await Promise.resolve(session()) } });
    await bridge.state();
    const refused = await bridge.allowStates(input({ states: ['RI'] }));
    expect(refused.notice).toBe('invalid_input');
    expect(adminViewOf(refused).notice).toContain('Choose at least one state');
  });

  it('revokes by id and reads the list again', async () => {
    const { api, calls } = scriptedApi(path => {
      if (path === '/settings') return { status: 200, body: settingsBody };
      if (path === '/postures/reference') return { status: 200, body: REFERENCE };
      if (path === '/postures') return { status: 200, body: { postures: [] } };
      if (path === '/postures/revoke') {
        return { status: 200, body: { status: 'accepted', replayed: false, result: posture({ revokedAt: '2026-09-25T15:00:00.000Z' }) } };
      }
      return undefined;
    });
    const bridge = createAdminBridge({ api, session: { state: async () => await Promise.resolve(session()) } });
    await bridge.state();
    const revoked = await bridge.revokePosture({ postureId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1' });
    expect(revoked.notice).toBe('posture_revoked');
    expect(calls.find(call => call.path === '/postures/revoke')?.body).toMatchObject({
      postureId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
    });
  });
});
