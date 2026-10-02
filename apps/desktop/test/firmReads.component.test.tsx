// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BoardCard, FirmTimeline as TimelineDto } from '@fss/contracts';
import { createGeneration } from '../src/renderer/app/generation.ts';
import { DraftsProvider } from '../src/renderer/app/drafts.tsx';
import { resetCrmMemory } from '../src/renderer/firms/crmMemory.ts';
import { CallNote } from '../src/renderer/calling/CallHistory.tsx';
import { FirmTimeline, timelineSummary, type TimelinePorts } from '../src/renderer/firms/FirmTimeline.tsx';
import { FirmsRoute } from '../src/renderer/firms/FirmsRoute.tsx';
import type { CrmState } from '../src/renderer/firmWorkspaceContract.ts';
import type { OperationApi } from '../src/shared/operations.ts';
import { assigneeFirmPage, crmState, FIRM_ID, OTHER_FIRM_ID, pipelineView } from './e2e/support/crmFixtures.ts';

/**
 * The kept-state tests for the firm page's new reads (S4F, written before the feature):
 * the activity timeline's "Show more", and the keys that must not run a command.
 *
 *  * remount keeps what was loaded (K1/K3, UI criterion 7);
 *  * a read in flight when the session ends is discarded (K1);
 *  * a late answer for another firm never shows on this one (K7);
 *  * J/K then Enter run no command (K4).
 *
 * No real firm appears: `example.test` is reserved by RFC 6761.
 */

const at = (n: number): string => new Date(Date.UTC(2026, 9, 1, 12, 0, 0) - n * 3_600_000).toISOString();
const event = (n: number, prefix = 'a') => ({ key: `${prefix}:${String(n)}`, at: at(n), kind: 'call' as const, code: 'interested', detail: null });
const page = (from: number, count: number, next: string | null, prefix = 'a'): TimelineDto => ({
  events: Array.from({ length: count }, (_, index) => event(from + index, prefix)),
  nextBefore: next,
});

const source = createGeneration();

function ports(answers: Record<string, Promise<{ timeline: TimelineDto | null }>>, asked: { firmId: string; before: string }[] = []): TimelinePorts {
  return {
    more: async (firmId, before) => {
      asked.push({ firmId, before });
      return await (answers[firmId] ?? Promise.resolve({ timeline: null }));
    },
  };
}

function Timeline({ firmId, first, timelinePorts }: { readonly firmId: string; readonly first: TimelineDto; readonly timelinePorts: TimelinePorts }): JSX.Element {
  return (
    <DraftsProvider>
      <FirmTimeline firmId={firmId} timeline={first} ports={timelinePorts} guard={source.guard} stageName={key => key} />
    </DraftsProvider>
  );
}

beforeEach(() => {
  resetCrmMemory();
  source.note(0);
});
afterEach(() => {
  cleanup();
  resetCrmMemory();
  globalThis.callieApi = undefined;
});

describe('the timeline keeps what was loaded (remount)', () => {
  it('shows the first page, loads the next on request, and still has it after unmount and remount', async () => {
    const first = page(0, 50, at(49));
    const asked: { firmId: string; before: string }[] = [];
    const p = ports({ [FIRM_ID]: Promise.resolve({ timeline: page(50, 10, null) }) }, asked);
    const view = render(<Timeline firmId={FIRM_ID} first={first} timelinePorts={p} />);
    expect(screen.getAllByTestId('timeline-row')).toHaveLength(50);
    await userEvent.click(screen.getByTestId('timeline-more'));
    await waitFor(() => {
      expect(screen.getAllByTestId('timeline-row')).toHaveLength(60);
    });
    view.unmount();
    render(<Timeline firmId={FIRM_ID} first={first} timelinePorts={p} />);
    expect(screen.getAllByTestId('timeline-row')).toHaveLength(60);
    expect(asked).toHaveLength(1);
    expect(screen.queryByTestId('timeline-more')).toBeNull();
  });
});

