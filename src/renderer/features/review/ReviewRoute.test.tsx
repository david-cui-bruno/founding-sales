// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MutationReceipt } from '../../../shared/contracts/commonContract';
import {
  reviewSnapshotSchema,
  type ReviewItem,
  type ReviewSnapshot,
} from '../../../shared/contracts/reviewContract';
import { ReviewRoute, type ReviewApi } from './ReviewRoute';
import { ReviewDetailPanel } from './ReviewDetailPanel';

afterEach(() => {
  cleanup();
});

const openSnapshot: ReviewSnapshot = reviewSnapshotSchema.parse({
  items: [{
    kind: 'unmatched_communication',
    reviewId: 'review-unmatched',
    channel: 'text',
    handle: '+14015550100',
    occurredAt: '2026-08-30T12:00:00.000Z',
    summary: 'Inbound text from an unknown number.',
  }],
  totalOpenCount: 1,
  nextCursor: null, matchedCount: 1,
  countScope: 'lifecycle_review_items', observedAt: '2026-09-10T00:00:00.000Z',
  queues: {
    unmatched_communication: { source: 'lifecycle_review_items', openCount: 1 },
    system_error: { source: 'lifecycle_review_items', openCount: 0 },
    ambiguous_identity: { source: 'not_integrated', openCount: null },
    transcript_suggestion: { source: 'not_integrated', openCount: null },
    import_problem: { source: 'not_integrated', openCount: null },
    adapter_failure: { source: 'not_integrated', openCount: null },
  },
  revision: 4,
});

const emptySnapshot: ReviewSnapshot = reviewSnapshotSchema.parse({
  items: [],
  totalOpenCount: 0,
  nextCursor: null, matchedCount: 0,
  countScope: 'lifecycle_review_items', observedAt: '2026-09-10T00:00:00.000Z',
  queues: {
    unmatched_communication: { source: 'lifecycle_review_items', openCount: 0 },
    system_error: { source: 'lifecycle_review_items', openCount: 0 },
    ambiguous_identity: { source: 'not_integrated', openCount: null },
    transcript_suggestion: { source: 'not_integrated', openCount: null },
    import_problem: { source: 'not_integrated', openCount: null },
    adapter_failure: { source: 'not_integrated', openCount: null },
  },
  revision: 5,
});

const receipt: MutationReceipt = {
  revision: 5,
  affectedPersonIds: ['person-kevin'],
  affectedSalesCycleIds: ['cycle-kevin'],
};

function createApi(snapshots: ReviewSnapshot[]) {
  const remaining = [...snapshots];
  return {
    list: vi.fn(async (): Promise<ReviewSnapshot> => {
      const next = remaining.length > 1 ? remaining.shift()! : remaining[0]!;
      return next;
    }),
    resolve: vi.fn(async (): Promise<MutationReceipt> => receipt),
  };
}

async function renderRoute(api: ReviewApi, overrides: {
  onOpenLead?: (personId: string) => void;
  onReviewSnapshot?: (snapshot: ReviewSnapshot, token: symbol) => void;
  onReviewRequestStart?: () => symbol;
  onReviewRequestFailed?: (token: symbol) => void;
} = {}) {
  const onOpenLead = overrides.onOpenLead ?? vi.fn();
  const onReviewSnapshot = overrides.onReviewSnapshot ?? vi.fn();
  const onReviewRequestStart = overrides.onReviewRequestStart ?? vi.fn(() => Symbol());
  const onReviewRequestFailed = overrides.onReviewRequestFailed ?? vi.fn();
  await act(async () => {
    render(
      <ReviewRoute
        api={api}
        onOpenLead={onOpenLead}
        onReviewRequestStart={onReviewRequestStart}
        onReviewRequestFailed={onReviewRequestFailed}
        onReviewSnapshot={onReviewSnapshot}
        onReviewResolved={vi.fn()}
      />,
    );
  });
  return { onOpenLead, onReviewSnapshot, onReviewRequestStart, onReviewRequestFailed };
}

