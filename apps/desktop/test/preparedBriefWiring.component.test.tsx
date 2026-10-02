// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
 * Lane PB: the firm page draws the prepared brief the firm page read negotiated, offers an
 * administrator Edit, and reads the page again after a save.
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
      case 'firms.setPreparedBrief':
        return { saved: { firmId: FIRM_ID, created: false, briefLength: 6, sourceCount: 1, updatedAt: BRIEF.updatedAt }, reason: null };
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
    read: async (name: string, input: unknown) => await Promise.resolve(answer(name, input)),
    command: async (name: string, input: unknown) => await Promise.resolve(answer(name, input)),
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
  it('shows the brief to an administrator with Edit, saves only the text, and reads the page again', async () => {
    const user = userEvent.setup();
    install('admin', BRIEF);
    mount();
    expect((await screen.findByTestId('prepared-brief-text')).textContent).toBe(BRIEF.brief);
    await user.click(screen.getByTestId('prepared-brief-edit'));
    await user.clear(screen.getByTestId('prepared-brief-text-input'));
    await user.type(screen.getByTestId('prepared-brief-text-input'), 'Edited');
    const before = calls.filter(call => call.name === 'crm.openFirm').length;
    await user.click(screen.getByTestId('prepared-brief-save'));
    await waitFor(() => expect(calls.filter(call => call.name === 'crm.openFirm').length).toBeGreaterThan(before));
    expect(calls.filter(call => call.name === 'firms.setPreparedBrief').map(call => call.input)).toEqual([{ firmId: FIRM_ID, brief: 'Edited' }]);
  });

  it('shows a salesperson the brief without Edit, and nothing when the firm has none', async () => {
    install('salesperson', BRIEF);
    const { unmount } = mount();
    await screen.findByTestId('prepared-brief-text');
    expect(screen.queryByTestId('prepared-brief-edit')).toBeNull();
    unmount();
    install('salesperson', null);
    mount();
    await screen.findByTestId('firms');
    expect(screen.queryByTestId('prepared-brief')).toBeNull();
  });
});
