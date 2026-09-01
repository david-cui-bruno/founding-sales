// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  reviewSnapshotSchema,
  type ReviewItem,
  type ReviewSnapshot,
} from '../../../shared/contracts/reviewContract';
import { ReviewPage } from './ReviewPage';

afterEach(() => {
  cleanup();
});

const unmatchedItem: ReviewItem = {
  kind: 'unmatched_communication',
  reviewId: 'review-unmatched',
  channel: 'text',
  handle: '+14015550100',
  occurredAt: '2026-08-30T12:00:00.000Z',
  summary: 'Inbound text from an unknown number.',
};

const ambiguousItem: ReviewItem = {
  kind: 'ambiguous_identity',
  reviewId: 'review-ambiguous',
  candidatePersonIds: ['person-kevin', 'person-kevin-2'],
  summary: 'Two people match this inbound reply.',
};

const painSuggestion: ReviewItem = {
  kind: 'transcript_suggestion',
  reviewId: 'review-pain',
  personId: 'person-kevin',
  suggestionType: 'pain',
  evidence: ['We keep losing weekends to showings.'],
  proposedValue: 'Loses weekends to showings',
};

const objectionSuggestion: ReviewItem = {
  kind: 'transcript_suggestion',
  reviewId: 'review-objection',
  personId: 'person-maya',
  suggestionType: 'objection',
  evidence: ['Worried about handing off tenant calls.'],
  proposedValue: 'Fears losing tenant relationships',
};

const conflictingPainSuggestion: ReviewItem = {
  kind: 'transcript_suggestion',
  reviewId: 'review-pain-conflict',
  personId: 'person-kevin',
  suggestionType: 'pain',
  evidence: ['Also mentioned vacancy stress.'],
  proposedValue: 'Vacancy stress',
};

const importItem: ReviewItem = {
  kind: 'import_problem',
  reviewId: 'review-import',
  rowNumber: 7,
  summary: 'Row 7 is missing a phone number and an email.',
};

const adapterItem: ReviewItem = {
  kind: 'adapter_failure',
  reviewId: 'review-adapter',
  adapter: 'apple_bridge',
  summary: 'The Apple bridge stopped syncing messages.',
  blocking: true,
};

const systemErrorItem: ReviewItem = {
  kind: 'system_error',
  reviewId: 'review-system',
  invariant: 'primary_next_action_missing',
  summary: 'Missing primary next action on an active cycle.',
  personId: 'person-kevin',
};

const reviewSnapshot: ReviewSnapshot = reviewSnapshotSchema.parse({
  items: [
    unmatchedItem, ambiguousItem, painSuggestion, objectionSuggestion,
    importItem, adapterItem, systemErrorItem,
  ],
  totalOpenCount: 7,
  revision: 4,
});

function renderPage(overrides: Partial<Parameters<typeof ReviewPage>[0]> = {}) {
  const props = {
    snapshot: reviewSnapshot,
    selectedKind: 'unmatched_communication' as const,
    onSelectKind: vi.fn(),
    onResolve: vi.fn(),
    onOpenLead: vi.fn(),
    ...overrides,
  };
  render(<ReviewPage {...props} />);
  return props;
}

