// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PreparedBriefDto } from '@fss/contracts';
import { createGeneration } from '../src/renderer/app/generation.ts';
import { DraftsProvider } from '../src/renderer/app/drafts.tsx';
import { FirmsRoute } from '../src/renderer/firms/FirmsRoute.tsx';
import { resetCrmMemory } from '../src/renderer/firms/crmMemory.ts';
import type { CrmState } from '../src/renderer/firmWorkspaceContract.ts';
import type { OperationApi } from '../src/shared/operations.ts';
import { assigneeFirmPage, crmState, FIRM_ID } from './e2e/support/crmFixtures.ts';

/**
 * Lane PB: the firm page draws the prepared brief the firm page read negotiated, read-only
 * for everyone (scope reduction after review PBR).
 */

const BRIEF: PreparedBriefDto = {
  brief: 'Who to ask for: Pat Placeholder, Owner (confirmed)',
  sources: [{ url: 'https://firm.example.test/contact', label: 'Phone source' }],
  observedOn: '2026-10-02',
  preparedBy: 'Callie research agent (web), verified phones',
  updatedAt: '2026-10-02T15:00:00.000Z',
};

const source = createGeneration();
let calls: { name: string; input: unknown }[] = [];

function install(role: 'admin' | 'salesperson', brief: PreparedBriefDto | null): void {
  calls = [];
  const page = assigneeFirmPage();
  const firm = { ...page, ...(page.visibility === 'assigned_or_admin' ? { preparedBrief: brief } : {}) } as NonNullable<CrmState['firm']>;
  const state = crmState({ screen: 'firm', firm, role });
  const answer = (name: string, input: unknown): unknown => {
    calls.push({ name, input });
    switch (name) {
      case 'crm.state':
      case 'crm.openFirm':
        return state;
      case 'research.open':
        return { firm: null, settings: null, worstCaseRunCents: null, spend: null, notice: null, mayMutate: true, role };
      case 'calling.history':
        return { calls: null };
      case 'meetings.forFirm':
      case 'meetings.unmatched':
        return { meetings: [] };
      default:
        throw new Error(`unexpected operation ${name}`);
    }
  };
  globalThis.callieApi = {
    read: async (name: string, input: unknown) => await answer(name, input),
    command: async (name: string, input: unknown) => await answer(name, input),
  } as unknown as OperationApi;
}

const mount = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  return render(
    <QueryClientProvider client={client}>
      <DraftsProvider>
        <FirmsRoute route={{ name: 'firm', firmId: FIRM_ID }} identity="person-1" generation={source.current()} guard={source.guard} />
      </DraftsProvider>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  resetCrmMemory();
  source.note(0);
});
afterEach(() => {
  cleanup();
  resetCrmMemory();
  globalThis.callieApi = undefined;
});

describe('the firm page and the prepared brief', () => {
  for (const role of ['admin', 'salesperson'] as const) {
    it(`shows ${role === 'admin' ? 'an administrator' : 'a salesperson'} the negotiated brief, read-only`, async () => {
      install(role, BRIEF);
      mount();
      expect((await screen.findByTestId('prepared-brief-text')).textContent).toBe(BRIEF.brief);
      expect(screen.getByTestId('prepared-brief-provenance').textContent).toContain('not verified by Callie');
      expect(screen.queryByTestId('prepared-brief-edit')).toBeNull();
      expect(calls.some(call => call.name.startsWith('firms.'))).toBe(false);
    });
  }

  it('draws nothing when the firm has no prepared brief', async () => {
    install('admin', null);
    mount();
    await screen.findByTestId('firms');
    expect(screen.queryByTestId('prepared-brief')).toBeNull();
  });
});
