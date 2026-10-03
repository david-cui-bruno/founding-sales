// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BoardCard } from '@fss/contracts';
import { createGeneration } from '../src/renderer/app/generation.ts';
import { FirmPage } from '../src/renderer/firms/FirmPage.tsx';
import { DraftsProvider } from '../src/renderer/app/drafts.tsx';
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
  return <FirmsRoute route={{ name: route }} identity="person-1" generation={source.current()} guard={source.guard} />;
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
  source.note(0);
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

  it('says a person placed the firm, with their reason, and that only a person moves it on (lane M1)', () => {
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
    // Stages are manual since lane M1: nothing says automatic moves still happen.
    expect(screen.getByTestId('stage-pinned-note').textContent).toContain('Only a person moves it on');
    expect(screen.getByTestId('stage-pinned-note').textContent).not.toContain('automatic moves');
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

// ---------------------------------------------------------------------------------------
// The kept-state rules (S4 review, findings 5-9). Each test names the rule it holds.
// ---------------------------------------------------------------------------------------

type DetailPage = Extract<NonNullable<CrmState['firm']>, { visibility: 'assigned_or_admin'; opportunity: unknown }> & {
  read: { firm: { contacts: { id: string; fullName: string; title: string | null; status: 'active' | 'inactive' | 'merged'; isPrimary: boolean }[] } };
};

function firmPageOf(id: string, over: Partial<DetailPage['read']['firm']> = {}): DetailPage {
  const base = assigneeFirmPage() as DetailPage;
  return { ...base, read: { ...base.read, firm: { ...base.read.firm, id, ...over } } } as DetailPage;
}

function drawPage(page: DetailPage, onSaveContact: (edit: unknown) => void = () => undefined): void {
  render(
    <DraftsProvider>
      <FirmPage
        page={page}
        sequences={null}
        actionsEnabled
        busy={() => false}
        redactionNotice={null}
        onSaveContact={onSaveContact}
        onCheckRoute={() => undefined}
        onOpenOpportunity={() => undefined}
        onEnroll={() => undefined}
        onTakeOver={() => undefined}
      />
    </DraftsProvider>,
  );
}

function delayCommand(): () => Promise<void> {
  const original = globalThis.callieApi as unknown as { command(name: string, input: unknown): Promise<unknown> };
  const command = original.command.bind(original);
  let release: () => Promise<void> = async () => undefined;
  original.command = (name, input) =>
    new Promise(resolve => {
      release = async () => {
        resolve(await command(name, input));
      };
    });
  return async () => {
    await release();
  };
}

async function sendMove(index = 0): Promise<void> {
  const row = screen.getAllByTestId('pipeline-firm')[index] as HTMLElement;
  await userEvent.click(within(row).getByTestId('card-move'));
  await userEvent.selectOptions(within(row).getByTestId('stage-select'), 'engaged');
  await userEvent.click(within(row).getByTestId('stage-submit'));
}

describe('K1: kept state is keyed by entity and session (findings 5 and 9)', () => {
  it('a takeover reason typed for one firm is not in another firm\'s box', () => {
    drawPage(firmPageOf(FIRM_ID));
    fireEvent.change(screen.getByTestId('take-over-reason'), { target: { value: 'A asked me to take over' } });
    cleanup();
    drawPage(firmPageOf(OTHER_FIRM_ID));
    expect((screen.getByTestId('take-over-reason') as HTMLInputElement).value).toBe('');
    cleanup();
    drawPage(firmPageOf(FIRM_ID));
    expect((screen.getByTestId('take-over-reason') as HTMLInputElement).value).toBe('A asked me to take over');
  });

  it('every kept draft key names its entity', async () => {
    install(boardState({ [FIRM_ID]: card() }));
    mount();
    await board();
    const row = screen.getAllByTestId('pipeline-firm')[0] as HTMLElement;
    await userEvent.click(within(row).getByTestId('card-set-value'));
    await userEvent.type(within(row).getByTestId('value-amount'), '5');
    cleanup();
    drawPage(firmPageOf(FIRM_ID));
    fireEvent.change(screen.getByTestId('take-over-reason'), { target: { value: 'x' } });
    fireEvent.change(screen.getAllByTestId('contact-name')[0] as HTMLElement, { target: { value: 'Someone Else' } });
    const { currentCrmMemory } = await import('../src/renderer/firms/crmMemory.ts');
    const keys = Object.keys(currentCrmMemory().drafts).filter(key => !key.endsWith(':base'));
    expect(keys.length).toBeGreaterThan(2);
    for (const key of keys) expect(key, key).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/u);
  });

  it('a new session as the same person starts with no kept editor or draft (generation moves)', async () => {
    install(boardState());
    const first = mount();
    await board();
    await userEvent.click(screen.getAllByTestId('card-set-value')[0] as HTMLElement);
    await userEvent.type(screen.getByTestId('value-amount'), '1850');
    first.unmount();
    source.note(source.current() + 1);
    mount();
    await board();
    expect(screen.queryByTestId('value-amount')).toBeNull();
  });

  it('a new drafts provider (sign-out, then sign-in as the same person) starts clean', async () => {
    install(boardState());
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
    const tree = (): JSX.Element => (
      <QueryClientProvider client={client}>
        <DraftsProvider>
          <View route="pipeline" />
        </DraftsProvider>
      </QueryClientProvider>
    );
    const first = render(tree());
    await board();
    await userEvent.click(screen.getAllByTestId('card-set-value')[0] as HTMLElement);
    await userEvent.type(screen.getByTestId('value-amount'), '1850');
    first.unmount();
    render(tree());
    await board();
    expect(screen.queryByTestId('value-amount')).toBeNull();
  });
});

describe('K3: a command and its answer belong to their card (findings 6 and 7)', () => {
  it('a refusal that arrives after the view was left is there, with its draft, when it comes back', async () => {
    const fake = install(boardState());
    fake.stageAnswer = 'stage_retired';
    const release = delayCommand();
    const first = mount();
    await board();
    await sendMove();
    first.unmount();
    await act(async () => {
      await release();
    });
    mount();
    await board();
    expect(screen.getByTestId('card-feedback').textContent).toContain('retired');
    expect((screen.getByTestId('stage-select') as HTMLSelectElement).value).toBe('engaged');
    // And it was not also hidden as a page notice: the card shows it, so the banner is not needed.
    expect(screen.queryByTestId('banner-warning')).toBeNull();
  });

  it('a late refusal does not reopen an editor that was closed after sending', async () => {
    const fake = install(boardState());
    fake.stageAnswer = 'stage_retired';
    const release = delayCommand();
    mount();
    await board();
    await sendMove();
    const row = screen.getAllByTestId('pipeline-firm')[0] as HTMLElement;
    await userEvent.click(within(row).getByTestId('card-move'));
    await userEvent.click(within(row).getByTestId('stage-cancel'));
    await act(async () => {
      await release();
    });
    await screen.findByTestId('card-feedback');
    expect(screen.queryByTestId('stage-select')).toBeNull();
  });

  it('a late refusal does not replace the editor David is using', async () => {
    const fake = install(boardState());
    fake.stageAnswer = 'stage_retired';
    const release = delayCommand();
    mount();
    await board();
    await sendMove();
    const row = screen.getAllByTestId('pipeline-firm')[0] as HTMLElement;
    await userEvent.click(within(row).getByTestId('card-set-value'));
    await userEvent.type(within(row).getByTestId('value-amount'), '42');
    await act(async () => {
      await release();
    });
    await screen.findByTestId('card-feedback');
    expect(screen.queryByTestId('stage-select')).toBeNull();
    expect((screen.getByTestId('value-amount') as HTMLInputElement).value).toBe('42');
  });

  it('overlapping commands on two cards each keep their own answer', async () => {
    const two = boardState();
    const fake = install({
      ...two,
      pipeline: { ...two.pipeline!, opportunityIdByFirmId: { ...two.pipeline!.opportunityIdByFirmId, [OTHER_FIRM_ID]: 'other-opportunity' } },
    });
    const releases: ((notice: string) => void)[] = [];
    (globalThis.callieApi as unknown as { command: unknown }).command = async () =>
      await new Promise(resolve => {
        releases.push(notice => {
          resolve({ ...fake.state, notice, screen: 'pipeline' });
        });
      });
    mount();
    await board();
    for (const index of [0, 1]) await sendMove(index);
    await act(async () => {
      releases[0]?.('stage_retired');
    });
    await act(async () => {
      releases[1]?.('stage_changed');
    });
    const rows = screen.getAllByTestId('pipeline-firm');
    await within(rows[1] as HTMLElement).findByTestId('card-feedback');
    expect(within(rows[0] as HTMLElement).getByTestId('card-feedback').textContent).toContain('retired');
    expect(within(rows[1] as HTMLElement).getByTestId('card-feedback').textContent).toBe('Stage changed.');
  });

  it('a refusal no card shows stays a page notice', async () => {
    const fake = install(boardState());
    mount();
    await board();
    const api = globalThis.callieApi as unknown as { read(name: string, input: unknown): Promise<unknown> };
    const original = api.read.bind(api);
    api.read = async (name, input) => {
      const answer = (await original(name, input)) as CrmState;
      return name === 'crm.openPipeline' ? { ...answer, notice: 'not_assigned' } : answer;
    };
    await userEvent.click(screen.getByTestId('show-lost'));
    expect((await screen.findByTestId('banner-warning')).textContent).toContain('assigned to somebody else');
    expect(fake.calls.some(call => call.name === 'crm.openPipeline')).toBe(true);
  });
});

describe('K7: a stale read never replaces the selected firm (finding 8)', () => {
  it('an older firm read that lands last is followed by a read of the selected firm', async () => {
    install(boardState());
    const api = globalThis.callieApi as unknown as { read(name: string, input: { firmId?: string }): Promise<unknown> };
    const original = api.read.bind(api);
    let release: () => Promise<void> = async () => undefined;
    api.read = (name, input) => {
      if (name === 'crm.openFirm' && input.firmId === FIRM_ID) {
        return new Promise(resolve => {
          release = async () => {
            resolve(await original(name, input));
          };
        });
      }
      return original(name, input);
    };
    mount();
    await board();
    await userEvent.click(screen.getAllByTestId('pipeline-open-firm')[0] as HTMLElement);
    await userEvent.click(screen.getAllByTestId('pipeline-open-firm')[1] as HTMLElement);
    await within(screen.getByTestId('firm-panel')).findByTestId('firm-identity');
    await act(async () => {
      await release();
    });
    await waitFor(() => {
      expect(screen.queryByTestId('firm-panel-loading')).toBeNull();
    });
    expect(within(screen.getByTestId('firm-panel')).getByTestId('firm-identity')).toBeTruthy();
  });
});

describe('K2: an untouched or stale server value is never sent (value, contacts)', () => {
  it('the value dialog cannot save while nothing differs from the server', async () => {
    install(boardState({ [FIRM_ID]: card({ value: { monthlyCents: 120_000, kind: 'estimated' } }) }));
    mount();
    await board();
    const row = screen.getAllByTestId('pipeline-firm')[0] as HTMLElement;
    await userEvent.click(within(row).getByTestId('card-set-value'));
    expect((within(row).getByTestId('value-save') as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(within(row).getByTestId('value-amount'), '5');
    expect((within(row).getByTestId('value-save') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a kept value edit is dropped, and says so, when the server value moved since it began', async () => {
    const fake = install(boardState({ [FIRM_ID]: card({ value: { monthlyCents: 120_000, kind: 'estimated' } }) }));
    const first = mount();
    await board();
    let row = screen.getAllByTestId('pipeline-firm')[0] as HTMLElement;
    await userEvent.click(within(row).getByTestId('card-set-value'));
    await userEvent.type(within(row).getByTestId('value-amount'), '9');
    first.unmount();
    // Somebody else lowered it meanwhile.
    fake.state = { ...fake.state, pipeline: { ...fake.state.pipeline!, cards: { [FIRM_ID]: card({ value: { monthlyCents: 20_000, kind: 'estimated' } }) } } };
    mount();
    await board();
    row = screen.getAllByTestId('pipeline-firm')[0] as HTMLElement;
    expect(within(row).getByTestId('value-changed-elsewhere')).toBeTruthy();
    expect((within(row).getByTestId('value-amount') as HTMLInputElement).value).toBe('200');
    expect((within(row).getByTestId('value-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a kept contact edit is dropped when the contact changed meanwhile, and the save sends the current value', () => {
    const saved: unknown[] = [];
    drawPage(firmPageOf(FIRM_ID), edit => saved.push(edit));
    fireEvent.change(screen.getAllByTestId('contact-title')[0] as HTMLElement, { target: { value: 'My old edit' } });
    cleanup();
    const page = firmPageOf(FIRM_ID);
    const changed = { ...page, read: { ...page.read, firm: { ...page.read.firm, contacts: page.read.firm.contacts.map((contact, index) => (index === 0 ? { ...contact, title: 'Set by somebody else' } : contact)) } } } as DetailPage;
    drawPage(changed, edit => saved.push(edit));
    expect(screen.getByTestId('contact-changed-elsewhere')).toBeTruthy();
    expect((screen.getAllByTestId('contact-title')[0] as HTMLInputElement).value).toBe('Set by somebody else');
    expect((screen.getAllByTestId('contact-save')[0] as HTMLButtonElement).disabled).toBe(true);
    expect(saved).toEqual([]);
  });
});
