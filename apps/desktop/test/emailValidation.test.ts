import { describe, expect, it } from 'vitest';
import { firmPageRequestSchema, routeDtoSchema, type RouteDto } from '@fss/contracts';
import type { HttpAnswer } from '../src/main/apiClient.ts';
import { createAuthedClient } from '../src/main/authedClient.ts';
import { createCrmBridge } from '../src/main/crmBridge.ts';
import { EMAIL_VALIDATION_TEXT, emailValidationStateOf, noticeText } from '../src/renderer/firmWorkspaceView.ts';

/**
 * Lane g90's desktop half, without Electron: the Firm page asks for its second version,
 * each address says where its validation stands, and "Check again" sends the address at
 * the version on screen.
 *
 * The bridge runs over the real transport (`createAuthedClient`) against scripted
 * answers, so what is proved is the exact body each call sends. The page itself is drawn
 * in `test/e2e/firmWorkspace.spec.ts`.
 *
 * Addresses are under `.fsstest`, a top-level name that does not exist.
 */

const FIRM = '12121212-1212-4212-8212-121212121212';
const ROUTE = '16161616-1616-4616-8616-161616161616';

function scriptedApi(answers: Record<string, HttpAnswer>) {
  const calls: { path: string; body: Record<string, unknown> | null }[] = [];
  const api = createAuthedClient({
    baseUrl: 'https://api.example.test/',
    clientVersion: '1.0.6',
    accessToken: async () => await Promise.resolve('token-value'),
    send: async (url, init) => {
      const path = new URL(url).pathname;
      const body = init.body === undefined ? null : (JSON.parse(init.body) as Record<string, unknown>);
      calls.push({ path, body });
      return await Promise.resolve(answers[path] ?? { status: 404, body: { error: 'not_found' } });
    },
  });
  return { api, calls };
}

const route = (overrides: Partial<RouteDto>): RouteDto => ({
  id: ROUTE,
  contactId: null,
  value: 'dana@mx.fsstest',
  eligibility: 'candidate',
  version: 1,
  ...overrides,
});

const firmPage = (emailRoutes: readonly RouteDto[]) => ({
  visibility: 'assigned_or_admin',
  read: {
    visibility: 'assigned_or_admin',
    firm: {
      id: FIRM,
      name: 'Aspen Test Wealth',
      website: null,
      locality: null,
      regionCode: null,
      status: 'active',
      assignedUserId: null,
      stageKey: null,
      opportunityStatus: null,
      controlMode: null,
      openedAt: null,
      timeZone: 'America/New_York',
      timeZoneUnresolvedReason: null,
      addressLine: null,
      postalCode: null,
      countryCode: 'US',
      timeZoneConfidence: 'high',
      timeZoneSource: 'recorded',
      contacts: [],
      phoneRoutes: [],
      emailRoutes,
      aliases: [],
    },
  },
  opportunity: null,
  stageHistory: [],
  holds: [],
});

const reads = (emailRoutes: readonly RouteDto[]): Record<string, HttpAnswer> => ({
  '/crm/firm-page': { status: 200, body: firmPage(emailRoutes) },
  '/sequences': { status: 200, body: { sequences: [] } },
  '/enrollments': { status: 200, body: { asOf: '2026-09-25T13:00:00.000Z', enrollments: [] } },
});

const bridgeOver = (api: ReturnType<typeof createAuthedClient>) =>
  createCrmBridge({
    api,
    clientVersion: '1.0.6',
    session: { state: async () => await Promise.resolve({ online: true, mayMutate: true, device: { role: 'admin' as const } }) },
  });

describe('an address on the Firm page says where its validation stands (lane g90)', () => {
  it.each([
    [{ eligibility: 'candidate', technicalValidation: 'unknown' }, 'checking', 'Checking…'],
    [{ eligibility: 'usable', technicalValidation: 'passed' }, 'deliverable', 'Deliverable domain — usable'],
    [{ eligibility: 'invalid', technicalValidation: 'failed' }, 'undeliverable', 'Mail can’t reach this address — invalid'],
    [{ eligibility: 'candidate', technicalValidation: 'passed' }, 'deliverable_unconfirmed', 'Deliverable domain — not usable yet'],
  ] as const)('%o is %s', (fields, state, text) => {
    const shown = emailValidationStateOf(route(fields));
    expect(shown).toBe(state);
    expect(shown === null ? null : EMAIL_VALIDATION_TEXT[shown]).toContain(text);
  });

  it('reads an answer without the key by its eligibility, and says nothing for a retired address', () => {
    expect(emailValidationStateOf(route({ eligibility: 'candidate' }))).toBe('checking');
    expect(emailValidationStateOf(route({ eligibility: 'usable' }))).toBe('deliverable');
    expect(emailValidationStateOf(route({ eligibility: 'invalid' }))).toBe('undeliverable');
    expect(emailValidationStateOf(route({ eligibility: 'retired', technicalValidation: 'failed' }))).toBeNull();
  });

  it('parses a route with and without the key, and asks for version 2 and no other', () => {
    expect(routeDtoSchema.safeParse(route({})).success).toBe(true);
    expect(routeDtoSchema.safeParse(route({ technicalValidation: 'passed' })).success).toBe(true);
    expect(firmPageRequestSchema.safeParse({ firmId: FIRM, pageVersion: 2 }).success).toBe(true);
    expect(firmPageRequestSchema.safeParse({ firmId: FIRM, pageVersion: 3 }).success).toBe(false);
    expect(firmPageRequestSchema.safeParse({ firmId: FIRM }).success).toBe(true);
  });

  it('asks the Firm page for its second version', async () => {
    const { api, calls } = scriptedApi(reads([route({ technicalValidation: 'unknown' })]));
    const opened = await bridgeOver(api).openFirm({ firmId: FIRM });
    expect(calls.find(entry => entry.path === '/crm/firm-page')?.body).toMatchObject({ firmId: FIRM, pageVersion: 2 });
    const page = opened.firm;
    expect(page?.read.visibility === 'assigned_or_admin' && page.read.firm.emailRoutes[0]?.technicalValidation).toBe('unknown');
  });

  it('checks an address again at the version on screen, and says a refusal about an address', async () => {
    const queued = scriptedApi({
      ...reads([route({ technicalValidation: 'unknown' })]),
      '/contacts/routes/check': { status: 200, body: { status: 'accepted', replayed: false, result: { routeId: ROUTE, routeVersion: 1, queued: true } } },
    });
    const bridge = bridgeOver(queued.api);
    await bridge.openFirm({ firmId: FIRM });
    const answer = await bridge.checkRoute({ routeId: ROUTE, routeVersion: 1 });
    expect(answer.notice).toBe('route_check_queued');
    expect(queued.calls.find(entry => entry.path === '/contacts/routes/check')?.body).toMatchObject({
      routeKind: 'email',
      routeId: ROUTE,
      routeVersion: 1,
    });
    // The page is read again, so the answer the worker gave is what the window shows next.
    expect(queued.calls.filter(entry => entry.path === '/crm/firm-page')).toHaveLength(2);

    const stale = scriptedApi({
      ...reads([route({ technicalValidation: 'unknown' })]),
      '/contacts/routes/check': { status: 409, body: { status: 'refused', reason: 'route_version_stale' } },
    });
    const refused = await bridgeOver(stale.api).checkRoute({ routeId: ROUTE, routeVersion: 1 });
    expect(refused.notice).toBe('address_changed');
    expect(noticeText('address_changed')).toContain('address');
    expect(noticeText('route_check_queued')).toContain('check that address again');
  });
});
