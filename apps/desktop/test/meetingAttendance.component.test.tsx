// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardCard, FirmMeetingDto, MeetingAttendanceChoice, MeetingAttendanceSet, StageSuggestion } from '@fss/contracts';
import { createGeneration } from '../src/renderer/app/generation.ts';
import { DraftsProvider } from '../src/renderer/app/drafts.tsx';
import { resetCrmMemory } from '../src/renderer/firms/crmMemory.ts';
import { FirmsRoute } from '../src/renderer/firms/FirmsRoute.tsx';
import type { CrmState } from '../src/renderer/firmWorkspaceContract.ts';
import { resetAttendanceMemory } from '../src/renderer/meetings/attendanceMemory.ts';
import { FirmMeetings, type FirmMeetingsPorts } from '../src/renderer/meetings/FirmMeetings.tsx';
import { BoardCard as BoardCardView } from '../src/renderer/pipeline/BoardCard.tsx';
import { meetingLabel } from '../src/renderer/pipeline/cardText.ts';
import type { OperationApi } from '../src/shared/operations.ts';
import { assigneeFirmPage, crmState, FIRM_ID, OPPORTUNITY_ID, pipelineView } from './e2e/support/crmFixtures.ts';

/**
 * Lane M1: the firm page's attendance controls and the one-click stage suggestion, with the
 * kept-state tests written first (K1–K7, `KEPT-STATE-RULES.md`):
 *
 *   * K1 — a pending command, a note or an answer never outlives the session;
 *   * K3 — a command and its answer are kept by meeting, survive the row unmounting, and a late
 *     answer only lands as feedback on its own meeting; Retry resends the same command id;
 *   * K4 — J/K then Enter on the board runs no stage command, even from the suggestion;
 *   * K6 — the success answer clears the pending command (no Retry, and Undo is a new command);
 *   * K7 — a read that began before an answer never puts the old state back on screen.
 *
 * Words: "Ended · attendance not confirmed" with quiet Attended / No-show; "Held" or "No-show"
 * with Undo only for a person's own confirmation. No real business or person.
 */

const MEETING = '44444444-4444-4444-8444-444444444401';
const OTHER = '44444444-4444-4444-8444-444444444402';
const PAST = '2026-09-29T15:00:00.000Z';

const row = (meetingId: string, state: string, attendanceSource: string | null = null): FirmMeetingDto => ({
  meetingId,
  state,
  startsAt: PAST,
  endsAt: '2026-09-29T15:30:00.000Z',
  attendanceSource,
});

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

type Answer = { readonly set: MeetingAttendanceSet | null; readonly reason: string | null };
interface Sent {
  readonly meetingId: string;
  readonly attendance: MeetingAttendanceChoice;
  readonly commandId: string;
}

function harness(reads: () => Promise<{ meetings: readonly FirmMeetingDto[] | null; stageSuggestion?: StageSuggestion | null }>) {
  const sent: Sent[] = [];
  const answers: Deferred<Answer>[] = [];
  const ports: FirmMeetingsPorts = {
    forFirm: reads,
    setAttendance: async input => {
      sent.push(input);
      const answer = deferred<Answer>();
      answers.push(answer);
      return await answer.promise;
    },
  };
  return { ports, sent, answers };
}

/** One session: a drafts provider is one epoch, as `App` makes one per sign-in. */
function Session({ children }: { readonly children: ReactNode }): JSX.Element {
  return <DraftsProvider>{children}</DraftsProvider>;
}

beforeEach(() => {
  resetAttendanceMemory();
  resetCrmMemory();
});

afterEach(() => {
  cleanup();
});

