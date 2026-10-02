import { describe, expect, it, vi } from 'vitest';
import type { PreparedBriefDto } from '@fss/contracts';
import type { AuthedClient } from '../src/main/authedClient.ts';
import { operationHandlers, type OperationHostDeps } from '../src/main/operationHost.ts';
import { patchCrmState, patchTodayState } from '../src/renderer/research/patchPreparedBrief.ts';
import type { CrmState } from '../src/renderer/firmWorkspaceContract.ts';
import type { TodayState } from '../src/renderer/todayContract.ts';
import { assigneeFirmPage, crmState } from './e2e/support/crmFixtures.ts';

/**
 * Lane PB, design reset I2: a save or clear answers the stored brief, which is patched into
 * what is held for THAT firm — in the main process's snapshots and in the window's cache —
 * and into nothing else. No read and no navigation follows.
 */

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const STORED: PreparedBriefDto = {
  brief: 'Stored text',
  sources: [{ url: 'https://firm.example.test/', label: 'Source' }],
  observedOn: '2026-10-02',
  preparedBy: 'Callie research agent (web), verified phones',
  updatedAt: '2026-10-02T16:00:00.000Z',
};

describe('the main process patches its snapshots and reads nothing', () => {
  it('set and clear patch that firm in the CRM and Today bridges, with no other request', async () => {
    const requests: string[] = [];
    const api = {
      read: vi.fn(async (path: string) => {
        requests.push(`read ${path}`);
        return await Promise.resolve({ ok: false as const, reason: 'unexpected', offline: false });
      }),
      command: vi.fn(async (path: string, body: Record<string, unknown>, parse: (value: unknown) => unknown) => {
        requests.push(`command ${path}`);
        const value =
          path === '/firms/brief/set'
            ? { firmId: body['firmId'], created: false, briefLength: 11, sourceCount: 1, updatedAt: STORED.updatedAt, brief: STORED }
            : { firmId: body['firmId'], cleared: true, brief: null };
        return await Promise.resolve({ ok: true as const, value: parse(value) });
      }),
    };
    const crmPatches: unknown[] = [];
    const todayPatches: unknown[] = [];
    const handlers = operationHandlers({
      api: api as unknown as AuthedClient,
      crm: { patchPreparedBrief: async (input: unknown) => void crmPatches.push(input) },
      today: { patchPreparedBrief: async (input: unknown) => void todayPatches.push(input) },
    } as unknown as OperationHostDeps);
    const saved = (await handlers['firms.setPreparedBrief']({ firmId: A, brief: 'Stored text' } as never)) as { saved: { brief: PreparedBriefDto } };
    expect(saved.saved.brief).toEqual(STORED);
    await handlers['firms.clearPreparedBrief']({ firmId: A } as never);
    expect(crmPatches).toEqual([{ firmId: A, brief: STORED }, { firmId: A, brief: null }]);
    expect(todayPatches).toEqual(crmPatches);
    expect(requests).toEqual(['command /firms/brief/set', 'command /firms/brief/clear']);
  });
});

describe('the window patches only that firm’s cached data', () => {
  const page = assigneeFirmPage();
  const firmState = (firmId: string): CrmState =>
    crmState({ screen: 'firm', firm: { ...page, read: { ...page.read, firm: { ...page.read.firm, id: firmId } } } as NonNullable<CrmState['firm']> });

  it('patches the firm page of that firm and leaves another firm’s alone', () => {
    const patched = patchCrmState(firmState(A), A, STORED);
    expect(patched?.firm?.visibility === 'assigned_or_admin' && patched.firm.preparedBrief).toEqual(STORED);
    const other = firmState(B);
    expect(patchCrmState(other, A, STORED)).toBe(other);
  });

  it('patches Today’s card of that firm and leaves another firm’s alone', () => {
    const today = (firmId: string) => ({ expanded: { firmId, preparedBrief: null } }) as unknown as TodayState;
    expect(patchTodayState(today(A), A, STORED)?.expanded?.preparedBrief).toEqual(STORED);
    const other = today(B);
    expect(patchTodayState(other, A, STORED)).toBe(other);
  });
});
