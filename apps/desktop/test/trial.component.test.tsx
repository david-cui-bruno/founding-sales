// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { callTrialResponseSchema, type CallProposal, type CallTrialResponse, type CallTrialSample } from '@fss/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { Trial, TrialSection } from '../src/renderer/today/Trial.tsx';
import { PROPOSALS } from './support/analysisAnswers.ts';

/**
 * Slice S3T: Today › Overview › Trial. The progress line, the per-type table with its
 * "starts ticked" marker (the desktop's own `startsTicked`, asked of the server's sample),
 * "too few", the calls that do not count by reason with their lists, the incorrect stop and
 * deal suggestions, and the section hidden when the API does not serve the read (404).
 * No real firm: the names are test names.
 */

afterEach(() => {
  cleanup();
  (globalThis as { callieApi?: unknown }).callieApi = undefined;
});

const SESSION = '55555555-5555-4555-8555-555555555555';
const OTHER = '66666666-6666-4666-8666-666666666666';
const FIRM = '11111111-1111-4111-8111-111111111111';
const ANALYSIS = '77777777-7777-4777-8777-777777777777';

/** What the server sends of a suggestion (`sampleOf` in trialReport.ts): kind, mode, outcome. */
const sample = (proposal: CallProposal): CallTrialSample => ({
  kind: proposal.kind,
  mode: proposal.mode,
  outcome: proposal.kind === 'outcome' ? proposal.params.outcome : null,
});

const type = (patch: Partial<CallTrialResponse['types'][number]> & { type: string }): CallTrialResponse['types'][number] => ({
  unchanged: 0,
  edited: 0,
  declined: 0,
  bypassed: 0,
  undecided: 0,
  correctedOriginalError: 0,
  correctedNewInformation: 0,
  acceptedUnchangedShare: null,
  insufficient: true,
  applyMode: 0,
  reviewMode: 0,
  applySample: null,
  ...patch,
});

const TRIAL: CallTrialResponse = callTrialResponseSchema.parse({
  since: '2026-10-02T07:14:00.000Z',
  minimumRecordingSeconds: 20,
  target: 10,
  minimumDecided: 5,
  progress: { answered: 9, eligible: 7, analysed: 6, fullyDecided: 4 },
  unanswered: { total: 3, byProviderStatus: [{ providerStatus: 'busy', count: 1 }, { providerStatus: 'no-answer', count: 2 }] },
  excluded: {
    byReason: [
      { reason: 'answered_at_missing', count: 1 },
      { reason: 'too_short', count: 1 },
    ],
    sessions: [
      { callSessionId: SESSION, firmId: FIRM, firmName: 'Elm Fork Test Rentals', occurredAt: '2026-10-02T15:00:00.000Z', callSeconds: 25, recordingSeconds: 25, providerStatus: 'completed', reason: 'answered_at_missing' },
      { callSessionId: OTHER, firmId: FIRM, firmName: 'Birch Test Partners', occurredAt: '2026-10-02T16:00:00.000Z', callSeconds: 19, recordingSeconds: 19, providerStatus: 'completed', reason: 'too_short' },
    ],
  },
  analysis: { completed: 6, failed: 1, failedByReason: [{ reason: 'refused', count: 1 }], pending: 0, held: 0 },
  heldButExcluded: 0,
  types: [
    type({ type: 'buying_signal', declined: 1, undecided: 1, acceptedUnchangedShare: 0, applyMode: 2, applySample: sample(PROPOSALS.buyingSignal) }),
    type({ type: 'outcome:interested', unchanged: 5, bypassed: 1, acceptedUnchangedShare: 5 / 6, insufficient: false, applyMode: 6, applySample: sample(PROPOSALS.outcome) }),
    type({ type: 'stop', unchanged: 1, applyMode: 1, applySample: sample(PROPOSALS.stopOutcome) }),
    type({ type: 'task', unchanged: 5, correctedOriginalError: 1, acceptedUnchangedShare: 0.8, insufficient: false, applyMode: 5, applySample: sample(PROPOSALS.task) }),
  ],
  incorrect: [{ analysisId: ANALYSIS, callSessionId: SESSION, key: 'buying_signal', type: 'buying_signal', result: 'declined', decidedAt: '2026-10-02T16:30:00.000Z' }],
});

const rowOf = (name: string) => {
  const row = screen.getAllByTestId('trial-type').find(element => element.dataset['type'] === name);
  if (row === undefined) throw new Error(`no row ${name}`);
  return row;
};

