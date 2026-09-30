// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState, type JSX } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardCard as BoardCardData, FirmIdentityDto } from '@fss/contracts';
import type { PipelineView, StageChange, ValueChange } from '../src/renderer/firmWorkspaceContract.ts';
import { BoardCard } from '../src/renderer/pipeline/BoardCard.tsx';
import { Board, emptyBoardMemory, type BoardMemory } from '../src/renderer/pipeline/Board.tsx';
import { ValueDialog } from '../src/renderer/pipeline/ValueDialog.tsx';
import {
  evidencePhrase,
  KNOWN_EVIDENCE_KINDS,
  meetingLabel,
  parseMonthlyDollars,
  valueLabel,
} from '../src/renderer/pipeline/cardText.ts';

/**
 * The Kanban board, card and value dialog (slice K). No real firm appears: `example.test`
 * is reserved by RFC 6761, and the names are placeholders.
 */

const OPP = '99999999-9999-4999-8999-999999999999';
const stage = (key: string, displayName: string, position: number, terminalKind: 'won' | 'lost' | null = null, retired = false) => ({
  id: `00000000-0000-4000-8000-00000000000${String(position)}`,
  key,
  displayName,
  position,
  terminalKind,
  retired,
});
const STAGES = {
  new: stage('new', 'Interested', 1),
  demo: stage('demo_booked', 'Demo booked', 2),
  decision: stage('qualified', 'Decision pending', 3),
  onboarding: stage('onboarding', 'Onboarding', 4),
  won: stage('won', 'Live', 5, 'won'),
  lost: stage('lost', 'Lost', 6, 'lost'),
  old: stage('contacting', 'Contacting', 7, null, true),
};
const firm = (n: number, name: string, stageKey: string | null): FirmIdentityDto => ({
  id: `0000000${String(n)}-1111-4111-8111-111111111111`,
  name,
  website: null,
  locality: null,
  regionCode: null,
  status: 'active',
  assignedUserId: null,
  stageKey,
  opportunityStatus: stageKey === null ? null : 'open',
  controlMode: null,
  openedAt: null,
  timeZone: null,
  timeZoneUnresolvedReason: null,
});
const ASPEN = firm(1, 'Aspen Test Wealth', 'new');
const BRIDGE = firm(2, 'Bridgewater Test Advisors', 'demo_booked');
const CEDAR = firm(3, 'Cedar Test Partners', 'lost');

const card = (over: Partial<BoardCardData> = {}): BoardCardData => ({
  value: null,
  meeting: null,
  evidence: null,
  pinned: false,
  closeReason: null,
  ...over,
});

const view = (over: Partial<PipelineView> = {}): PipelineView => ({
  columns: [
    { stage: STAGES.new, firms: [ASPEN] },
    { stage: STAGES.demo, firms: [BRIDGE] },
    { stage: STAGES.decision, firms: [] },
    { stage: STAGES.onboarding, firms: [] },
    { stage: STAGES.won, firms: [] },
    { stage: STAGES.old, firms: [] },
  ],
  opportunityIdByFirmId: { [ASPEN.id]: OPP },
  cards: {
    [ASPEN.id]: card({ value: { monthlyCents: 120_000, kind: 'estimated' } }),
    [BRIDGE.id]: card({
      pinned: false,
      meeting: { meetingId: OPP, state: 'booked', startsAt: '2026-10-03T18:00:00.000Z' },
      evidence: { kind: 'meeting.booked', evidenceId: 'mtg_123', occurredAt: '2026-10-03T15:00:00.000Z', fromStageKey: 'new' },
    }),
  },
  ...over,
});

const noop = (): void => undefined;

function Harness({
  pipeline,
  onShowLost = noop,
  onChangeStage = noop,
  onSetValue = noop,
  memory,
}: {
  readonly pipeline: PipelineView;
  readonly onShowLost?: (show: boolean) => void;
  readonly onChangeStage?: (change: StageChange) => void;
  readonly onSetValue?: (change: ValueChange) => void;
  readonly memory?: { current: BoardMemory };
}): JSX.Element {
  const [search, setSearch] = useState('');
  const own = useRef<BoardMemory>(emptyBoardMemory());
  return (
    <Board
      pipeline={pipeline}
      actionsEnabled
      stageBusy={() => false}
      valueBusy={() => false}
      search={search}
      memory={memory ?? own}
      onSearch={setSearch}
      onShowLost={onShowLost}
      onChangeStage={onChangeStage}
      onSetValue={onSetValue}
      onOpenFirm={noop}
    />
  );
}

