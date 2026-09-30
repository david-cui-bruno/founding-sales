import { describe, expect, it } from 'vitest';
import type { HttpAnswer } from '../src/main/apiClient.ts';
import { createAuthedClient } from '../src/main/authedClient.ts';
import { createCrmBridge } from '../src/main/crmBridge.ts';

/**
 * The bridge half of the Kanban (slice K), over the real transport against scripted
 * answers: what the board read asks for, what it hands the window, and the exact body of
 * the value command. No real firm appears: `example.test` is reserved by RFC 6761.
 */

const OPP = '99999999-9999-4999-8999-999999999999';
const FIRM = '11111111-1111-4111-8111-111111111111';
const STAGE = (key: string, position: number, terminalKind: 'won' | 'lost' | null = null) => ({
  id: `00000000-0000-4000-8000-00000000000${String(position)}`,
  key,
  displayName: key,
  position,
  terminalKind,
  retired: false,
});

function scripted(board: (body: Record<string, unknown> | null) => HttpAnswer) {
  const calls: { path: string; body: Record<string, unknown> | null }[] = [];
  const api = createAuthedClient({
    baseUrl: 'https://api.example.test/',
    clientVersion: '1.0.6',
    accessToken: async () => await Promise.resolve({ token: 'token-value', generation: 0 }),
    send: async (url, init) => {
      const path = new URL(url).pathname;
      const body = init.body === undefined ? null : (JSON.parse(init.body) as Record<string, unknown>);
      calls.push({ path, body });
      if (path === '/pipeline/board') return await Promise.resolve(board(body));
      if (path === '/opportunities/value') return await Promise.resolve({ status: 200, body: { status: 'accepted', replayed: false, result: { opportunityId: OPP } } });
      return await Promise.resolve({ status: 404, body: { error: 'not_found' } });
    },
  });
  const bridge = createCrmBridge({
    api,
    clientVersion: '1.0.6',
    session: { state: async () => await Promise.resolve({ online: true, mayMutate: true, device: { role: 'admin' as const } }) },
  });
  return { bridge, calls };
}

const boardAnswer = (body: Record<string, unknown> | null): HttpAnswer => {
  const includeLost = body?.['includeLost'] === true;
  const stages = [STAGE('new', 1), STAGE('won', 2, 'won'), STAGE('lost', 3, 'lost')];
  return {
    status: 200,
    body: {
      columns: stages.filter(stage => includeLost || stage.key !== 'lost').map(stage => ({ stage, firms: [] })),
      opportunityIdByFirmId: { [FIRM]: OPP },
      unplacedFirms: [],
      cards: { [FIRM]: { value: { monthlyCents: 120000, kind: 'agreed' }, meeting: null, evidence: null, pinned: true, closeReason: null } },
      stages,
    },
  };
};

describe('the Kanban through the CRM bridge', () => {
  it('hands the window the cards and every stage, and asks for Lost only when told to, remembering the answer', async () => {
    const { bridge, calls } = scripted(boardAnswer);
    const plain = await bridge.openPipeline();
    expect(calls.at(-1)?.body).toEqual({});
    expect(plain.pipeline?.columns.map(column => column.stage.key)).toEqual(['new', 'won']);
    expect(plain.pipeline?.stages?.map(stage => stage.key)).toEqual(['new', 'won', 'lost']);
    expect(plain.pipeline?.cards?.[FIRM]).toMatchObject({ pinned: true, value: { kind: 'agreed' } });
    expect(plain.pipeline?.includeLost).toBe(false);

    const withLost = await bridge.openPipeline({ includeLost: true });
    expect(calls.at(-1)?.body).toEqual({ includeLost: true });
    expect(withLost.pipeline?.columns.map(column => column.stage.key)).toEqual(['new', 'won', 'lost']);
    expect(withLost.pipeline?.includeLost).toBe(true);

    // Coming back from a firm page reads the board again without saying anything: the
    // filter stays as the person left it. An identity change forgets it.
    const back = await bridge.openPipeline();
    expect(calls.at(-1)?.body).toEqual({ includeLost: true });
    expect(back.pipeline?.includeLost).toBe(true);
    await bridge.forget();
    await bridge.openPipeline();
    expect(calls.at(-1)?.body).toEqual({});
  });

  it('sends the value in whole cents with its kind, then reads the board again', async () => {
    const { bridge, calls } = scripted(boardAnswer);
    await bridge.openPipeline();
    const state = await bridge.setValue({ opportunityId: OPP, monthlyCents: 120_000, kind: 'estimated' });
    expect(calls.find(entry => entry.path === '/opportunities/value')?.body).toMatchObject({
      opportunityId: OPP,
      monthlyCents: 120_000,
      kind: 'estimated',
    });
    expect(state.notice).toBe('value_recorded');
    expect(calls.at(-1)?.path).toBe('/pipeline/board');
  });
});
