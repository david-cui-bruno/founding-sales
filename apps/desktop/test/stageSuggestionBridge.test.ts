import { describe, expect, it } from 'vitest';
import type { HttpAnswer } from '../src/main/apiClient.ts';
import { createAuthedClient } from '../src/main/authedClient.ts';
import { createCrmBridge } from '../src/main/crmBridge.ts';
import { OPERATIONS } from '../src/shared/operations.ts';
import { assigneeFirmPage, FIRM_ID, OPPORTUNITY_ID, OTHER_FIRM_ID } from './e2e/support/crmFixtures.ts';

/**
 * Lane M1, review M1R: the "Move to Demo booked" suggestion through the CRM bridge, over the
 * real transport against scripted answers.
 *
 *   * Finding 2 — the no-deal open names the firm whose suggestion was drawn. The bridge's own
 *     page is whichever firm read landed last, which an abandoned firm's late read can make a
 *     different firm from the one on screen.
 *   * Finding 6 — the move carries the stage the person saw; a refusal because the deal moved
 *     reads the board and the open page again.
 *
 * No real firm: `example.test` is reserved by RFC 6761.
 */

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

/** The assignee's firm page for `firmId`, with no deal. */
function pageFor(firmId: string): unknown {
  const page = assigneeFirmPage();
  if (page.visibility !== 'assigned_or_admin') throw new Error('fixture');
  return JSON.parse(JSON.stringify({ ...page, opportunity: null, read: { ...page.read, firm: { ...page.read.firm, id: firmId } } }));
}

function scripted(answer: (path: string, body: Record<string, unknown> | null) => Promise<HttpAnswer | null> | HttpAnswer | null) {
  const calls: { path: string; body: Record<string, unknown> | null }[] = [];
  const api = createAuthedClient({
    baseUrl: 'https://api.example.test/',
    clientVersion: '1.0.36',
    accessToken: async () => await Promise.resolve({ token: 'token-value', generation: 0 }),
    send: async (url, init) => {
      const path = new URL(url).pathname;
      const body = init.body === undefined ? null : (JSON.parse(init.body) as Record<string, unknown>);
      calls.push({ path, body });
      return (await answer(path, body)) ?? { status: 404, body: { error: 'not_found' } };
    },
  });
  const bridge = createCrmBridge({
    api,
    clientVersion: '1.0.36',
    session: { state: async () => await Promise.resolve({ online: true, mayMutate: true, device: { role: 'admin' as const } }) },
  });
  return { bridge, calls };
}

const accepted = (result: unknown): HttpAnswer => ({ status: 200, body: { status: 'accepted', replayed: false, result } });

describe('the stage suggestion through the CRM bridge (review M1R)', () => {
  it('finding 2: the no-deal open names the firm whose suggestion was drawn, after an older firm read lands', async () => {
    const late = deferred<HttpAnswer>();
    let firstRead = true;
    const { bridge, calls } = scripted(async (path, body) => {
      if (path === '/crm/firm-page') {
        const firmId = String(body?.['firmId']);
        if (firmId === FIRM_ID && firstRead) {
          firstRead = false;
          return await late.promise;
        }
        return { status: 200, body: pageFor(firmId) };
      }
      if (path === '/opportunities/open') return accepted({ opportunityId: OPPORTUNITY_ID });
      return null;
    });
    // A opened, then B; A's read lands last and becomes the bridge's page.
    const abandoned = bridge.openFirm({ firmId: FIRM_ID });
    const displayed = await bridge.openFirm({ firmId: OTHER_FIRM_ID });
    expect(displayed.firm?.read.firm.id).toBe(OTHER_FIRM_ID);
    late.resolve({ status: 200, body: pageFor(FIRM_ID) });
    expect((await abandoned).firm?.read.firm.id).toBe(FIRM_ID);
    // The person clicks the suggestion drawn for B.
    await bridge.openOpportunity({ firmId: OTHER_FIRM_ID, stageKey: 'demo_booked' });
    const opens = calls.filter(call => call.path === '/opportunities/open');
    expect(opens).toHaveLength(1);
    expect(opens[0]?.body).toMatchObject({ firmId: OTHER_FIRM_ID, stageKey: 'demo_booked' });
    // And the page read again is B's.
    expect(calls.filter(call => call.path === '/crm/firm-page').at(-1)?.body?.['firmId']).toBe(OTHER_FIRM_ID);
  });

  it('finding 2: the window cannot ask for a stage without naming the firm', () => {
    const input = OPERATIONS['crm.openOpportunity'].input;
    expect(input.safeParse({ stageKey: 'demo_booked' }).success).toBe(false);
    expect(input.safeParse({ firmId: OTHER_FIRM_ID, stageKey: 'demo_booked' }).success).toBe(true);
    // "Add to pipeline" still opens the open page's firm at the first stage.
    expect(input.safeParse({}).success).toBe(true);
  });

  it('finding 6: the move sends the stage the person saw, and a refusal because it moved reads the board again', async () => {
    let refuse = true;
    const { bridge, calls } = scripted(path => {
      if (path === '/opportunities/stage') {
        return refuse ? { status: 409, body: { status: 'refused', reason: 'stage_changed_elsewhere' } } : accepted({ opportunityId: OPPORTUNITY_ID });
      }
      if (path === '/pipeline/board') {
        const stage = { id: '00000000-0000-4000-8000-000000000001', key: 'new', displayName: 'New', position: 1, terminalKind: null, retired: false };
        return { status: 200, body: { columns: [{ stage, firms: [] }], opportunityIdByFirmId: {}, unplacedFirms: [], cards: {}, stages: [stage] } };
      }
      return null;
    });
    const refused = await bridge.changeStage({ opportunityId: OPPORTUNITY_ID, toStageKey: 'demo_booked', reason: null, expectedStageKey: 'new' });
    expect(calls.find(call => call.path === '/opportunities/stage')?.body).toMatchObject({
      opportunityId: OPPORTUNITY_ID,
      toStageKey: 'demo_booked',
      expectedStageKey: 'new',
    });
    expect(refused.notice).toBe('stage_changed_elsewhere');
    expect(calls.some(call => call.path === '/pipeline/board')).toBe(true);
    refuse = false;
    calls.length = 0;
    // A move with no expectation sends none.
    await bridge.changeStage({ opportunityId: OPPORTUNITY_ID, toStageKey: 'demo_booked', reason: null });
    expect(calls.find(call => call.path === '/opportunities/stage')?.body).not.toHaveProperty('expectedStageKey');
  });
});
