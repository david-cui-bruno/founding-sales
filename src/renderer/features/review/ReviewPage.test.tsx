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
import { ReviewDetailPanel } from './ReviewDetailPanel';
import { ReviewItem as ReviewItemRow } from './ReviewItem';
import { REVIEW_KIND_ORDER } from './reviewKindMeta';

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
    unmatchedItem, systemErrorItem,
  ],
  totalOpenCount: 2,
  nextCursor: null, matchedCount: 2,
  countScope: 'lifecycle_review_items', observedAt: '2026-09-10T00:00:00.000Z',
  queues: {
    unmatched_communication: { source: 'lifecycle_review_items', openCount: 1 },
    system_error: { source: 'lifecycle_review_items', openCount: 1 },
    ambiguous_identity: { source: 'not_integrated', openCount: null },
    transcript_suggestion: { source: 'not_integrated', openCount: null },
    import_problem: { source: 'not_integrated', openCount: null },
    adapter_failure: { source: 'not_integrated', openCount: null },
  },
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
    expect(screen.getByRole('alert').textContent).toContain('1 system errors need attention.');
  });

  it('renders one counted tab per review kind in a fixed order', () => {
    renderPage();

    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'Unmatched communications 1',
      'Ambiguous identities Not available in this Inbox',
      'Transcript suggestions Not available in this Inbox',
      'Import problems Not available in this Inbox',
      'Adapter failures Not available in this Inbox',
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

    expect(screen.getByRole('alert').textContent).toContain('1 system errors need attention.');
  });

  it('selects a queue through the tab control', () => {
    const { onSelectKind } = renderPage();

    fireEvent.click(screen.getByRole('tab', { name: /Import problems/ }));

    expect(onSelectKind).toHaveBeenCalledWith('import_problem');
  });

  it('lists only the selected kind inside the queue', () => {
    renderPage({ selectedKind: 'system_error' });

    const queue = screen.getByRole('list', { name: /System errors/ });
    expect(within(queue).getAllByRole('listitem')).toHaveLength(1);
    expect(queue.textContent).toContain('Missing primary next action on an active cycle.');
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

  it.each(REVIEW_KIND_ORDER)('scopes the empty %s view to a neutral local snapshot', (selectedKind) => {
    renderPage({
      snapshot: reviewSnapshotSchema.parse({ items: [], totalOpenCount: 0, revision: 6, nextCursor: null, matchedCount: 0,
  countScope: 'lifecycle_review_items', observedAt: '2026-09-10T00:00:00.000Z',
  queues: {
    unmatched_communication: { source: 'lifecycle_review_items', openCount: 0 },
    system_error: { source: 'lifecycle_review_items', openCount: 0 },
    ambiguous_identity: { source: 'not_integrated', openCount: null },
    transcript_suggestion: { source: 'not_integrated', openCount: null },
    import_problem: { source: 'not_integrated', openCount: null },
    adapter_failure: { source: 'not_integrated', openCount: null },
  }, }),
      selectedKind,
    });
    const integrated = selectedKind === 'unmatched_communication' || selectedKind === 'system_error';
    const badge = integrated ? screen.getByText('No items in this view') : screen.getAllByText('Not available in this Inbox').find(node => node.closest('.status-badge'))!;
    expect(badge.closest('.status-badge')?.className).toContain('status-badge--neutral');
    if (integrated) expect(screen.getByText(/No items are shown in this local review snapshot/).textContent)
      .toMatch(/not.*import.completeness.*identity.completeness.*adapter.health/i);
    else expect(screen.getByText(/No count or health conclusion is available/)).toBeTruthy();
    expect(screen.queryByText(/Every call|Every imported row|All adapters are healthy|Queue clear/)).toBeNull();
    expect(screen.getAllByRole('tab')).toHaveLength(6);
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
  it('does not offer or call unavailable Never Record writes', () => {
    const { onResolve } = renderPage();
    fireEvent.click(screen.getByRole('button', { name: /\+14015550100/ }));
    const personal = screen.queryByRole('button', { name: /Mark personal/ });
    if (personal) fireEvent.click(personal);
    expect(onResolve).not.toHaveBeenCalled();
    expect(personal === null || (personal as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Never Record has not been applied/)).toBeTruthy();
    expect(screen.getAllByText(unmatchedItem.summary).length).toBeGreaterThan(0);
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

  it.each([
    { item: ambiguousItem, row: /Two people match/, evidence: 'Two people match this inbound reply.' },
    { item: painSuggestion, row: /Loses weekends/, evidence: 'We keep losing weekends to showings.' },
    { item: importItem, row: /Row 7/, evidence: 'Row 7 is missing a phone number and an email.' },
    { item: adapterItem, row: /Apple bridge/, evidence: 'The Apple bridge stopped syncing messages.' },
    { item: systemErrorItem, row: /Missing primary next action/, evidence: 'Invariant: primary_next_action_missing' },
  ])('keeps synthetic $item.kind detail evidence read-only without callable writes', ({ item, evidence }) => {
    const onResolve = vi.fn();
    const onOpenLead = vi.fn();
    render(<>
      <ul><ReviewItemRow item={item} selected onSelect={vi.fn()} /></ul>
      <ReviewDetailPanel item={item} onResolve={onResolve} onOpenLead={onOpenLead} />
    </>);
    // Exercise exposed controls, including any accidentally retained mutation.
    for (const button of screen.queryAllByRole('button')) fireEvent.click(button);
    expect(onResolve).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /^(Choose |Accept|Save edit|Dismiss|Retry|Repair invariant)/ })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Repair command' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Edited value' })).toBeNull();
    expect(screen.getAllByText(evidence).length).toBeGreaterThan(0);
    expect(screen.getByText(/unavailable in this Inbox/i)).toBeTruthy();
    if (item.kind === 'ambiguous_identity') {
      fireEvent.click(screen.getByRole('button', { name: 'Open person-kevin-2' }));
      expect(onOpenLead).toHaveBeenCalledWith('person-kevin-2');
    }
    if (item.kind === 'adapter_failure') expect(screen.getByText('Outbound blocking')).toBeTruthy();
  });

  it.each([
    { name: 'compatible', items: [painSuggestion, objectionSuggestion] },
    { name: 'conflicting', items: [painSuggestion, conflictingPainSuggestion] },
  ])('cannot batch-accept $name transcript suggestions', ({ items }) => {
    const { onResolve } = renderPage({
      // Synthetic DTO branch probe, not an integrated source count.
      snapshot: reviewSnapshotSchema.parse({ items, totalOpenCount: 0, revision: 5, nextCursor: null, matchedCount: 0,
  countScope: 'lifecycle_review_items', observedAt: '2026-09-10T00:00:00.000Z',
  queues: {
    unmatched_communication: { source: 'lifecycle_review_items', openCount: 0 },
    system_error: { source: 'lifecycle_review_items', openCount: 0 },
    ambiguous_identity: { source: 'not_integrated', openCount: null },
    transcript_suggestion: { source: 'not_integrated', openCount: null },
    import_problem: { source: 'not_integrated', openCount: null },
    adapter_failure: { source: 'not_integrated', openCount: null },
  }, }),
      selectedKind: 'transcript_suggestion',
    });
    const batch = screen.queryByRole('button', { name: /Accept all/ });
    if (batch) fireEvent.click(batch);
    expect(onResolve).not.toHaveBeenCalled();
    expect(batch === null || (batch as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText('Not available in this Inbox').length).toBeGreaterThan(0);
  });
});