describe('ReviewRoute', () => {
  it('fetches the snapshot and reports the open count to the shell', async () => {
    const api = createApi([openSnapshot]);
    const onReviewSnapshot = vi.fn();

    await renderRoute(api, { onReviewSnapshot });

    expect(api.list).toHaveBeenCalledWith({ kinds: ['unmatched_communication'], cursor: null, limit: 200 });
    expect(onReviewSnapshot).toHaveBeenCalledWith(openSnapshot, expect.any(Symbol));
    expect(screen.getByRole('tab', { name: /Unmatched communications 1/ })).toBeTruthy();
  });

  it('resolves an item, refetches, and reports the new count', async () => {
    const api = createApi([openSnapshot, emptySnapshot]);
    const onReviewSnapshot = vi.fn();
    await renderRoute(api, { onReviewSnapshot });

    fireEvent.click(screen.getByRole('button', { name: /\+14015550100/ }));
    fireEvent.change(screen.getByLabelText('Matched source event ID'), { target: { value: 'source-9' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Promote' }));
    });

    expect(api.resolve).toHaveBeenCalledWith({
      kind: 'unmatched_communication',
      reviewId: 'review-unmatched',
      expectedVersion: 1,
      action: 'promote',
      personId: null,
      sourceEventId: 'source-9',
    });
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(onReviewSnapshot).toHaveBeenLastCalledWith(emptySnapshot, expect.any(Symbol));
  });

  it('does not send unavailable privacy commands to the API', async () => {
    const api = createApi([openSnapshot]);
    await renderRoute(api);
    fireEvent.click(screen.getByRole('button', { name: /\+14015550100/ }));
    const personal = screen.queryByRole('button', { name: /Mark personal/ });
    await act(async () => { if (personal) fireEvent.click(personal); });
    expect(api.resolve).not.toHaveBeenCalled();
    expect(personal === null || (personal as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Never Record has not been applied/)).toBeTruthy();
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it('surfaces a resolution failure without hiding the queue', async () => {
    const api = createApi([openSnapshot]);
    api.resolve.mockRejectedValueOnce(new Error('stale'));
    await renderRoute(api);

    fireEvent.click(screen.getByRole('button', { name: /\+14015550100/ }));
    fireEvent.change(screen.getByLabelText('Matched source event ID'), { target: { value: 'source-9' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Promote' }));
    });

    expect(screen.getByRole('alert').textContent).toMatch(/could not be resolved/i);
    expect(screen.getByRole('tab', { name: /Unmatched communications 1/ })).toBeTruthy();
  });

  it('shows a retryable error state when the snapshot cannot load', async () => {
    const api = createApi([openSnapshot]);
    api.list.mockRejectedValueOnce(new Error('boom'));

    await renderRoute(api);

    expect(screen.getByRole('alert').textContent).toMatch(/could not load/i);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });
    expect(screen.getByRole('tab', { name: /Unmatched communications 1/ })).toBeTruthy();
  });

  it('forwards lead opening from explicitly synthetic unsupported-kind detail evidence', () => {
    const onOpenLead = vi.fn();
    render(<ReviewDetailPanel item={{
      kind: 'ambiguous_identity', reviewId: 'synthetic-ambiguous',
      candidatePersonIds: ['person-kevin', 'person-kevin-2'], summary: 'Two people match this inbound reply.',
    }} onOpenLead={onOpenLead} onResolve={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open person-kevin' }));
    expect(onOpenLead).toHaveBeenCalledWith('person-kevin');
  });
});

type ReliabilityRead = Parameters<ReviewApi['list']>[0] & { cursor?: string | null };

function reliabilityUnmatchedRows(start: number, count: number): ReviewItem[] {
  return Array.from({ length: count }, (_, offset) => ({
    kind: 'unmatched_communication', reviewId: `reliability-${start + offset}`,
    channel: 'email', handle: `review-${start + offset}@example.com`,
    occurredAt: '2026-09-10T00:00:00.000Z', summary: `Fictional review ${start + offset}`,
  }));
}

function reliabilityRouteSnapshot(items: ReviewItem[], nextCursor: string | null,
  counts = { unmatched: 208, system: 0, matched: 208 }): ReviewSnapshot {
  return {
    items, totalOpenCount: counts.unmatched + counts.system, revision: 10,
    nextCursor, matchedCount: counts.matched,
    countScope: 'lifecycle_review_items' as const, observedAt: '2026-09-10T00:00:00.000Z',
    queues: {
      unmatched_communication: { source: 'lifecycle_review_items' as const, openCount: counts.unmatched },
      system_error: { source: 'lifecycle_review_items' as const, openCount: counts.system },
      ambiguous_identity: { source: 'not_integrated' as const, openCount: null },
      transcript_suggestion: { source: 'not_integrated' as const, openCount: null },
      import_problem: { source: 'not_integrated' as const, openCount: null },
      adapter_failure: { source: 'not_integrated' as const, openCount: null },
    },
  };
}

function reliabilityDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe('reliability: actual Inbox route continuation', () => {
  it('requests the selected source kind and reports the complete observed snapshot', async () => {
    const first = reliabilityRouteSnapshot(reliabilityUnmatchedRows(0, 200), 'page-two');
    const api = createApi([first]);
    const accept = vi.fn();
    await renderRoute(api, { onReviewSnapshot: accept });
    expect(api.list).toHaveBeenCalledWith({ kinds: ['unmatched_communication'], cursor: null, limit: 200 });
    expect(accept).toHaveBeenLastCalledWith(first, expect.any(Symbol));
    expect(screen.getByRole('tab', { name: /Unmatched communications/ }).textContent).toMatch(/\b208\b/);
  });

  it('appends the final eight reviews without hiding earlier records or duplicating identity', async () => {
    const api = createApi([
      reliabilityRouteSnapshot(reliabilityUnmatchedRows(0, 200), 'page-two'),
      reliabilityRouteSnapshot(reliabilityUnmatchedRows(200, 8), null),
    ]);
    await renderRoute(api);
    const more = screen.queryByRole('button', { name: /^Load more/i });
    expect(more).not.toBeNull();
    await act(async () => { fireEvent.click(more!); });
    expect(api.list).toHaveBeenLastCalledWith({ kinds: ['unmatched_communication'], cursor: 'page-two', limit: 200 });
    const queue = screen.getByRole('list', { name: /Unmatched communications/ });
    expect(within(queue).getAllByRole('listitem')).toHaveLength(208);
    expect(within(queue).getAllByRole('button', { name: /review-0@example\.com/ })).toHaveLength(1);
    expect(within(queue).getAllByRole('button', { name: /review-207@example\.com/ })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /^Load more/i })).toBeNull();
    expect(api.resolve).not.toHaveBeenCalled();
  });

  it('retains already loaded rows on append failure and retries only the same continuation', async () => {
    const first = reliabilityRouteSnapshot(reliabilityUnmatchedRows(0, 200), 'page-two');
    const last = reliabilityRouteSnapshot(reliabilityUnmatchedRows(200, 8), null);
    const api = createApi([first]);
    api.list.mockResolvedValueOnce(first)
      .mockRejectedValueOnce(new Error('private path /workspace/secret.sqlite'))
      .mockResolvedValueOnce(last);
    await renderRoute(api);
    const more = screen.queryByRole('button', { name: /^Load more/i });
    expect(more).not.toBeNull();
    await act(async () => { fireEvent.click(more!); });
    expect(within(screen.getByRole('list', { name: /Unmatched communications/ }))
      .getAllByRole('listitem')).toHaveLength(200);
    expect(screen.queryByText(/secret\.sqlite/)).toBeNull();
    const retry = screen.queryByRole('button', { name: /Retry more/i });
    expect(retry).not.toBeNull();
    expect(screen.queryByRole('button', { name: /Refresh list/i })).not.toBeNull();
    await act(async () => { fireEvent.click(retry!); });
    expect(api.list).toHaveBeenLastCalledWith({ kinds: ['unmatched_communication'], cursor: 'page-two', limit: 200 });
    expect(within(screen.getByRole('list', { name: /Unmatched communications/ }))
      .getAllByRole('listitem')).toHaveLength(208);
  });

  it('ignores an old system-tab response after the user returns to unmatched reviews', async () => {
    const first = reliabilityRouteSnapshot(reliabilityUnmatchedRows(0, 1), null,
      { unmatched: 1, system: 3, matched: 1 });
    const stale = reliabilityDeferred<ReturnType<typeof reliabilityRouteSnapshot>>();
    const list = vi.fn(async (request: ReliabilityRead) => {
      if (request.kinds.includes('system_error')) return stale.promise;
      return first;
    });
    const api = { list, resolve: vi.fn(async () => receipt) };
    await renderRoute(api);
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /System errors/ })); });
    expect(list).toHaveBeenLastCalledWith({ kinds: ['system_error'], cursor: null, limit: 200 });
    // Tab controls must remain usable while this kind is loading.
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /Unmatched communications/ })); });
    await waitFor(() => expect(screen.getByRole('tab', { name: /Unmatched communications/ })
      .getAttribute('aria-selected')).toBe('true'));
    await act(async () => {
      stale.resolve(reliabilityRouteSnapshot([
        { kind: 'system_error', reviewId: 'stale-system', invariant: 'old', summary: 'STALE SYSTEM ROW', personId: null },
      ], null, { unmatched: 999, system: 1, matched: 1 }));
    });
    expect(screen.queryByText('STALE SYSTEM ROW')).toBeNull();
    expect(screen.getByRole('tab', { name: /Unmatched communications/ }).textContent).not.toMatch(/999/);
    expect(screen.getByRole('button', { name: /review-0@example\.com/ })).toBeTruthy();
    expect(api.resolve).not.toHaveBeenCalled();
  });
});

