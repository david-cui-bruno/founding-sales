// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MutationReceipt } from '../../../shared/contracts/commonContract';
import {
  reviewSnapshotSchema,
  type ReviewSnapshot,
} from '../../../shared/contracts/reviewContract';
import { ReviewRoute, type ReviewApi } from './ReviewRoute';

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
  revision: 4,
});

const emptySnapshot: ReviewSnapshot = reviewSnapshotSchema.parse({
  items: [],
  totalOpenCount: 0,
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
  onOpenCountChange?: (count: number) => void;
} = {}) {
  const onOpenLead = overrides.onOpenLead ?? vi.fn();
  const onOpenCountChange = overrides.onOpenCountChange ?? vi.fn();
  await act(async () => {
    render(
      <ReviewRoute
        api={api}
        onOpenLead={onOpenLead}
        onOpenCountChange={onOpenCountChange}
      />,
    );
  });
  return { onOpenLead, onOpenCountChange };
}

describe('ReviewRoute', () => {
  it('fetches the snapshot and reports the open count to the shell', async () => {
    const api = createApi([openSnapshot]);
    const onOpenCountChange = vi.fn();

    await renderRoute(api, { onOpenCountChange });

    expect(api.list).toHaveBeenCalledWith({ kinds: [], limit: 200 });
    expect(onOpenCountChange).toHaveBeenCalledWith(1);
    expect(screen.getByRole('tab', { name: /Unmatched communications 1/ })).toBeTruthy();
  });

  it('resolves an item, refetches, and reports the new count', async () => {
    const api = createApi([openSnapshot, emptySnapshot]);
    const onOpenCountChange = vi.fn();
    await renderRoute(api, { onOpenCountChange });

    fireEvent.click(screen.getByRole('button', { name: /\+14015550100/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Mark personal/ }));
    });

    expect(api.resolve).toHaveBeenCalledWith({
      kind: 'unmatched_communication',
      reviewId: 'review-unmatched',
      expectedVersion: 1,
      action: 'mark_personal',
      personId: null,
      sourceEventId: null,
    });
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(onOpenCountChange).toHaveBeenLastCalledWith(0);
  });

  it('surfaces a resolution failure without hiding the queue', async () => {
    const api = createApi([openSnapshot]);
    api.resolve.mockRejectedValueOnce(new Error('stale'));
    await renderRoute(api);

    fireEvent.click(screen.getByRole('button', { name: /\+14015550100/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Mark personal/ }));
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

  it('forwards lead opening to the shell', async () => {
    const ambiguous = reviewSnapshotSchema.parse({
      items: [{
        kind: 'ambiguous_identity',
        reviewId: 'review-ambiguous',
        candidatePersonIds: ['person-kevin', 'person-kevin-2'],
        summary: 'Two people match this inbound reply.',
      }],
      totalOpenCount: 1,
      revision: 6,
    });
    const api = createApi([ambiguous]);
    const onOpenLead = vi.fn();
    await renderRoute(api, { onOpenLead });

    fireEvent.click(screen.getByRole('tab', { name: /Ambiguous identities/ }));
    fireEvent.click(screen.getByRole('button', { name: /Two people match/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Open person-kevin' }));

    expect(onOpenLead).toHaveBeenCalledWith('person-kevin');
  });
});