describe('the Trial section', () => {
  it('says how many answered calls are analysed toward ten, since the 3a release', () => {
    render(<TrialSection trial={TRIAL} />);
    expect(screen.getByTestId('trial-progress').textContent).toBe('6 of 10 answered calls analysed, since 2 Oct');
    expect(screen.getByTestId('trial-funnel').textContent).toContain('9 answered · 7 eligible · 4 fully decided');
    expect(screen.getByTestId('trial-funnel').textContent).toContain('1 failed (refused 1)');
    expect(screen.queryByTestId('trial-check')).toBeNull();
  });

  it('marks the types that start ticked with the desktop rule: outcome and promises, never a stop or a deal', () => {
    render(<TrialSection trial={TRIAL} />);
    expect(within(rowOf('outcome:interested')).queryByTestId('trial-ticked')).not.toBeNull();
    expect(within(rowOf('task')).queryByTestId('trial-ticked')).not.toBeNull();
    expect(within(rowOf('stop')).queryByTestId('trial-ticked')).toBeNull();
    expect(within(rowOf('buying_signal')).queryByTestId('trial-ticked')).toBeNull();
  });

  it('a type offered only for review never starts ticked', () => {
    const reviewOnly = { ...TRIAL, types: [type({ type: 'outcome:interested', reviewMode: 2, applySample: null })] };
    render(<TrialSection trial={reviewOnly} />);
    expect(within(rowOf('outcome:interested')).queryByTestId('trial-ticked')).toBeNull();
  });

  it('shows the counts, the share, "too few" below five decided, and "corrected later"', () => {
    render(<TrialSection trial={TRIAL} />);
    const outcome = rowOf('outcome:interested');
    expect(within(outcome).getByTestId('trial-share').textContent).toBe('83%');
    expect(outcome.textContent).toContain('5');
    expect(within(rowOf('buying_signal')).getByTestId('trial-share').textContent).toBe('too few');
    expect(within(rowOf('task')).getByTestId('trial-corrected').textContent).toBe('corrected later: 1 model error, 0 new information');
    expect(within(outcome).queryByTestId('trial-corrected')).toBeNull();
    const headers = within(screen.getByTestId('trial-types')).getAllByRole('columnheader').map(cell => cell.textContent);
    expect(headers).toEqual(['Suggestion', 'Unchanged', 'Edited', 'Declined', 'Bypassed', 'Unresolved', 'Unchanged %']);
  });

  it('lists excluded calls by reason, each expandable to its calls, and the unanswered apart', () => {
    render(<TrialSection trial={TRIAL} />);
    const reasons = screen.getAllByTestId('trial-excluded-reason');
    expect(reasons.map(element => element.dataset['reason'])).toEqual(['answered_at_missing', 'too_short']);
    expect(reasons[1]?.querySelector('summary')?.textContent).toBe('Too short (recording under 20 s) · 1');
    expect(within(reasons[1] as HTMLElement).getByTestId('trial-excluded-session').textContent).toContain('Birch Test Partners · 2 Oct · call 19 s, recording 19 s');
    expect(within(reasons[0] as HTMLElement).getByTestId('trial-excluded-session').textContent).toContain('Elm Fork Test Rentals');
    expect(screen.getByTestId('trial-unanswered').textContent).toBe('Unanswered: 3 (busy 1, no-answer 2)');
  });

  it('lists every incorrect stop or deal suggestion', () => {
    render(<TrialSection trial={TRIAL} />);
    expect(screen.getAllByTestId('trial-incorrect-row').map(row => row.textContent)).toEqual(['Open a deal · declined · 2 Oct call 55555555']);
  });

  it('shows the check line when a held call is not analysable', () => {
    render(<TrialSection trial={{ ...TRIAL, heldButExcluded: 2 }} />);
    expect(screen.getByTestId('trial-check').textContent).toContain('2 held for review but not analysable');
  });
});

describe('the Trial read', () => {
  const mount = () =>
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <div data-testid="host">
          <Trial />
        </div>
      </QueryClientProvider>,
    );

  it('an API that does not serve the read (404 → null) hides the section, never an error', async () => {
    let asked = 0;
    (globalThis as { callieApi?: unknown }).callieApi = {
      read: async (name: string) => {
        asked += 1;
        expect(name).toBe('calling.trial');
        return await Promise.resolve({ trial: null });
      },
    };
    mount();
    await waitFor(() => {
      expect(asked).toBe(1);
    });
    expect(screen.getByTestId('host').innerHTML).toBe('');
  });

  it('draws the section when the read answers', async () => {
    (globalThis as { callieApi?: unknown }).callieApi = { read: async () => await Promise.resolve({ trial: TRIAL }) };
    mount();
    expect((await screen.findByTestId('trial-progress')).textContent).toContain('6 of 10');
  });
});