it('fences duplicate Load more invocations and discards their result after a tab switch', async () => {
  const first = reliabilityRouteSnapshot(reliabilityUnmatchedRows(0, 200), 'page-two');
  const pending = reliabilityDeferred<ReviewSnapshot>();
  const api = createApi([first]);
  api.list.mockResolvedValueOnce(first).mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce(reliabilityRouteSnapshot([], null, { unmatched: 208, system: 0, matched: 0 }));
  await renderRoute(api);
  const more = screen.getByRole('button', { name: 'Load more' });
  await act(async () => { fireEvent.click(more); fireEvent.click(more); });
  expect(api.list).toHaveBeenCalledTimes(2);
  await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /System errors/ })); });
  await act(async () => { pending.resolve(reliabilityRouteSnapshot(reliabilityUnmatchedRows(200, 8), null)); });
  expect(screen.queryByRole('button', { name: /review-207@example.com/ })).toBeNull();
  expect(screen.getByRole('tab', { name: /System errors/ }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('status').textContent).toContain('Showing 0 of 0');
});

it('retains the keyboard tab target while its selected queue loads and settles', async () => {
  const pending = reliabilityDeferred<ReviewSnapshot>();
  const api = createApi([openSnapshot]);
  api.list.mockResolvedValueOnce(openSnapshot).mockReturnValueOnce(pending.promise);
  await renderRoute(api);
  const unmatched = screen.getByRole('tab', { name: /Unmatched communications/ });
  unmatched.focus();
  await act(async () => { fireEvent.keyDown(unmatched, { key: 'ArrowLeft' }); });
  const system = screen.getByRole('tab', { name: /System errors/ });
  expect(document.activeElement).toBe(system);
  await act(async () => { pending.resolve(reliabilityRouteSnapshot([], null, { unmatched: 1, system: 0, matched: 0 })); });
  expect(screen.getByRole('tab', { name: /System errors/ })).toBe(system);
  expect(document.activeElement).toBe(system);
});