afterEach(cleanup);

describe('the columns', () => {
  it('renders the board\'s columns in order, hides the retired empty one, and puts each firm under its stage', () => {
    render(<Harness pipeline={view()} />);
    expect(screen.getAllByTestId('pipeline-column-name').map(n => n.textContent)).toEqual([
      'Interested',
      'Demo booked',
      'Decision pending',
      'Onboarding',
      'Live',
    ]);
    const demo = screen.getAllByTestId('pipeline-column')[1] as HTMLElement;
    expect(within(demo).getByText('Bridgewater Test Advisors')).toBeTruthy();
    expect(screen.queryByText('Cedar Test Partners')).toBeNull();
  });

  it('keeps a retired column that still holds a firm, and drops the 860px measure for a scrolling board', () => {
    const pipeline = view({
      columns: [{ stage: STAGES.old, firms: [ASPEN] }, { stage: STAGES.new, firms: [] }],
    });
    render(<Harness pipeline={pipeline} />);
    expect(screen.getAllByTestId('pipeline-column-name').map(n => n.textContent)).toEqual(['Contacting', 'Interested']);
    expect(screen.getByTestId('stage-retired')).toBeTruthy();
    expect(screen.getByTestId('pipeline-scroller').className).toContain('overflow-x-auto');
  });

  it('asks for Lost through the filter and shows the Lost column with the close reason', () => {
    const onShowLost = vi.fn();
    const { rerender } = render(<Harness pipeline={view()} onShowLost={onShowLost} />);
    const toggle = screen.getByTestId('show-lost') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect(onShowLost).toHaveBeenCalledWith(true);

    const withLost = view({
      includeLost: true,
      columns: [...view().columns.slice(0, 5), { stage: STAGES.lost, firms: [CEDAR] }],
      cards: { ...view().cards, [CEDAR.id]: card({ closeReason: 'chose a competitor' }) },
    });
    rerender(<Harness pipeline={withLost} onShowLost={onShowLost} />);
    expect((screen.getByTestId('show-lost') as HTMLInputElement).checked).toBe(true);
    const lostColumn = screen.getAllByTestId('pipeline-column').find(c => c.getAttribute('data-stage-key') === 'lost') as HTMLElement;
    expect(within(lostColumn).getByTestId('card-close-reason').textContent).toBe('chose a competitor');
    // A closed card offers no move.
    expect(within(lostColumn).queryByTestId('card-move')).toBeNull();
  });

  it('still offers Lost as a destination while the Lost column is behind its filter', async () => {
    render(<Harness pipeline={view({ stages: Object.values(STAGES) })} />);
    const aspen = screen.getAllByTestId('pipeline-firm')[0] as HTMLElement;
    await userEvent.click(within(aspen).getByTestId('card-move'));
    const values = [...(within(aspen).getByTestId('stage-select') as HTMLSelectElement).options].map(o => o.value);
    expect(values).toContain('lost');
    expect(screen.queryAllByTestId('pipeline-column').some(c => c.getAttribute('data-stage-key') === 'lost')).toBe(false);
  });

  it('searches by firm name without moving anything between columns', async () => {
    render(<Harness pipeline={view()} />);
    await userEvent.type(screen.getByTestId('pipeline-search'), 'bridge');
    expect(screen.getAllByTestId('pipeline-open-firm').map(n => n.textContent)).toEqual(['Bridgewater Test Advisors']);
  });

  it('puts the scroll offsets back when the board is drawn again, as after a firm page', () => {
    const memory = { current: { left: 240, columns: { new: 30 } } };
    const first = render(<Harness pipeline={view()} memory={memory} />);
    first.unmount();
    render(<Harness pipeline={view()} memory={memory} />);
    expect((screen.getByTestId('pipeline-scroller') as HTMLElement).scrollLeft).toBe(240);
    const column = screen.getAllByTestId('pipeline-firms')[0] as HTMLElement;
    expect(column.scrollTop).toBe(30);
  });
});