describe('ReviewPage tabs', () => {
  it('shows safety/system queues separately and never hides invariant errors', () => {
    renderPage({ selectedKind: 'system_error' });

    expect(screen.getByRole('tab', { name: /System errors 1/ })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Missing primary next action');
  });

  it('renders one counted tab per review kind in a fixed order', () => {
    renderPage();

    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'Unmatched communications 1',
      'Ambiguous identities 1',
      'Transcript suggestions 2',
      'Import problems 1',
      'Adapter failures 1',
      'System errors 1',
    ]);
  });

  it('styles the queue switcher as a segmented control with aria-selected', () => {
    renderPage({ selectedKind: 'import_problem' });

    const tablist = screen.getByRole('tablist', { name: 'Review queues' });
    expect(tablist.className).toContain('segmented-control');
    const selected = screen.getByRole('tab', { name: /Import problems/ });
    expect(selected.getAttribute('aria-selected')).toBe('true');
    expect(selected.className).toContain('segmented-control__option');
    expect(
      screen.getByRole('tab', { name: /Adapter failures/ }).getAttribute('aria-selected'),
    ).toBe('false');
  });

  it('keeps the system-error alert visible while another queue is selected', () => {
    renderPage({ selectedKind: 'transcript_suggestion' });

    expect(screen.getByRole('alert').textContent).toContain('Missing primary next action');
  });

  it('selects a queue through the tab control', () => {
    const { onSelectKind } = renderPage();

    fireEvent.click(screen.getByRole('tab', { name: /Import problems/ }));

    expect(onSelectKind).toHaveBeenCalledWith('import_problem');
  });

  it('lists only the selected kind inside the queue', () => {
    renderPage({ selectedKind: 'adapter_failure' });

    const queue = screen.getByRole('list', { name: /Adapter failures/ });
    expect(within(queue).getAllByRole('listitem')).toHaveLength(1);
    expect(queue.textContent).toContain('The Apple bridge stopped syncing messages.');
  });

  it('shows a humanized kind label, relative time, and a resolve affordance on rows', () => {
    renderPage();

    const queue = screen.getByRole('list', { name: /Unmatched communications/ });
    const row = within(queue).getByRole('button', { name: /\+14015550100/ });
    expect(within(row).getByText('Unmatched communication')).toBeTruthy();
    const when = row.querySelector('.review-item__when');
    expect(when?.textContent).toMatch(/ago$|^now$|Aug|Sep/);
    expect(within(row).getByText('Resolve').className).toContain('review-item__resolve');
  });

  it('renders the queue-clear empty state as a success dot with neutral text', () => {
    const singleKind = reviewSnapshotSchema.parse({
      items: [unmatchedItem],
      totalOpenCount: 1,
      revision: 6,
    });
    renderPage({ snapshot: singleKind, selectedKind: 'transcript_suggestion' });

    const badge = screen.getByText('Queue clear');
    expect(badge.closest('.status-badge')?.className).toContain('status-badge--success');
    expect(
      screen.getByText('No transcript facts are waiting for review.'),
    ).toBeTruthy();
  });

  it('is axe-clean', async () => {
    render(
      <ReviewPage
        snapshot={reviewSnapshot}
        selectedKind="unmatched_communication"
        onSelectKind={vi.fn()}
        onResolve={vi.fn()}
        onOpenLead={vi.fn()}
      />,
    );

    const results = await axe.run(document.body, {
      rules: {
        'color-contrast': { enabled: false },
        region: { enabled: false },
      },
    });

    expect(results.violations).toEqual([]);
  });
});