it('R2 allocates exact tokens before initial, append, retry and resolution reads', async () => {
  const first = reliabilityRouteSnapshot(reliabilityUnmatchedRows(0, 1), 'page-two', { unmatched: 2, system: 0, matched: 2 });
  const last = reliabilityRouteSnapshot(reliabilityUnmatchedRows(1, 1), null, { unmatched: 2, system: 0, matched: 2 });
  const events: string[] = [];
  const tokens: symbol[] = [];
  const onReviewRequestStart = vi.fn(() => {
    events.push('start'); const token = Symbol(); tokens.push(token); return token;
  });
  const onReviewSnapshot = vi.fn();
  const onReviewRequestFailed = vi.fn();
  const answers = [() => Promise.resolve(first), () => Promise.reject(new Error('PRIVATE_APPEND')), () => Promise.resolve(last), () => Promise.resolve(emptySnapshot)];
  const api = { list: vi.fn(() => { events.push('list'); return answers.shift()!(); }), resolve: vi.fn(async () => receipt) };
  await renderRoute(api, { onReviewRequestStart, onReviewSnapshot, onReviewRequestFailed });
  expect(events).toEqual(['start', 'list']);
  expect(onReviewSnapshot).toHaveBeenLastCalledWith(first, tokens[0]);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Load more' })); });
  expect(onReviewRequestFailed).toHaveBeenCalledWith(tokens[1]);
  expect(screen.queryByText('PRIVATE_APPEND')).toBeNull();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry more' })); });
  expect(onReviewSnapshot).toHaveBeenLastCalledWith(last, tokens[2]);
  fireEvent.click(screen.getByRole('button', { name: /review-0@example.com/ }));
  fireEvent.change(screen.getByLabelText('Matched source event ID'), { target: { value: 'source-token' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Promote' })); });
  expect(onReviewSnapshot).toHaveBeenLastCalledWith(emptySnapshot, tokens[3]);
  expect(events).toEqual(Array.from({ length: 4 }, () => ['start', 'list']).flat());
  expect(new Set(tokens).size).toBe(4);
  expect(onReviewRequestFailed).toHaveBeenCalledTimes(1);
});

it.each(['resolve', 'reject'] as const)('R2 obsolete route %s cannot publish its exact token', async outcome => {
  const stale = reliabilityDeferred<ReviewSnapshot>();
  const api = createApi([openSnapshot]);
  api.list.mockResolvedValueOnce(openSnapshot).mockReturnValueOnce(stale.promise).mockResolvedValueOnce(openSnapshot);
  const callbacks = await renderRoute(api);
  await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /System errors/ })); });
  await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /Unmatched communications/ })); });
  expect(callbacks.onReviewRequestStart).toHaveBeenCalledTimes(3);
  expect(callbacks.onReviewSnapshot).toHaveBeenCalledTimes(2);
  await act(async () => {
    if (outcome === 'resolve') stale.resolve(emptySnapshot);
    else stale.reject(new Error('PRIVATE_OBSOLETE'));
  });
  expect(callbacks.onReviewSnapshot).toHaveBeenCalledTimes(2);
  expect(callbacks.onReviewRequestFailed).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: /\+14015550100/ })).toBeTruthy();
  expect(screen.queryByText('PRIVATE_OBSOLETE')).toBeNull();
});