function reliabilityPageSnapshot(): ReviewSnapshot {
  return {
    // One loaded row does not represent the complete local queue.
    items: [unmatchedItem], totalOpenCount: 208, revision: 20,
    nextCursor: 'synthetic-renderer-continuation', matchedCount: 205,
    countScope: 'lifecycle_review_items' as const,
    observedAt: '2026-09-10T00:00:00.000Z',
    queues: {
      unmatched_communication: { source: 'lifecycle_review_items' as const, openCount: 205 },
      system_error: { source: 'lifecycle_review_items' as const, openCount: 3 },
      ambiguous_identity: { source: 'not_integrated' as const, openCount: null },
      transcript_suggestion: { source: 'not_integrated' as const, openCount: null },
      import_problem: { source: 'not_integrated' as const, openCount: null },
      adapter_failure: { source: 'not_integrated' as const, openCount: null },
    },
  };
}

describe('reliability: complete source-scoped Inbox presentation', () => {
  it('counts complete queues rather than the single loaded row', () => {
    renderPage({ snapshot: reliabilityPageSnapshot() });
    const unmatched = screen.getByRole('tab', { name: /Unmatched communications/ });
    const system = screen.getByRole('tab', { name: /System errors/ });
    expect(unmatched.textContent).toMatch(/\b205\b/);
    expect(system.textContent).toMatch(/\b3\b/);
    expect(within(screen.getByRole('list', { name: /Unmatched communications/ }))
      .getAllByRole('listitem')).toHaveLength(1);
  });

  it('discloses that the complete count covers local reviews', () => {
    renderPage({ snapshot: reliabilityPageSnapshot() });
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.textContent).toBe('Inbox · 208 open local reviews');
  });

  it('offers access to system errors even when none of their rows are loaded', () => {
    const { onSelectKind } = renderPage({ snapshot: reliabilityPageSnapshot() });
    const alert = screen.queryByRole('alert');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toMatch(/system errors/i);
    const viewErrors = screen.queryByRole('button', { name: /View system errors/i });
    expect(viewErrors).not.toBeNull();
    fireEvent.click(viewErrors!);
    expect(onSelectKind).toHaveBeenCalledWith('system_error');
  });

  it.each([
    { kind: 'ambiguous_identity' as const, label: /Ambiguous identities/ },
    { kind: 'transcript_suggestion' as const, label: /Transcript suggestions/ },
    { kind: 'import_problem' as const, label: /Import problems/ },
    { kind: 'adapter_failure' as const, label: /Adapter failures/ },
  ])('keeps $kind reachable but never presents an unintegrated source as empty', ({ kind, label }) => {
    const snapshot: ReviewSnapshot = { ...reliabilityPageSnapshot(), items: [], matchedCount: 0, nextCursor: null };
    const { onSelectKind } = renderPage({ snapshot, selectedKind: kind });
    const tab = screen.getByRole('tab', { name: label });
    expect(tab.textContent).not.toMatch(/\b0\b/);
    expect(tab.getAttribute('aria-selected')).toBe('true');
    fireEvent.click(tab);
    expect(onSelectKind).toHaveBeenCalledWith(kind);
    expect(screen.queryAllByText(/Not available in this Inbox/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/All adapters are healthy|Queue clear/)).toBeNull();
    expect(screen.queryByRole('button', { name: /^(Accept all|Repair invariant|Retry adapter)/ })).toBeNull();
  });
});