describe('ReviewPage resolution flows', () => {
  it('marks an unmatched communication personal with a Never Record command', () => {
    const { onResolve } = renderPage();

    fireEvent.click(screen.getByRole('button', { name: /\+14015550100/ }));
    fireEvent.click(screen.getByRole('button', { name: /Mark personal/ }));

    expect(onResolve).toHaveBeenCalledWith({
      kind: 'unmatched_communication',
      reviewId: 'review-unmatched',
      expectedVersion: 1,
      action: 'mark_personal',
      personId: null,
      sourceEventId: null,
    });
  });

  it('requires matched evidence before promoting an unmatched communication', () => {
    const { onResolve } = renderPage();
    fireEvent.click(screen.getByRole('button', { name: /\+14015550100/ }));

    const promote = screen.getByRole('button', { name: /Promote/ });
    expect((promote as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/Matched source event ID/), {
      target: { value: 'source-9' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Promote/ }));

    expect(onResolve).toHaveBeenCalledWith({
      kind: 'unmatched_communication',
      reviewId: 'review-unmatched',
      expectedVersion: 1,
      action: 'promote',
      personId: null,
      sourceEventId: 'source-9',
    });
  });

  it('resolves an ambiguous identity by choosing one candidate and can open it', () => {
    const { onResolve, onOpenLead } = renderPage({ selectedKind: 'ambiguous_identity' });

    fireEvent.click(screen.getByRole('button', { name: /Two people match/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Open person-kevin-2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose person-kevin-2' }));

    expect(onOpenLead).toHaveBeenCalledWith('person-kevin-2');
    expect(onResolve).toHaveBeenCalledWith({
      kind: 'ambiguous_identity',
      reviewId: 'review-ambiguous',
      expectedVersion: 1,
      action: 'choose_identity',
      personId: 'person-kevin-2',
    });
  });

  it('accepts, edits, and dismisses a transcript suggestion with only valid payloads', () => {
    const { onResolve } = renderPage({ selectedKind: 'transcript_suggestion' });

    fireEvent.click(screen.getByRole('button', { name: /Loses weekends/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    expect(onResolve).toHaveBeenLastCalledWith({
      kind: 'transcript_suggestion',
      reviewId: 'review-pain',
      expectedVersion: 1,
      action: 'accept',
      editedValue: null,
    });

    fireEvent.change(screen.getByLabelText(/Edited value/), {
      target: { value: 'Weekend showings burn him out' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save edit/ }));
    expect(onResolve).toHaveBeenLastCalledWith({
      kind: 'transcript_suggestion',
      reviewId: 'review-pain',
      expectedVersion: 1,
      action: 'edit',
      editedValue: 'Weekend showings burn him out',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onResolve).toHaveBeenLastCalledWith({
      kind: 'transcript_suggestion',
      reviewId: 'review-pain',
      expectedVersion: 1,
      action: 'dismiss',
      editedValue: null,
    });
  });

  it('batch-accepts compatible transcript suggestions in one click', () => {
    const { onResolve } = renderPage({ selectedKind: 'transcript_suggestion' });

    fireEvent.click(screen.getByRole('button', { name: /Accept all 2/ }));

    expect(onResolve).toHaveBeenCalledTimes(2);
    expect(onResolve).toHaveBeenCalledWith({
      kind: 'transcript_suggestion',
      reviewId: 'review-pain',
      expectedVersion: 1,
      action: 'accept',
      editedValue: null,
    });
    expect(onResolve).toHaveBeenCalledWith({
      kind: 'transcript_suggestion',
      reviewId: 'review-objection',
      expectedVersion: 1,
      action: 'accept',
      editedValue: null,
    });
  });

  it('refuses batch acceptance when suggestions conflict on the same person and type', () => {
    const conflicted = reviewSnapshotSchema.parse({
      items: [painSuggestion, conflictingPainSuggestion],
      totalOpenCount: 2,
      revision: 5,
    });
    renderPage({ snapshot: conflicted, selectedKind: 'transcript_suggestion' });

    expect(screen.queryByRole('button', { name: /Accept all/ })).toBeNull();
    expect(screen.getByText(/conflicting suggestions/i)).toBeTruthy();
  });

  it('retries or dismisses an import problem', () => {
    const { onResolve } = renderPage({ selectedKind: 'import_problem' });

    fireEvent.click(screen.getByRole('button', { name: /Row 7/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(onResolve).toHaveBeenCalledWith({
      kind: 'import_problem',
      reviewId: 'review-import',
      expectedVersion: 1,
      action: 'retry',
    });
  });

  it('marks a blocking adapter failure as outbound-blocking until resolved', () => {
    const { onResolve } = renderPage({ selectedKind: 'adapter_failure' });

    expect(screen.getByText('Outbound blocking')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Apple bridge/ }));
    fireEvent.click(screen.getByRole('button', { name: /Retry adapter/ }));

    expect(onResolve).toHaveBeenCalledWith({
      kind: 'adapter_failure',
      reviewId: 'review-adapter',
      expectedVersion: 1,
      action: 'retry',
    });
  });

  it('repairs a system error only through an explicit repair command', () => {
    const { onResolve } = renderPage({ selectedKind: 'system_error' });

    fireEvent.click(screen.getByRole('button', { name: /Missing primary next action/ }));
    const repair = screen.getByRole('button', { name: /Repair invariant/ });
    expect((repair as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/Repair command/), {
      target: { value: 'reissue_primary_next_action' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Repair invariant/ }));

    expect(onResolve).toHaveBeenCalledWith({
      kind: 'system_error',
      reviewId: 'review-system',
      expectedVersion: 1,
      action: 'repair_invariant',
      repairCommand: 'reissue_primary_next_action',
    });
  });
});
