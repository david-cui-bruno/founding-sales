import { describe, expect, it } from 'vitest';
import type { PostureReferenceResponse, SettingsSnapshot, StatePostureView } from '@fss/contracts';
import { createAuthedClient } from '../src/main/authedClient.ts';
import { createAdminBridge, recordPostureBody } from '../src/main/settingsBridge.ts';
import { businessZoneOf, postureFormIssues, postureSection } from '../src/renderer/postureView.ts';
import { adminViewOf } from '../src/renderer/settingsView.ts';
import type { AdminState, RecordPostureInput } from '../src/renderer/settingsContract.ts';

/**
 * The postures form (lane g84, audit item G04): its body, its checks, its view and the
 * bridge that sends it. No Electron and no DOM; `e2e/postures.spec.ts` presses the form.
 *
 * The body is the half that can be wrong silently: a date sent as UTC midnight rather
 * than the business zone's would put a posture in force five or six hours early or late.
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

const input = (overrides: Partial<RecordPostureInput> = {}): RecordPostureInput => ({
  state: 'ma',
  effectiveFromDate: '2026-10-01',
  reviewDate: '',
  confirmedStatements: ['federal_rules_apply', 'state_rules_checked'],
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
    accessToken: async () => await Promise.resolve('token-value'),
    send: async (url, init) => {
      const path = new URL(url).pathname;
      calls.push({ path, body: init.body === undefined ? null : JSON.parse(init.body) });
      return await Promise.resolve(answer(path) ?? { status: 404, body: { error: 'not_found' } });
    },
  });
  return { api, calls };
}

const session = (role: 'admin' | 'salesperson' = 'admin') => ({ online: true, mayMutate: true, device: { role } });

describe('the posture body', () => {
  it('sends each date as midnight in the business zone, the state upper-cased and the note trimmed', () => {
    expect(recordPostureBody(input(), 'America/Chicago')).toEqual({
      state: 'MA',
      effectiveFrom: '2026-10-01T05:00:00.000Z',
      confirmedStatements: ['federal_rules_apply', 'state_rules_checked'],
      note: 'Read the registration page.',
    });
    // A review date is sent when given; in January Chicago is six hours behind UTC.
    expect(recordPostureBody(input({ reviewDate: '2027-01-15', note: '' }), 'America/Chicago')).toEqual({
      state: 'MA',
      effectiveFrom: '2026-10-01T05:00:00.000Z',
      reviewAt: '2027-01-15T06:00:00.000Z',
      confirmedStatements: ['federal_rules_apply', 'state_rules_checked'],
    });
  });

  it('is null when a date is not one', () => {
    expect(recordPostureBody(input({ effectiveFromDate: '2026-02-30' }), 'America/New_York')).toBeNull();
    expect(recordPostureBody(input({ reviewDate: 'soon' }), 'America/New_York')).toBeNull();
  });
});

describe('the posture checks', () => {
  const context = { statementCount: 2, records: [posture()], zone: 'America/New_York' };

  it('passes a complete form', () => {
    expect(postureFormIssues(input(), context)).toEqual([]);
  });

  it('names every field at fault', () => {
    const issues = postureFormIssues(
      input({ state: '', effectiveFromDate: '', reviewDate: 'x', confirmedStatements: ['federal_rules_apply'], note: 'n'.repeat(1001) }),
      context,
    );
    expect(issues.map(issue => issue.field)).toEqual(['state', 'effectiveFrom', 'reviewDate', 'statements', 'note']);
    expect(issues.find(issue => issue.field === 'statements')?.text).toBe(
      'Tick every statement. A partial confirmation is not a posture.',
    );
  });

  it('refuses a review date on or before the day it takes effect', () => {
    expect(postureFormIssues(input({ reviewDate: '2026-10-01' }), context).map(issue => issue.field)).toEqual(['reviewDate']);
  });

  it('says a state with an unrevoked posture must be revoked first, as the server would', () => {
    expect(postureFormIssues(input({ state: 'ri' }), context)).toEqual([
      { field: 'state', text: 'RI already has a posture in force. Revoke it first, or start this one after it ends.' },
    ]);
    // A revoked posture, or one that ends before the new one starts, is no obstacle.
    const revoked = { ...context, records: [posture({ revokedAt: '2026-09-20T00:00:00.000Z' })] };
    expect(postureFormIssues(input({ state: 'RI' }), revoked)).toEqual([]);
    const ended = { ...context, records: [posture({ effectiveTo: '2026-10-01T04:00:00.000Z' })] };
    expect(postureFormIssues(input({ state: 'RI' }), ended)).toEqual([]);
  });
});

describe('the postures section', () => {
  const now = new Date('2026-09-25T15:00:00.000Z');

  it('lists each posture with its status, and offers the quoted states first', () => {
    const state = adminState({
      postures: {
        reference: REFERENCE,
        readError: null,
        records: [
          posture(),
          posture({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', state: 'AL', reviewAt: '2026-09-20T05:00:00.000Z' }),
          posture({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3', state: 'AL', revokedAt: '2026-08-01T00:00:00.000Z' }),
        ],
      },
    });
    const section = postureSection(state, 'America/New_York', now);
    expect(section?.rows.map(row => [row.state, row.tag.text, row.canRevoke])).toEqual([
      ['AL', 'Review overdue', true],
      ['AL', 'Revoked', false],
      ['RI', 'In force', true],
    ]);
    expect(section?.rows[2]?.line).toBe('Rhode Island (RI) · revision 1 · from 2026-09-01 · review by 2027-09-01');
    expect(section?.summary).toContain('In force: RI.');
    expect(section?.stateOptions.map(option => option.value)).toEqual(['RI', 'AL']);
    expect(section?.rules['RI']?.summary).toBe('Rhode Island summary.');
    expect(section?.rules['AL']).toBeNull();
    expect(section?.editable).toBe(true);
    expect(JSON.parse(section?.json ?? '[]')).toHaveLength(3);
  });

  it('is read-only to a salesperson, and says so', () => {
    const section = postureSection(adminState({ role: 'salesperson' }), 'America/New_York', now);
    expect(section?.editable).toBe(false);
    expect(section?.notEditableBecause).toBe('Only an admin can record or revoke a posture.');
  });

  it('says when the postures could not be read, and offers nothing to record', () => {
    const section = postureSection(
      adminState({ postures: { reference: null, records: null, readError: 'offline' } }),
      'America/New_York',
      now,
    );
    expect(section?.unread).toMatch(/^Callie could not read the postures\./u);
    expect(section?.editable).toBe(false);
  });

  it('is absent before the bridge has read anything', () => {
    expect(postureSection(adminState({ postures: null }), 'America/New_York', now)).toBeNull();
  });

  it('points the settings list at the form rather than at the path', () => {
    const snapshot = { ...settingsBody, settings: [] };
    const view = adminViewOf(adminState({ settings: snapshot }), now);
    expect(view.elsewhere.find(entry => entry.path === '/postures')?.editedHere).toBe('Calling postures');
  });

  it("takes the business zone from the settings, New York before they are read", () => {
    expect(businessZoneOf(null)).toBe('America/New_York');
    expect(businessZoneOf(settingsBody)).toBe('America/Chicago');
  });
});

describe('the administration bridge and postures', () => {
  it('reads the reference once, records in the business zone and reads the list again', async () => {
    const lists = [
      { status: 200, body: { postures: [] } },
      { status: 200, body: { postures: [posture({ state: 'MA', effectiveFrom: '2026-10-01T05:00:00.000Z' })] } },
    ];
    const { api, calls } = scriptedApi(path => {
      if (path === '/settings') return { status: 200, body: settingsBody };
      if (path === '/pipeline/stages') return { status: 200, body: { stages: [] } };
      if (path === '/postures/reference') return { status: 200, body: REFERENCE };
      if (path === '/postures') return lists.shift();
      if (path === '/postures/record') {
        return { status: 200, body: { status: 'accepted', replayed: false, result: posture({ state: 'MA' }) } };
      }
      return undefined;
    });
    const bridge = createAdminBridge({ api, session: { state: async () => await Promise.resolve(session()) } });
    const before = await bridge.state();
    expect(before.postures?.records).toEqual([]);
    expect(before.postures?.reference?.statements).toHaveLength(2);

    const after = await bridge.recordPosture(input());
    expect(after.notice).toBe('posture_recorded');
    expect(after.postures?.records?.map(row => row.state)).toEqual(['MA']);
    expect(calls.find(call => call.path === '/postures/record')?.body).toMatchObject({
      state: 'MA',
      effectiveFrom: '2026-10-01T05:00:00.000Z',
      confirmedStatements: ['federal_rules_apply', 'state_rules_checked'],
      note: 'Read the registration page.',
      clientVersion: '1.0.5',
    });
    expect(calls.filter(call => call.path === '/postures/reference')).toHaveLength(1);
    expect(calls.filter(call => call.path === '/postures')).toHaveLength(2);
    expect(adminViewOf(after).notice).toBe('Posture recorded.');
  });

  it("keeps the server's refusal as the notice, in words", async () => {
    const { api } = scriptedApi(path => {
      if (path === '/settings') return { status: 200, body: settingsBody };
      if (path === '/pipeline/stages') return { status: 200, body: { stages: [] } };
      if (path === '/postures/reference') return { status: 200, body: REFERENCE };
      if (path === '/postures') return { status: 200, body: { postures: [posture()] } };
      if (path === '/postures/record') return { status: 409, body: { status: 'refused', replayed: false, reason: 'posture_overlapping' } };
      return undefined;
    });
    const bridge = createAdminBridge({ api, session: { state: async () => await Promise.resolve(session()) } });
    await bridge.state();
    const refused = await bridge.recordPosture(input({ state: 'RI' }));
    expect(refused.notice).toBe('posture_overlapping');
    expect(adminViewOf(refused).notice).toContain('already has a posture in force');
  });

  it('sends nothing for a date it cannot read', async () => {
    const { api, calls } = scriptedApi(path => (path === '/settings' ? { status: 200, body: settingsBody } : undefined));
    const bridge = createAdminBridge({ api, session: { state: async () => await Promise.resolve(session()) } });
    const refused = await bridge.recordPosture(input({ effectiveFromDate: '2026-13-01' }));
    expect(refused.notice).toBe('posture_date_invalid');
    expect(calls.some(call => call.path === '/postures/record')).toBe(false);
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