describe('the words and the actions on a meeting row', () => {
  it('offers Attended and No-show on an ended meeting, Undo on a person s own, and nothing on Cal.com s no-show or a booking', async () => {
    const { ports } = harness(async () =>
      await Promise.resolve({
        meetings: [
          row(MEETING, 'ended'),
          row(OTHER, 'held', 'manual'),
          row('44444444-4444-4444-8444-444444444403', 'no_show', 'calcom_no_show'),
          row('44444444-4444-4444-8444-444444444404', 'booked'),
        ],
      }),
    );
    render(
      <Session>
        <FirmMeetings firmId={FIRM_ID} ports={ports} />
      </Session>,
    );
    const rows = await screen.findAllByTestId('firm-meeting-row');
    expect(rows.map(node => within(node).getByTestId('firm-meeting-state').textContent)).toEqual([
      'Ended · attendance not confirmed',
      'Held',
      'No-show',
      'Booked',
    ]);
    const buttons = (node: HTMLElement): string[] => within(node).queryAllByRole('button').map(button => button.textContent ?? '');
    expect(rows.map(buttons)).toEqual([['Attended', 'No-show', 'Notes & tasks'], ['Undo', 'Notes & tasks'], ['Notes & tasks'], ['Notes & tasks']]);
    // Quiet until hover or focus (David's taste): the actions are hidden at rest.
    expect(within(rows[0] as HTMLElement).getByTestId('attendance-actions').className).toContain('opacity-0');
  });

  it('offers nothing while the session may not change anything', async () => {
    const { ports } = harness(async () => await Promise.resolve({ meetings: [row(MEETING, 'ended')] }));
    render(
      <Session>
        <FirmMeetings firmId={FIRM_ID} ports={ports} actionsEnabled={false} />
      </Session>,
    );
    const [only] = await screen.findAllByTestId('firm-meeting-row');
    expect(within(only as HTMLElement).queryAllByRole('button').map(button => button.textContent)).toEqual(['Notes & tasks']);
  });

  it('the board card says ended is not confirmed', () => {
    expect(meetingLabel({ meetingId: MEETING, state: 'ended', startsAt: PAST })).toMatch(/^Ended, not confirmed · /u);
    expect(meetingLabel({ meetingId: MEETING, state: 'held', startsAt: PAST })).toMatch(/^Held · /u);
  });
});

