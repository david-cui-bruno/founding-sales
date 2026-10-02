// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PreparedBriefDto } from '@fss/contracts';
import { createGeneration } from '../src/renderer/app/generation.ts';
import { DraftsProvider } from '../src/renderer/app/drafts.tsx';
import { FirmsRoute } from '../src/renderer/firms/FirmsRoute.tsx';
import { resetCrmMemory } from '../src/renderer/firms/crmMemory.ts';
import type { CrmState } from '../src/renderer/firmWorkspaceContract.ts';
import type { OperationApi } from '../src/shared/operations.ts';
import { assigneeFirmPage, crmState, FIRM_ID, pipelineView } from './e2e/support/crmFixtures.ts';

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
/** When set, the save waits for the test to answer it. */
let heldSave: ((value: unknown) => void) | null = null;
let holdSave = false;
/** When set, the board read (Back) waits for the test to answer it. */
let heldBoard: ((value: unknown) => void) | null = null;
let holdBoard = false;

const savedAnswer = (text: string) => ({
  saved: { firmId: FIRM_ID, created: false, briefLength: text.length, sourceCount: 1, updatedAt: '2026-10-02T16:00:00.000Z', brief: { ...BRIEF, brief: text, updatedAt: '2026-10-02T16:00:00.000Z' } },
  reason: null,
});

function install(role: 'admin' | 'salesperson', brief: PreparedBriefDto | null): void {
  calls = [];
  const page = assigneeFirmPage();
  const firm = { ...page, ...(page.visibility === 'assigned_or_admin' ? { preparedBrief: brief } : {}) } as NonNullable<CrmState['firm']>;
  const state = crmState({ screen: 'firm', firm, role });
  const board = crmState({ screen: 'pipeline', firm: null, pipeline: pipelineView(), role });
  const answer = (name: string, input: unknown): unknown => {
    calls.push({ name, input });
    switch (name) {
      case 'crm.state':
      case 'crm.openFirm':
        return state;
      case 'crm.openPipeline':
        if (holdBoard) return new Promise(resolve => (heldBoard = resolve)).then(() => board);
        return board;
      case 'firms.setPreparedBrief':
        if (holdSave) return new Promise(resolve => (heldSave = resolve));
        return savedAnswer('Edited');
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
  holdSave = false;
  heldSave = null;
  holdBoard = false;
  heldBoard = null;
  resetCrmMemory();
  source.note(0);
});
afterEach(() => {
  cleanup();
  resetCrmMemory();
  globalThis.callieApi = undefined;
});

describe('the firm page and the prepared brief', () => {
  it('saves only the text and patches the page with the stored brief, reading nothing (design reset I2)', async () => {
    const user = userEvent.setup();
    install('admin', BRIEF);
    mount();
    expect((await screen.findByTestId('prepared-brief-text')).textContent).toBe(BRIEF.brief);
    await user.click(screen.getByTestId('prepared-brief-edit'));
    await user.clear(screen.getByTestId('prepared-brief-text-input'));
    await user.type(screen.getByTestId('prepared-brief-text-input'), 'Edited');
    const reads = calls.filter(call => call.name.startsWith('crm.')).length;
    await user.click(screen.getByTestId('prepared-brief-save'));
    await waitFor(() => expect(screen.getByTestId('prepared-brief-text').textContent).toBe('Edited'));
    expect(calls.filter(call => call.name === 'firms.setPreparedBrief').map(call => call.input)).toEqual([{ firmId: FIRM_ID, brief: 'Edited' }]);
    expect(calls.filter(call => call.name.startsWith('crm.')).length).toBe(reads);
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

  it('a save answering while Back is still loading leaves the destination where David sent it (PBF finding 1)', async () => {
    const user = userEvent.setup();
    install('admin', BRIEF);
    holdSave = true;
    mount();
    await user.click(await screen.findByTestId('prepared-brief-edit'));
    await user.clear(screen.getByTestId('prepared-brief-text-input'));
    await user.type(screen.getByTestId('prepared-brief-text-input'), 'Late');
    await user.click(screen.getByTestId('prepared-brief-save'));
    await waitFor(() => expect(heldSave).not.toBeNull());
    holdBoard = true;
    await user.click(screen.getByTestId('back-to-pipeline'));
    await waitFor(() => expect(heldBoard).not.toBeNull());
    const openFirms = calls.filter(call => call.name === 'crm.openFirm').length;
    // A's save answers first, then the board.
    await act(async () => {
      heldSave?.(savedAnswer('Late'));
      await Promise.resolve();
    });
    await act(async () => {
      heldBoard?.(undefined);
      await Promise.resolve();
    });
    await screen.findByTestId('firms-list');
    expect(screen.queryByTestId('prepared-brief')).toBeNull();
    expect(calls.filter(call => call.name === 'crm.openFirm').length).toBe(openFirms);
  });
});