describe('a read in flight when the session ends is discarded', () => {
  it('does not append the answer to the new session', async () => {
    const first = page(0, 50, at(49));
    let release: (value: { timeline: TimelineDto | null }) => void = () => undefined;
    const slow = new Promise<{ timeline: TimelineDto | null }>(resolve => {
      release = resolve;
    });
    const p = ports({ [FIRM_ID]: slow });
    const view = render(<Timeline firmId={FIRM_ID} first={first} timelinePorts={p} />);
    await userEvent.click(screen.getByTestId('timeline-more'));
    view.unmount();
    source.note(source.current() + 1);
    resetCrmMemory();
    render(<Timeline firmId={FIRM_ID} first={first} timelinePorts={p} />);
    await act(async () => {
      release({ timeline: page(50, 10, null) });
      await slow;
    });
    expect(screen.getAllByTestId('timeline-row')).toHaveLength(50);
    expect(screen.getByTestId('timeline-more')).toBeTruthy();
    // And it is not waiting to appear on the next draw either.
    cleanup();
    render(<Timeline firmId={FIRM_ID} first={first} timelinePorts={p} />);
    expect(screen.getAllByTestId('timeline-row')).toHaveLength(50);
  });
});

describe('a late answer for another firm is never shown here (K7)', () => {
  it('keeps firm B\'s timeline free of firm A\'s late page', async () => {
    let release: (value: { timeline: TimelineDto | null }) => void = () => undefined;
    const slow = new Promise<{ timeline: TimelineDto | null }>(resolve => {
      release = resolve;
    });
    const p = ports({ [FIRM_ID]: slow });
    const a = render(<Timeline firmId={FIRM_ID} first={page(0, 50, at(49), 'a')} timelinePorts={p} />);
    await userEvent.click(screen.getByTestId('timeline-more'));
    a.unmount();
    render(<Timeline firmId={OTHER_FIRM_ID} first={page(0, 3, null, 'b')} timelinePorts={p} />);
    await act(async () => {
      release({ timeline: page(50, 10, null, 'a') });
      await slow;
    });
    const keys = screen.getAllByTestId('timeline-row').map(row => row.getAttribute('data-key'));
    expect(keys).toHaveLength(3);
    expect(keys.every(key => key?.startsWith('b:') === true)).toBe(true);
    // Drawn again, B is still B's; and A's late page is there for A, cached under A.
    cleanup();
    render(<Timeline firmId={OTHER_FIRM_ID} first={page(0, 3, null, 'b')} timelinePorts={p} />);
    expect(screen.getAllByTestId('timeline-row')).toHaveLength(3);
    cleanup();
    render(<Timeline firmId={FIRM_ID} first={page(0, 50, at(49), 'a')} timelinePorts={p} />);
    expect(screen.getAllByTestId('timeline-row')).toHaveLength(60);
  });
});

describe('J/K then Enter run no command (K4)', () => {
  const card = (): BoardCard => ({ value: null, meeting: null, evidence: null, pinned: false, closeReason: null });

  it('with a command button focused, J then Enter sends nothing', async () => {
    const calls: string[] = [];
    const state: CrmState = crmState({ screen: 'pipeline', firm: null, pipeline: { ...pipelineView(), cards: { [FIRM_ID]: card() } } });
    const answer = (name: string): unknown => {
      calls.push(name);
      if (name === 'crm.openFirm') return { ...state, screen: 'firm', firm: assigneeFirmPage() };
      if (name === 'crm.openPipeline' || name === 'crm.state') return state;
      if (name === 'research.open') return { firm: null, settings: null, worstCaseRunCents: null, spend: null, notice: null, mayMutate: true, role: 'salesperson' };
      if (name === 'calling.history') return { calls: null };
      if (name === 'meetings.forFirm' || name === 'meetings.unmatched') return { meetings: [] };
      return state;
    };
    globalThis.callieApi = {
      read: async (name: string) => await Promise.resolve(answer(name)),
      command: async (name: string) => await Promise.resolve(answer(name)),
    } as unknown as OperationApi;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
    render(
      <QueryClientProvider client={client}>
        <DraftsProvider>
          <FirmsRoute route={{ name: 'pipeline' }} identity="person-1" generation={0} guard={source.guard} />
        </DraftsProvider>
      </QueryClientProvider>,
    );
    const row = (await screen.findAllByTestId('pipeline-firm'))[0] as HTMLElement;
    await userEvent.click(within(row).getByTestId('card-move'));
    await userEvent.selectOptions(within(row).getByTestId('stage-select'), 'engaged');
    within(row).getByTestId('stage-submit').focus();
    await userEvent.keyboard('j');
    await userEvent.keyboard('{Enter}');
    expect(calls.filter(name => name === 'crm.changeStage')).toEqual([]);
  });
});

