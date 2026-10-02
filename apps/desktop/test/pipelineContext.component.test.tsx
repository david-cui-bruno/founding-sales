// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BoardCard } from '@fss/contracts';
import { createGeneration } from '../src/renderer/app/generation.ts';
import { FirmsRoute } from '../src/renderer/firms/FirmsRoute.tsx';
import { resetCrmMemory } from '../src/renderer/firms/crmMemory.ts';
import { StageWhy } from '../src/renderer/firms/StageWhy.tsx';
import { openTotals, totalsOf, valueSummary } from '../src/renderer/pipeline/boardMetrics.ts';
import type { CrmState } from '../src/renderer/firmWorkspaceContract.ts';
import type { OperationApi } from '../src/shared/operations.ts';
import { assigneeFirmPage, crmState, FIRM_ID, OTHER_FIRM_ID, pipelineView } from './e2e/support/crmFixtures.ts';

/**
 * Pipeline and the firm page in the approved design (S4): the stage is explainable, the
 * numbers say when and keep the uncertain ones apart, and what David had open is still open
 * after he visits Today. Each test below fails if the behaviour is taken out: the memory is
 * what makes the second mount look like the first.
 *
 * No real firm appears: `example.test` is reserved by RFC 6761.
 */

const AT = '2026-10-01T15:00:00.000Z';

const card = (over: Partial<BoardCard> = {}): BoardCard => ({
  value: null,
  meeting: null,
  evidence: null,
  pinned: false,
  closeReason: null,
  ...over,
});

const boardState = (cards: Record<string, BoardCard> = {}, over: Partial<CrmState> = {}): CrmState =>
  crmState({ screen: 'pipeline', firm: null, pipeline: { ...pipelineView(), cards }, ...over });

interface Fake {
  readonly calls: { readonly name: string; readonly input: unknown }[];
  state: CrmState;
  /** What a stage change answers, as the bridge would: a notice, and the board read again on success. */
  stageAnswer: string;
}

