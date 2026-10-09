import { expect, it } from 'vitest';
import { createAuthedClient } from '../src/main/authedClient.ts';
import { createCrmBridge } from '../src/main/crmBridge.ts';
import { assigneeFirmPage, FIRM_ID } from './e2e/support/crmFixtures.ts';
const SECOND = '22222222-2222-4222-8222-222222222222';
it('reads plural deals without choosing one, then opens precisely the deal selected by a person', async () => {
  const original = assigneeFirmPage();
  if (original.visibility !== 'assigned_or_admin' || !original.opportunity) throw Error('fixture');
  const { opportunity, stageHistory, ...common } = original;
  const entries = [
    { opportunity, stageControlMode: 'human', displayName: 'Portfolio pilot', stageHistory },
    { opportunity: { ...opportunity, id: SECOND }, stageControlMode: 'human', displayName: 'Second initiative', stageHistory: [] },
  ];
  const api = createAuthedClient({
    baseUrl: 'https://api.example.test',
    clientVersion: '1.4.0',
    accessToken: async () => ({ token: 'test', generation: 0 }),
    send: async (url) =>
      new URL(url).pathname === '/crm/firm-page-v3'
        ? { status: 200, body: { ...common, version: 3, opportunities: entries, timeline: { events: [], nextBefore: 'older-page' } } }
        : { status: 404, body: { error: 'not_found' } },
  });
  const bridge = createCrmBridge({
    api,
    clientVersion: '1.4.0',
    session: { state: async () => ({ online: true, mayMutate: true, device: { role: 'admin' } }) },
  });
  const unresolved = await bridge.openFirm({ firmId: FIRM_ID });
  expect(unresolved.firm?.visibility).toBe('assigned_or_admin');
  if (unresolved.firm?.visibility !== 'assigned_or_admin') throw Error('page');
  expect(unresolved.firm.opportunity).toBeNull();
  expect(unresolved.opportunities).toHaveLength(2);
  const selected = await bridge.openFirm({ firmId: FIRM_ID, opportunityId: SECOND });
  if (selected.firm?.visibility !== 'assigned_or_admin') throw Error('page');
  expect(selected.firm.opportunity?.id).toBe(SECOND);
  expect(selected.firm.stageHistory).toEqual([]);
  expect(await bridge.firmTimeline({ firmId: FIRM_ID, before: 'older-page' })).toEqual({
    timeline: { events: [], nextBefore: 'older-page' },
  });
  await bridge.forget();
  expect((await bridge.state()).opportunities).toBeUndefined();
});

it('opens an empty firm through the explicit manual-stage creation path on a plural-capable server', async () => {
  const original = assigneeFirmPage();
  if (original.visibility !== 'assigned_or_admin' || !original.opportunity) throw Error('fixture');
  const { opportunity, stageHistory: _history, ...common } = original;
  let created = false;
  const paths: string[] = [];
  const api = createAuthedClient({
    baseUrl: 'https://api.example.test',
    clientVersion: '1.4.0',
    accessToken: async () => ({ token: 'test', generation: 0 }),
    send: async (url) => {
      const path = new URL(url).pathname;
      paths.push(path);
      if (path === '/crm/firm-page-v3')
        return {
          status: 200,
          body: {
            ...common,
            version: 3,
            opportunities: created ? [{ opportunity, stageControlMode: 'human', displayName: null, stageHistory: [] }] : [],
          },
        };
      if (path === '/opportunities/v2/open') {
        created = true;
        return { status: 200, body: { status: 'accepted', replayed: false, result: { opportunityId: opportunity.id } } };
      }
      return { status: 404, body: { error: 'not_found' } };
    },
  });
  const bridge = createCrmBridge({
    api,
    clientVersion: '1.4.0',
    session: { state: async () => ({ online: true, mayMutate: true, device: { role: 'admin' } }) },
  });
  await bridge.openFirm({ firmId: FIRM_ID });
  const opened = await bridge.openOpportunity();
  expect(paths).toContain('/opportunities/v2/open');
  expect(opened.notice).toBe('opportunity_opened');
  expect(opened.opportunities?.[0]?.stageControlMode).toBe('human');
});