const renderCard = (over: { card?: BoardCardData; opportunityId?: string | undefined; onChangeStage?: (c: StageChange) => void; onSetValue?: (c: ValueChange) => void } = {}) => {
  const pipeline = view();
  return render(
    <ul>
      <BoardCard
        firm={BRIDGE}
        card={over.card ?? pipeline.cards?.[BRIDGE.id]}
        stage={STAGES.demo}
        stages={Object.values(STAGES)}
        opportunityId={'opportunityId' in over ? over.opportunityId : OPP}
        actionsEnabled
        stageBusy={false}
        valueBusy={false}
        onChangeStage={over.onChangeStage ?? noop}
        onSetValue={over.onSetValue ?? noop}
        onOpenFirm={noop}
      />
    </ul>,
  );
};

describe('a card', () => {
  it('labels the value estimated or agreed, and shows the meeting status with its time', () => {
    expect(valueLabel({ monthlyCents: 120_000, kind: 'estimated' })).toBe('$1,200/mo · estimated');
    expect(valueLabel({ monthlyCents: 99_950, kind: 'agreed' })).toBe('$999.50/mo · agreed');
    renderCard({ card: card({ value: { monthlyCents: 120_000, kind: 'agreed' }, meeting: { meetingId: OPP, state: 'no_show', startsAt: '2026-10-03T18:00:00.000Z' } }) });
    expect(screen.getByTestId('card-value').textContent).toBe('$1,200/mo · agreed');
    expect(screen.getByTestId('card-meeting').textContent).toMatch(/^No-show · Oct 3/u);
    expect(meetingLabel({ meetingId: OPP, state: 'rescheduled', startsAt: '2026-10-03T18:00:00.000Z' })).toMatch(/^Rescheduled/u);
    // No next-action data on the board read yet: a dash, not a guess.
    expect(screen.getByTestId('card-next-action').textContent).toBe('Next: —');
  });

  it('shows the evidence line for an automatic move, and the popover holds kind, time and id', async () => {
    renderCard();
    expect(screen.getByTestId('card-evidence').textContent).toBe('Moved to Demo booked · booking on Oct 3 (Cal.com)');
    expect(screen.queryByTestId('card-evidence-popover')).toBeNull();
    await userEvent.click(screen.getByTestId('card-evidence'));
    expect(screen.getByTestId('evidence-kind').textContent).toBe('meeting.booked');
    expect(screen.getByTestId('evidence-id').textContent).toBe('mtg_123');
    expect(screen.getByTestId('evidence-when').textContent).toContain('Oct 3, 2026');
    expect(screen.getByTestId('card-evidence-popover').textContent).toContain('Interested');
  });

  it('has a phrase for every seeded evidence kind and a fallback for one it has never heard of', () => {
    for (const kind of KNOWN_EVIDENCE_KINDS) {
      expect(evidencePhrase(kind, '2026-10-03T15:00:00.000Z')).not.toContain(kind);
    }
    expect(evidencePhrase('quote.signed', '2026-10-03T15:00:00.000Z')).toBe('quote.signed on Oct 3');
  });

  it('shows Pinned only for a pinned card, and no evidence line when the API sent none', () => {
    const { unmount } = renderCard({ card: card({ pinned: true }) });
    expect(screen.getByTestId('card-pinned').textContent).toBe('Pinned');
    expect(screen.queryByTestId('card-evidence')).toBeNull();
    unmount();
    renderCard({ card: card() });
    expect(screen.queryByTestId('card-pinned')).toBeNull();
  });

  it('"Move to…" calls the stage change, and Lost needs its reason first', async () => {
    const onChangeStage = vi.fn();
    renderCard({ onChangeStage });
    await userEvent.click(screen.getByTestId('card-move'));
    const select = screen.getByTestId('stage-select') as HTMLSelectElement;
    // Not the stage it is in, not a retired one.
    expect([...select.options].map(o => o.value)).toEqual(['', 'new', 'qualified', 'onboarding', 'won', 'lost']);
    expect((screen.getByTestId('stage-submit') as HTMLButtonElement).disabled).toBe(true);

    await userEvent.selectOptions(select, 'lost');
    expect((screen.getByTestId('stage-submit') as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByTestId('stage-reason'), 'chose a competitor');
    await userEvent.click(screen.getByTestId('stage-submit'));
    expect(onChangeStage).toHaveBeenCalledWith({ opportunityId: OPP, toStageKey: 'lost', reason: 'chose a competitor' });
  });

  it('sends a plain move without a reason', async () => {
    const onChangeStage = vi.fn();
    renderCard({ onChangeStage });
    await userEvent.click(screen.getByTestId('card-move'));
    await userEvent.selectOptions(screen.getByTestId('stage-select'), 'onboarding');
    await userEvent.click(screen.getByTestId('stage-submit'));
    expect(onChangeStage).toHaveBeenCalledWith({ opportunityId: OPP, toStageKey: 'onboarding', reason: null });
  });

  it('offers no actions on a firm this caller cannot change', () => {
    renderCard({ opportunityId: undefined });
    expect(screen.queryByTestId('card-move')).toBeNull();
    expect(screen.queryByTestId('card-set-value')).toBeNull();
  });

  it('opens the value dialog from the card and saves the amount and kind', async () => {
    const onSetValue = vi.fn();
    renderCard({ onSetValue });
    await userEvent.click(screen.getByTestId('card-set-value'));
    await userEvent.type(screen.getByTestId('value-amount'), '1,200');
    await userEvent.selectOptions(screen.getByTestId('value-kind'), 'agreed');
    await userEvent.click(screen.getByTestId('value-save'));
    expect(onSetValue).toHaveBeenCalledWith({ opportunityId: OPP, monthlyCents: 120_000, kind: 'agreed' });
  });
});

describe('the value dialog\'s validation', () => {
  it('parses dollars to whole cents and says why anything else is refused', () => {
    expect(parseMonthlyDollars('1200')).toEqual({ ok: true, monthlyCents: 120_000 });
    expect(parseMonthlyDollars('$1,200.5')).toEqual({ ok: true, monthlyCents: 120_050 });
    expect(parseMonthlyDollars('0')).toEqual({ ok: true, monthlyCents: 0 });
    expect(parseMonthlyDollars('1000000')).toEqual({ ok: true, monthlyCents: 100_000_000 });
    expect(parseMonthlyDollars('')).toEqual({ ok: false, problem: 'empty' });
    expect(parseMonthlyDollars('abc')).toEqual({ ok: false, problem: 'not_a_number' });
    expect(parseMonthlyDollars('1.234')).toEqual({ ok: false, problem: 'too_many_decimals' });
    expect(parseMonthlyDollars('-5')).toEqual({ ok: false, problem: 'negative' });
    expect(parseMonthlyDollars('1000000.01')).toEqual({ ok: false, problem: 'too_large' });
  });

  it('will not save an empty or malformed amount, and shows the problem once typed', async () => {
    const onSave = vi.fn();
    render(<ValueDialog opportunityId={OPP} firmName="Aspen Test Wealth" initial={null} busy={false} onSave={onSave} onCancel={noop} />);
    const save = screen.getByTestId('value-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(screen.queryByTestId('value-problem')).toBeNull();
    await userEvent.type(screen.getByTestId('value-amount'), 'twelve');
    expect(screen.getByTestId('value-problem').textContent).toContain('digits');
    expect(save.disabled).toBe(true);
    await userEvent.clear(screen.getByTestId('value-amount'));
    await userEvent.type(screen.getByTestId('value-amount'), '300');
    expect(save.disabled).toBe(false);
    await userEvent.click(save);
    expect(onSave).toHaveBeenCalledWith({ opportunityId: OPP, monthlyCents: 30_000, kind: 'estimated' });
  });

  it('starts from the current value and kind', () => {
    render(<ValueDialog opportunityId={OPP} firmName="Aspen Test Wealth" initial={{ monthlyCents: 29_900, kind: 'agreed' }} busy={false} onSave={noop} onCancel={noop} />);
    expect((screen.getByTestId('value-amount') as HTMLInputElement).value).toBe('299');
    expect((screen.getByTestId('value-kind') as HTMLSelectElement).value).toBe('agreed');
  });
});