describe('what each row says (codes in words, never a body or an address)', () => {
  const words = (event: Parameters<typeof timelineSummary>[0]): string => timelineSummary(event, key => key.replace('_', ' '));
  const base = { key: 'k', at: at(0) };
  it('puts each kind in a line from its codes', () => {
    expect(words({ ...base, kind: 'call', code: 'interested', detail: null })).toBe('Conversation');
    expect(words({ ...base, kind: 'outcome_corrected', code: 'interested', detail: 'no_answer' })).toContain('to');
    expect(words({ ...base, kind: 'email_received', code: null, detail: 'Re: pricing' })).toBe('Re: pricing');
    expect(words({ ...base, kind: 'stage_change', code: 'demo_booked', detail: 'new' })).toBe('new to demo booked');
    expect(words({ ...base, kind: 'stop_recorded', code: 'email', detail: 'firm' })).toBe('E-mail stopped for the firm');
    expect(words({ ...base, kind: 'stop_lifted', code: 'all', detail: 'handle' })).toBe('All contact stopped for one contact');
  });
  it('never shows a code it has no word for', () => {
    expect(words({ ...base, kind: 'call', code: 'brand_new_outcome', detail: null })).toBe('an outcome');
  });
});

describe('a failed "Show more" says so next to the button, and Retry works', () => {
  it('shows the problem beside the control and asks again on the next press', async () => {
    const first = page(0, 50, at(49));
    let attempt = 0;
    const p: TimelinePorts = {
      more: async () => {
        attempt += 1;
        return await Promise.resolve({ timeline: attempt === 1 ? null : page(50, 5, null) });
      },
    };
    render(<Timeline firmId={FIRM_ID} first={first} timelinePorts={p} />);
    await userEvent.click(screen.getByTestId('timeline-more'));
    expect((await screen.findByTestId('timeline-problem')).textContent).toContain('could not load more');
    await userEvent.click(screen.getByTestId('timeline-more'));
    await waitFor(() => {
      expect(screen.getAllByTestId('timeline-row')).toHaveLength(55);
    });
    expect(screen.queryByTestId('timeline-problem')).toBeNull();
  });
});

describe('a call note keeps its open state (remount)', () => {
  const NOTE = 'Wants pricing for 650 doors. '.repeat(8);
  it('shows two lines, opens on request, and is still open after unmount and remount', async () => {
    const view = render(<CallNote sessionId="s1" note={NOTE} />);
    expect(screen.getByTestId('call-note-text').className).toContain('line-clamp-2');
    await userEvent.click(screen.getByTestId('call-note-toggle'));
    expect(screen.getByTestId('call-note-text').className).not.toContain('line-clamp-2');
    view.unmount();
    render(<CallNote sessionId="s1" note={NOTE} />);
    expect(screen.getByTestId('call-note-text').className).not.toContain('line-clamp-2');
    cleanup();
    render(<CallNote sessionId="s2" note={NOTE} />);
    expect(screen.getByTestId('call-note-text').className).toContain('line-clamp-2');
  });
  it('a short note has no toggle', () => {
    render(<CallNote sessionId="s3" note="Left a voicemail." />);
    expect(screen.queryByTestId('call-note-toggle')).toBeNull();
  });
});
