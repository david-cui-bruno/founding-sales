// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { useToday } from '../src/renderer/today/useToday.ts';
import { createGeneration, type Generation } from '../src/renderer/app/generation.ts';
import type { OperationApi, OperationName } from '../src/shared/operations.ts';
import type { TodayState } from '../src/renderer/todayContract.ts';
import { todayState } from './e2e/support/homeFixtures.ts';
import { adminState } from './e2e/support/adminFixtures.ts';
import { useHomeAdmin } from '../src/renderer/app/useHomeAdmin.ts';
import type { AdminState } from '../src/renderer/settingsContract.ts';

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

function Probe({ generation, guard }: { readonly generation: number; readonly guard: Generation }): React.JSX.Element {
  const today = useToday(IDENTITY, generation, guard, () => false);
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
    const guard = createGeneration();
    const view = (generation: number): React.JSX.Element => (
      <QueryClientProvider client={queries}>
        <Probe generation={generation} guard={guard.guard} />
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
    guard.note(1);
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

describe('the other two reads a window has in flight', () => {
  /*
   * Today was gated first; these are the rest of them. The delta review's point is that
   * one guarded write is not the rule — every write of something that was read has to
   * carry the number it was read under, or the last person's answer lands in the next
   * person's window through whichever path was forgotten.
   */

  it('drops the sidebar’s Refresh when the session changed while it was on the wire', async () => {
    const guard = createGeneration();
    const queries = client();
    const drawn: (string | null)[] = [];
    const gate: { release: (state: AdminState) => void } = { release: () => undefined };
    globalThis.callieAdmin = {
      state: async () => await Promise.resolve(adminState()),
      loadDashboard: async () => await Promise.resolve(adminState()),
      show: async () =>
        await new Promise<AdminState>(resolve => {
          gate.release = resolve;
        }),
    } as unknown as NonNullable<typeof globalThis.callieAdmin>;

    function Sidebar({ generation }: { readonly generation: number }): React.JSX.Element {
      const home = useHomeAdmin(IDENTITY, generation, guard.guard);
      drawn.push(home.admin?.notice ?? null);
      return (
        <button
          type="button"
          data-testid="refresh"
          onClick={() => {
            home.refresh();
          }}
        >
          Refresh
        </button>
      );
    }

    const view = (generation: number): React.JSX.Element => (
      <QueryClientProvider client={queries}>
        <Sidebar generation={generation} />
      </QueryClientProvider>
    );
    const { rerender } = render(view(0));
    await waitFor(() => {
      expect(drawn.at(-1)).toBeNull();
    });

    await userEvent.click(screen.getByTestId('refresh'));
    // The person changes while that read is on the wire…
    guard.note(1);
    queries.clear();
    rerender(view(1));
    // …and the answer to it carries something recognisable.
    gate.release(adminState({ notice: 'the last person’s status' }));

    await waitFor(() => {
      expect(drawn.length).toBeGreaterThan(2);
    });
    expect(drawn).not.toContain('the last person’s status');
    const cached = JSON.stringify(queries.getQueryCache().getAll().map(query => query.state.data));
    expect(cached).not.toContain('the last person’s status');
  });

  it('drops the mailbox row read across the same change', () => {
    // The same rule, taken from the file that owns it rather than re-implemented: a
    // write built before the transition does nothing after it.
    const source = createGeneration();
    const written: string[] = [];
    const keep = source.guard.keep<string>(value => written.push(value));

    keep('the address this person connected');
    expect(written).toEqual(['the address this person connected']);

    const late = source.guard.keep<string>(value => written.push(value));
    source.note(1);
    late('the address of somebody who has left');
    expect(written).toEqual(['the address this person connected']);
  });
});