function install(state: CrmState): Fake {
  const fake: Fake = { calls: [], state, stageAnswer: 'stage_changed' };
  const answer = (name: string, input: unknown): unknown => {
    fake.calls.push({ name, input });
    switch (name) {
      case 'crm.state':
        return fake.state;
      case 'crm.openPipeline':
        fake.state = { ...fake.state, screen: 'pipeline', notice: null };
        return fake.state;
      case 'crm.openFirm': {
        const firmId = (input as { firmId: string }).firmId;
        const page = assigneeFirmPage();
        fake.state = {
          ...fake.state,
          screen: 'firm',
          notice: null,
          firm: { ...page, read: { ...page.read, firm: { ...page.read.firm, id: firmId } } } as NonNullable<CrmState['firm']>,
        };
        return fake.state;
      }
      case 'crm.changeStage':
        fake.state = { ...fake.state, notice: fake.stageAnswer, screen: fake.stageAnswer === 'stage_changed' ? 'pipeline' : fake.state.screen };
        return fake.state;
      case 'crm.setValue':
        fake.state = { ...fake.state, notice: 'value_recorded', screen: 'pipeline' };
        return fake.state;
      case 'research.open':
        return { firm: null, settings: null, worstCaseRunCents: null, spend: null, notice: null, mayMutate: true, role: 'salesperson' };
      case 'calling.history':
        return { calls: null };
      case 'meetings.forFirm':
        return { meetings: [] };
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
  return fake;
}

const source = createGeneration();

function View({ route }: { readonly route: 'pipeline' | 'firms' }): JSX.Element {
  return <FirmsRoute route={{ name: route }} identity="person-1" generation={0} guard={source.guard} />;
}

const mount = (route: 'pipeline' | 'firms' = 'pipeline') => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  return render(
    <QueryClientProvider client={client}>
      <View route={route} />
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  resetCrmMemory();
});
afterEach(() => {
  cleanup();
  resetCrmMemory();
  globalThis.callieApi = undefined;
});

const board = async (): Promise<void> => {
  await screen.findByTestId('pipeline-board');
};

describe('stage evidence is explainable (acceptance 2)', () => {
  const page = assigneeFirmPage();
  if (page.visibility !== 'assigned_or_admin') throw new Error('fixture');

  it('says a person placed the firm, with their reason, and that automatic moves only go forward from it', () => {
    render(
      <StageWhy
        history={[
          { id: 'a', occurredAt: '2026-09-01T12:00:00.000Z', fromStageKey: null, toStageKey: 'new', actorKind: 'system', reason: null },
          { id: 'b', occurredAt: '2026-09-02T12:00:00.000Z', fromStageKey: 'new', toStageKey: 'contacting', actorKind: 'user', reason: 'They asked for it' },
        ]}
        card={card({ pinned: true })}
      />,
    );
    expect(screen.getByTestId('stage-manual').textContent).toBe('Manual');
    expect(screen.getByTestId('stage-why-line').textContent).toContain('You moved it to contacting');
    expect(screen.getByTestId('stage-why-line').textContent).toContain('They asked for it');
    expect(screen.getByTestId('stage-pinned-note')).toBeTruthy();
  });

  it('names the evidence of an automatic move and does not call it manual', () => {
    render(
      <StageWhy
        history={[{ id: 'a', occurredAt: AT, fromStageKey: 'new', toStageKey: 'demo_booked', actorKind: 'worker', reason: null }]}
        card={card({ evidence: { kind: 'meeting.booked', evidenceId: 'm1', occurredAt: AT, fromStageKey: 'new' } })}
        stageName={key => (key === 'demo_booked' ? 'Demo booked' : key)}
      />,
    );
    expect(screen.queryByTestId('stage-manual')).toBeNull();
    expect(screen.getByTestId('stage-why-line').textContent).toContain('Callie moved it to Demo booked');
    expect(screen.getByTestId('stage-why-line').textContent).toContain('booking on');
  });

  it('shows the same explanation in the board panel after the whole view is drawn again (it comes from the server)', async () => {
    install(boardState({ [FIRM_ID]: card({ pinned: true }) }));
    mount();
    await board();
    await userEvent.click(screen.getAllByTestId('pipeline-open-firm')[0] as HTMLElement);
    const panel = await screen.findByTestId('firm-panel');
    expect((await within(panel).findByTestId('stage-manual')).textContent).toBe('Manual');
    cleanup();
    mount();
    expect((await within(await screen.findByTestId('firm-panel')).findByTestId('stage-manual')).textContent).toBe('Manual');
  });
});

describe('metrics say when, and keep what is uncertain apart (acceptance 5)', () => {
  it('adds agreed and estimated money separately and counts the firms with no value', () => {
    const totals = totalsOf([
      card({ value: { monthlyCents: 120_000, kind: 'agreed' } }),
      card({ value: { monthlyCents: 50_000, kind: 'estimated' } }),
      card({ value: { monthlyCents: 30_000, kind: 'estimated' } }),
      undefined,
    ]);
    expect(totals).toEqual({ firms: 4, agreedCents: 120_000, estimatedCents: 80_000, withoutValue: 1 });
    expect(valueSummary(totals)).toBe('$1,200/mo agreed + $800/mo estimated');
  });

  it('leaves the Lost column out of what is open', () => {
    const view = pipelineView();
    const lost = view.columns.find(column => column.stage.terminalKind === 'lost');
    const first = view.columns.find(column => column.firms.length > 0);
    if (lost === undefined || first === undefined) throw new Error('fixture');
    lost.firms.push({ ...first.firms[0]!, id: OTHER_FIRM_ID });
    expect(openTotals(view).firms).toBe(2);
  });

  it('names its period on the board, and the "without a value" count opens exactly that list', async () => {
    install(boardState({ [FIRM_ID]: card({ value: { monthlyCents: 90_000, kind: 'estimated' } }) }));
    mount();
    await board();
    const totals = screen.getByTestId('board-totals');
    expect(totals.textContent).toContain('As of today');
    expect(totals.textContent).toContain('$900/mo estimated');
    const button = screen.getByTestId('board-no-value');
    expect(button.textContent).toBe('1 without a value');
    expect(screen.getAllByTestId('pipeline-firm')).toHaveLength(2);
    await userEvent.click(button);
    const rows = screen.getAllByTestId('pipeline-firm');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('Larkspur Test Foundry');
  });
});

describe('context is kept across leaving the view (acceptance 4, UI criterion 7)', () => {
  it('keeps the open panel, the filter text and the half-typed value after unmount and remount', async () => {
    const fake = install(boardState({ [FIRM_ID]: card() }));
    const first = mount();
    await board();

    await userEvent.type(screen.getByTestId('pipeline-search'), 'north');
    await userEvent.click(screen.getAllByTestId('pipeline-open-firm')[0] as HTMLElement);
    await screen.findByTestId('firm-panel');
    const cardRow = screen.getAllByTestId('pipeline-firm')[0] as HTMLElement;
    await userEvent.click(within(cardRow).getByTestId('card-set-value'));
    await userEvent.type(within(cardRow).getByTestId('value-amount'), '1850');
    fireEvent.scroll(screen.getByTestId('pipeline-scroller'), { target: { scrollLeft: 120 } });

    // David opens Today: this view is unmounted entirely.
    first.unmount();
    expect(screen.queryByTestId('pipeline-board')).toBeNull();

    mount();
    await board();
    expect((screen.getByTestId('pipeline-search') as HTMLInputElement).value).toBe('north');
    expect((await screen.findByTestId('firm-panel-name')).textContent).toBe('Northwind Test Holdings');
    expect(screen.getAllByTestId('pipeline-firm')[0]?.getAttribute('aria-current')).toBe('true');
    expect((screen.getByTestId('value-amount') as HTMLInputElement).value).toBe('1850');
    // The panel's firm was read again on the way back, not drawn from a stale copy.
    expect(fake.calls.filter(call => call.name === 'crm.openFirm').length).toBeGreaterThanOrEqual(2);
  });

  it('closes an editor on a second click and on Escape, and keeps what was typed', async () => {
    install(boardState({ [FIRM_ID]: card() }));
    mount();
    await board();
    const row = (): HTMLElement => screen.getAllByTestId('pipeline-firm')[0] as HTMLElement;
    const button = within(row()).getByTestId('card-set-value');
    await userEvent.click(button);
    await userEvent.type(within(row()).getByTestId('value-amount'), '777');

    await userEvent.click(within(row()).getByTestId('card-set-value'));
    expect(within(row()).queryByTestId('value-dialog')).toBeNull();
    await userEvent.click(within(row()).getByTestId('card-set-value'));
    expect((within(row()).getByTestId('value-amount') as HTMLInputElement).value).toBe('777');

    fireEvent.keyDown(within(row()).getByTestId('value-amount'), { key: 'Escape' });
    expect(within(row()).queryByTestId('value-dialog')).toBeNull();
    await userEvent.click(within(row()).getByTestId('card-set-value'));
    expect((within(row()).getByTestId('value-amount') as HTMLInputElement).value).toBe('777');
  });

  it('keeps a stage-change draft when the server refuses, and says why next to the card, not in a banner', async () => {
    const fake = install(boardState({ [FIRM_ID]: card() }));
    fake.stageAnswer = 'stage_retired';
    mount();
    await board();
    const row = (): HTMLElement => screen.getAllByTestId('pipeline-firm')[0] as HTMLElement;
    await userEvent.click(within(row()).getByTestId('card-move'));
    await userEvent.selectOptions(within(row()).getByTestId('stage-select'), 'engaged');
    await userEvent.click(within(row()).getByTestId('stage-submit'));

    const said = await within(row()).findByTestId('card-feedback');
    expect(said.textContent).toBe('That stage has been retired and cannot be moved into.');
    expect(screen.queryByTestId('banner-warning')).toBeNull();
    // The editor is open again with the choice still in it.
    await waitFor(() => {
      expect((within(row()).getByTestId('stage-select') as HTMLSelectElement).value).toBe('engaged');
    });
  });
});

describe('opening a card shows the firm beside the board (acceptance 1)', () => {
  it('opens the panel without replacing the board, and closing it leaves the board as it was', async () => {
    install(boardState({ [FIRM_ID]: card({ nextAction: { kind: 'call', label: 'Call', dueAt: '2099-01-01T15:00:00.000Z' } }) }));
    mount();
    await board();
    await userEvent.click(screen.getAllByTestId('pipeline-open-firm')[0] as HTMLElement);
    const panel = await screen.findByTestId('firm-panel');
    expect(screen.getByTestId('pipeline-board')).toBeTruthy();
    expect(within(panel).getByTestId('firm-next-action-line').textContent).toContain('Call');
    // Closing it leaves the board exactly where it was.
    await userEvent.click(screen.getByTestId('firm-panel-close'));
    expect(screen.queryByTestId('firm-panel')).toBeNull();
    expect(screen.getByTestId('pipeline-board')).toBeTruthy();
  });

  it('shows an empty board with words, and a column with nothing in it', async () => {
    install(boardState({}, { pipeline: { ...pipelineView(), columns: pipelineView().columns.map(column => ({ ...column, firms: [] })) } }));
    mount();
    await board();
    expect(screen.getByTestId('board-empty').textContent).toContain('No firms are in the pipeline yet');
  });

  it('shows a loading shape before the first answer', async () => {
    const fake = install(boardState({}));
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const original = globalThis.callieApi as unknown as { read(name: string, input: unknown): Promise<unknown> };
    const read = original.read.bind(original);
    original.read = async (name, input) => {
      await gate;
      return await read(name, input);
    };
    mount();
    expect(await screen.findByTestId('pipeline-loading')).toBeTruthy();
    await act(async () => {
      release();
      await gate;
    });
    await board();
    expect(fake.calls.length).toBeGreaterThan(0);
  });
});