describe('kept state (K1, K3, K6, K7)', () => {
  it('K3/K7: an answer that lands after the row left shows when it is back, and a read begun before it never shows the old state', async () => {
    const reads: Deferred<{ meetings: readonly FirmMeetingDto[] }>[] = [];
    const { ports, sent, answers } = harness(async () => {
      const next = deferred<{ meetings: readonly FirmMeetingDto[] }>();
      reads.push(next);
      return await next.promise;
    });
    const view = render(
      <Session>
        <FirmMeetings firmId={FIRM_ID} ports={ports} />
      </Session>,
    );
    await act(async () => {
      reads[0]?.resolve({ meetings: [row(MEETING, 'ended')] });
      await Promise.resolve();
    });
    await userEvent.click(await screen.findByTestId('attendance-attended'));
    expect(sent).toEqual([{ meetingId: MEETING, attendance: 'attended', commandId: expect.any(String) as string }]);

    // The row goes (David opens another view) and comes back; its read begins before the answer.
    view.rerender(<Session>{null}</Session>);
    view.rerender(
      <Session>
        <FirmMeetings firmId={FIRM_ID} ports={ports} />
      </Session>,
    );
    await act(async () => {
      answers[0]?.resolve({ set: { meetingId: MEETING, state: 'held', attendanceSource: 'manual' }, reason: null });
      await Promise.resolve();
    });
    // The read begun before the answer lands with the old state: dropped (K7), read again.
    await act(async () => {
      reads[1]?.resolve({ meetings: [row(MEETING, 'ended')] });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(reads.length).toBeGreaterThanOrEqual(3);
    });
    await act(async () => {
      reads[2]?.resolve({ meetings: [row(MEETING, 'held', 'manual')] });
      await Promise.resolve();
    });
    expect(screen.getByTestId('firm-meeting-state').textContent).toBe('Held');
    expect(screen.queryByText('Ended · attendance not confirmed')).toBeNull();
    // K6: the success answer cleared the command — no Retry, and Undo is a new command.
    expect(screen.queryByTestId('attendance-retry')).toBeNull();
    await userEvent.click(screen.getByTestId('attendance-undo'));
    expect(sent.map(entry => entry.attendance)).toEqual(['attended', 'unconfirmed']);
    expect(sent[1]?.commandId).not.toBe(sent[0]?.commandId);
  });

  it('K3: a late refusal is said beside its own meeting only, and a lost answer is retried under the same id', async () => {
    const { ports, sent, answers } = harness(async () => await Promise.resolve({ meetings: [row(MEETING, 'ended'), row(OTHER, 'ended')] }));
    const view = render(
      <Session>
        <FirmMeetings firmId={FIRM_ID} ports={ports} />
      </Session>,
    );
    const [first, second] = await screen.findAllByTestId('firm-meeting-row');
    await userEvent.click(within(first as HTMLElement).getByTestId('attendance-attended'));
    await userEvent.click(within(second as HTMLElement).getByTestId('attendance-no-show'));
    view.rerender(<Session>{null}</Session>);
    await act(async () => {
      answers[0]?.resolve({ set: null, reason: 'not_assigned' });
      answers[1]?.resolve({ set: null, reason: 'offline' });
      await Promise.resolve();
    });
    view.rerender(
      <Session>
        <FirmMeetings firmId={FIRM_ID} ports={ports} />
      </Session>,
    );
    const [again, otherAgain] = await screen.findAllByTestId('firm-meeting-row');
    expect(within(again as HTMLElement).getByTestId('attendance-note').textContent).not.toContain('not_assigned');
    expect(within(again as HTMLElement).queryByTestId('attendance-retry')).toBeNull();
    expect(within(otherAgain as HTMLElement).getByTestId('attendance-note').textContent).toContain('Retry sends the same request again');
    await userEvent.click(within(otherAgain as HTMLElement).getByTestId('attendance-retry'));
    expect(sent[2]).toEqual({ meetingId: OTHER, attendance: 'no_show', commandId: sent[1]?.commandId });
  });

  it('K1: a sign-out forgets the pending command, its note and its answer', async () => {
    const { ports, answers } = harness(async () => await Promise.resolve({ meetings: [row(MEETING, 'ended')] }));
    const first = render(
      <Session>
        <FirmMeetings firmId={FIRM_ID} ports={ports} />
      </Session>,
    );
    await userEvent.click(await screen.findByTestId('attendance-attended'));
    await act(async () => {
      answers[0]?.resolve({ set: null, reason: 'offline' });
      await Promise.resolve();
    });
    expect(await screen.findByTestId('attendance-retry')).toBeTruthy();
    first.unmount();
    // Signing back in, even as the same person, is a new session: a new drafts epoch.
    render(
      <Session>
        <FirmMeetings firmId={FIRM_ID} ports={ports} />
      </Session>,
    );
    await screen.findByTestId('firm-meeting-row');
    expect(screen.queryByTestId('attendance-note')).toBeNull();
    expect(screen.queryByTestId('attendance-retry')).toBeNull();
  });

  it('K7: another firm s rows never show while this firm s read is under way', async () => {
    const pending = deferred<{ meetings: readonly FirmMeetingDto[] }>();
    let calls = 0;
    const ports: FirmMeetingsPorts = {
      forFirm: async () => {
        calls += 1;
        return calls === 1 ? await Promise.resolve({ meetings: [row(MEETING, 'held', 'manual')] }) : await pending.promise;
      },
    };
    const view = render(
      <Session>
        <FirmMeetings firmId={FIRM_ID} ports={ports} />
      </Session>,
    );
    await screen.findByTestId('firm-meeting-row');
    view.rerender(
      <Session>
        <FirmMeetings firmId="11111111-1111-4111-8111-111111111199" ports={ports} />
      </Session>,
    );
    expect(screen.queryByTestId('firm-meeting-row')).toBeNull();
  });
});

