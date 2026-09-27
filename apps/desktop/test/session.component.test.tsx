// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { useToday } from '../src/renderer/today/useToday.ts';
import type { OperationApi, OperationName } from '../src/shared/operations.ts';
import type { TodayState } from '../src/renderer/todayContract.ts';
import { todayState } from './e2e/support/homeFixtures.ts';

/**
 * A read in flight when the session changes (1.0.12).
 *
 * The main process tells the window that the person, the workspace or the role has
 * changed, or that this Mac's registration is over. Everything already on the wire was
 * asked for as somebody else, and this is the assertion that none of it lands: without
 * it, a `/today` read started before a sign-out repopulates the cache the shell has
 * just emptied, and the next person at this Mac reads the last one's list.
 */

const IDENTITY = 'workspace/device/salesperson';

interface Scripted {
  readonly api: OperationApi;
  /** Answer the operation that is waiting. */
  release(operation: OperationName, state: TodayState): void;
  readonly asked: OperationName[];
}

/** A registry whose reads never answer until the test says so. */
function scripted(): Scripted {
  const asked: OperationName[] = [];
  const waiting = new Map<OperationName, (state: TodayState) => void>();
  const answer = async (operation: OperationName): Promise<TodayState> => {
    asked.push(operation);
    return await new Promise<TodayState>(resolve => {
      waiting.set(operation, resolve);
    });
  };
  return {
    api: { read: answer, command: answer } as unknown as OperationApi,
    release: (operation, state) => {
      waiting.get(operation)?.(state);
      waiting.delete(operation);
    },
    asked,
  };
}

function Probe({ generation }: { readonly generation: number }): React.JSX.Element {
  const today = useToday(IDENTITY, generation, () => false);
  return (
    <>
      <span data-testid="cards">{today.state === null ? 'nothing' : String(today.state.cards.length)}</span>
      <button
        type="button"
        data-testid="refresh"
        onClick={() => {
          today.refresh();
        }}
      >
        Refresh
      </button>
    </>
  );
}

const client = (): QueryClient =>
  new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });

afterEach(() => {
  cleanup();
  globalThis.callieApi = undefined;
});

describe('a read that was in flight when the session changed', () => {
  it('is dropped rather than drawn, and rather than written to the cache', async () => {
    const api = scripted();
    globalThis.callieApi = api.api;
    const queries = client();
    const view = (generation: number): React.JSX.Element => (
      <QueryClientProvider client={queries}>
        <Probe generation={generation} />
      </QueryClientProvider>
    );
    const { rerender } = render(view(0));

    // The list this person had.
    await waitFor(() => {
      expect(api.asked).toContain('today.state');
    });
    api.release('today.state', todayState({ cards: [] }));
    await waitFor(() => {
      expect(screen.getByTestId('cards').textContent).toBe('0');
    });

    // A read starts…
    await userEvent.click(screen.getByTestId('refresh'));
    await waitFor(() => {
      expect(api.asked).toContain('today.refresh');
    });

    // …the session changes under it — the shell empties the cache and the number moves…
    queries.clear();
    rerender(view(1));
    await waitFor(() => {
      expect(screen.getByTestId('cards').textContent).toBe('nothing');
    });

    // …and only now does the answer to the earlier question arrive.
    api.release('today.refresh', todayState());
    await waitFor(() => {
      expect(api.asked.filter(operation => operation === 'today.state')).toHaveLength(2);
    });
    expect(screen.getByTestId('cards').textContent).toBe('nothing');
    // Nothing of the old session's is left under any key, either.
    const cached = JSON.stringify(queries.getQueryCache().getAll().map(query => query.state.data));
    expect(cached).not.toContain('Ashgrove Test Partners');
  });
});