describe('the stage suggestion (a booking no longer moves the deal)', () => {
  it('on the firm page: one quiet line, and the click hands the suggestion to the stage command', async () => {
    const suggestion = { stageKey: 'demo_booked', opportunityId: OPPORTUNITY_ID };
    const { ports } = harness(async () => await Promise.resolve({ meetings: [row(MEETING, 'booked')], stageSuggestion: suggestion }));
    const apply = vi.fn();
    render(
      <Session>
        <FirmMeetings firmId={FIRM_ID} ports={ports} onApplySuggestion={apply} />
      </Session>,
    );
    await userEvent.click(await screen.findByTestId('stage-suggestion-apply'));
    // With the firm it was read for (review M1R, finding 2).
    expect(apply).toHaveBeenCalledWith(suggestion, FIRM_ID);
  });

  it('on the board card: one click sends the ordinary stage change, only for the deal this person may move', async () => {
    const view = pipelineView();
    const stage = view.columns[1]?.stage;
    if (stage === undefined) throw new Error('no stage');
    const card = (suggestion: StageSuggestion | null): BoardCard => ({
      value: null,
      meeting: { meetingId: MEETING, state: 'booked', startsAt: PAST },
      evidence: null,
      pinned: false,
      closeReason: null,
      stageSuggestion: suggestion,
    });
    const changes: unknown[] = [];
    const firm = view.columns[1]?.firms[0];
    if (firm === undefined) throw new Error('no firm');
    const common = {
      firm,
      stage,
      stages: view.columns.map(column => column.stage),
      actionsEnabled: true,
      stageBusy: false,
      valueBusy: false,
      onChangeStage: (change: unknown) => {
        changes.push(change);
      },
      onSetValue: () => undefined,
      onOpenFirm: () => undefined,
    };
    const shown = render(<BoardCardView {...common} card={card({ stageKey: 'engaged', opportunityId: OPPORTUNITY_ID, fromStageKey: 'new' })} opportunityId={OPPORTUNITY_ID} />);
    await userEvent.click(screen.getByTestId('card-stage-suggestion'));
    // With the stage the card was read at (review M1R, finding 6).
    expect(changes).toEqual([{ opportunityId: OPPORTUNITY_ID, toStageKey: 'engaged', reason: null, expectedStageKey: 'new' }]);
    shown.unmount();
    // A server that does not say: the column the card is drawn in.
    const older = render(<BoardCardView {...common} card={card({ stageKey: 'engaged', opportunityId: OPPORTUNITY_ID })} opportunityId={OPPORTUNITY_ID} />);
    await userEvent.click(screen.getByTestId('card-stage-suggestion'));
    expect(changes.at(-1)).toEqual({ opportunityId: OPPORTUNITY_ID, toStageKey: 'engaged', reason: null, expectedStageKey: stage.key });
    older.unmount();
    // A colleague's firm (no opportunity id for this person): nothing offered.
    render(<BoardCardView {...common} card={card({ stageKey: 'engaged', opportunityId: OPPORTUNITY_ID })} opportunityId={undefined} />);
    expect(screen.queryByTestId('card-stage-suggestion')).toBeNull();
  });

  it('K4: J then Enter with the suggestion focused sends no stage change', async () => {
    const calls: string[] = [];
    const source = createGeneration();
    const suggestionCard: BoardCard = {
      value: null,
      meeting: { meetingId: MEETING, state: 'booked', startsAt: PAST },
      evidence: null,
      pinned: false,
      closeReason: null,
      stageSuggestion: { stageKey: 'engaged', opportunityId: OPPORTUNITY_ID },
    };
    const state: CrmState = crmState({ screen: 'pipeline', firm: null, pipeline: { ...pipelineView(), cards: { [FIRM_ID]: suggestionCard } } });
    const answer = (name: string): unknown => {
      calls.push(name);
      if (name === 'meetings.forFirm' || name === 'meetings.unmatched') return { meetings: [], stageSuggestion: null };
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
    const card = (await screen.findAllByTestId('pipeline-firm')).find(node => node.getAttribute('data-firm-id') === FIRM_ID) as HTMLElement;
    within(card).getByTestId('card-stage-suggestion').focus();
    await userEvent.keyboard('j');
    await userEvent.keyboard('{Enter}');
    expect(calls.filter(name => name === 'crm.changeStage')).toEqual([]);
  });
});

describe('review M1R', () => {
  const booked = (): FirmMeetingDto => ({ meetingId: MEETING, state: 'booked', startsAt: '2099-06-02T15:00:00.000Z', endsAt: '2099-06-02T15:30:00.000Z', attendanceSource: null });

  it('finding 6: a stage change hides the suggestion until the read it caused lands', async () => {
    const pending = deferred<{ meetings: readonly FirmMeetingDto[]; stageSuggestion: StageSuggestion | null }>();
    const suggestion = { stageKey: 'demo_booked', opportunityId: OPPORTUNITY_ID, fromStageKey: 'interested' };
    const forFirm = vi
      .fn<FirmMeetingsPorts['forFirm']>()
      .mockResolvedValueOnce({ meetings: [booked()], stageSuggestion: suggestion })
      .mockReturnValueOnce(pending.promise);
    const apply = vi.fn();
    const view = render(
      <Session>
        <FirmMeetings firmId={FIRM_ID} ports={{ forFirm }} onApplySuggestion={apply} refreshKey="deal:interested" />
      </Session>,
    );
    await screen.findByTestId('stage-suggestion-apply');
    view.rerender(
      <Session>
        <FirmMeetings firmId={FIRM_ID} ports={{ forFirm }} onApplySuggestion={apply} refreshKey="deal:proposal" />
      </Session>,
    );
    expect(screen.queryByTestId('stage-suggestion-apply')).toBeNull();
    expect(apply).not.toHaveBeenCalled();
    // The fresh read: still due from the new stage, so offered again, from it.
    const fresh = { ...suggestion, fromStageKey: 'proposal' };
    await act(async () => {
      pending.resolve({ meetings: [booked()], stageSuggestion: fresh });
      await Promise.resolve();
    });
    await userEvent.click(await screen.findByTestId('stage-suggestion-apply'));
    expect(apply).toHaveBeenCalledWith(fresh, FIRM_ID);
  });

  it('finding 5: a read that began before a success and lands in the same turn never puts the old state back', async () => {
    const response = deferred<Answer>();
    const stale = deferred<{ meetings: readonly FirmMeetingDto[] }>();
    const fresh = deferred<{ meetings: readonly FirmMeetingDto[] }>();
    const forFirm = vi
      .fn<FirmMeetingsPorts['forFirm']>()
      .mockResolvedValueOnce({ meetings: [row(MEETING, 'ended')] })
      .mockReturnValueOnce(stale.promise)
      .mockReturnValue(fresh.promise);
    const setAttendance = vi.fn<NonNullable<FirmMeetingsPorts['setAttendance']>>().mockReturnValue(response.promise);
    const ports: FirmMeetingsPorts = { forFirm, setAttendance };
    const view = render(
      <Session>
        <FirmMeetings firmId={FIRM_ID} ports={ports} refreshKey="before" />
      </Session>,
    );
    await userEvent.click(await screen.findByTestId('attendance-attended'));
    // A read begins before the answer (the page's stage moved, say).
    view.rerender(
      <Session>
        <FirmMeetings firmId={FIRM_ID} ports={ports} refreshKey="read-again" />
      </Session>,
    );
    await act(async () => {
      response.resolve({ set: { meetingId: MEETING, state: 'held', attendanceSource: 'manual' }, reason: null });
      stale.resolve({ meetings: [row(MEETING, 'ended')] });
      await Promise.resolve();
    });
    expect(screen.getByTestId('firm-meeting-state').textContent).toBe('Held');
    // The read that began after the answer is the one that replaces it.
    await act(async () => {
      fresh.resolve({ meetings: [row(MEETING, 'held', 'manual')] });
      await Promise.resolve();
    });
    expect(screen.getByTestId('firm-meeting-state').textContent).toBe('Held');
  });

  it('finding 2: the firm page opens a deal at the stage for the firm the suggestion was read for', async () => {
    const page = assigneeFirmPage();
    if (page.visibility !== 'assigned_or_admin') throw new Error('fixture');
    const state = crmState({ screen: 'firm', firm: { ...page, opportunity: null } });
    const calls: { name: string; input: unknown }[] = [];
    const answer = (name: string, input: unknown): unknown => {
      calls.push({ name, input });
      switch (name) {
        case 'meetings.forFirm':
          return { meetings: [booked()], stageSuggestion: { stageKey: 'demo_booked', opportunityId: null, fromStageKey: null } };
        case 'meetings.unmatched':
          return { meetings: [] };
        case 'calling.history':
          return { calls: null };
        case 'research.open':
          return { firm: null, settings: null, worstCaseRunCents: null, spend: null, notice: null, mayMutate: true, role: 'salesperson' };
        default:
          return state;
      }
    };
    globalThis.callieApi = {
      read: async (name: string, input: unknown) => await Promise.resolve(answer(name, input)),
      command: async (name: string, input: unknown) => await Promise.resolve(answer(name, input)),
    } as unknown as OperationApi;
    const source = createGeneration();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
    render(
      <QueryClientProvider client={client}>
        <DraftsProvider>
          <FirmsRoute route={{ name: 'firm', firmId: FIRM_ID }} identity="person-1" generation={0} guard={source.guard} />
        </DraftsProvider>
      </QueryClientProvider>,
    );
    await userEvent.click(await screen.findByTestId('stage-suggestion-apply'));
    await waitFor(() => {
      expect(calls.filter(call => call.name === 'crm.openOpportunity').map(call => call.input)).toEqual([{ firmId: FIRM_ID, stageKey: 'demo_booked' }]);
    });
    globalThis.callieApi = undefined;
  });
});
