// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { JSX } from 'react';
import { createGeneration } from '../src/renderer/app/generation.ts';
import { useViewState } from '../src/renderer/app/useViewState.ts';
import type { OperationApi } from '../src/shared/operations.ts';

/**
 * Which answer is drawn when two are in flight (1.0.13, P2).
 *
 * Every view's bridge answers with the whole view, so the last answer written *is* the
 * view. Since two forms may be saving at once (P1-4) the answers arrive in whatever
 * order the main process and the server produce them, and neither "last one wins" nor
 * "highest number wins" is right:
 *
 *   * a read asked for while a command was on the wire may have been served from before
 *     that command committed. Drawn afterwards, it takes the saved value off the screen
 *     a moment after the row accepted it — which is what this file's first case is;
 *   * a command's accepted answer is the state the main process holds having applied it,
 *     so it is drawn even when a read issued later has already landed.
 *
 * The two promises are resolved by hand here. An end-to-end harness answers every call
 * from one state at the moment the call arrives, so it cannot produce a read that is
 * older than a command issued before it — the case that matters is exactly the one a
 * real server produces and a fake one cannot.
 */

type State = { readonly zone: string };

interface Scripted {
  readonly api: OperationApi;
  /** Answer the call waiting under this name. */
  release(name: string, value: State): void;
  readonly asked: string[];
}

function scripted(): Scripted {
  const asked: string[] = [];
  const waiting = new Map<string, (value: State) => void>();
  const answer = async (operation: string): Promise<State> => {
    asked.push(operation);
    return await new Promise<State>(resolve => {
      waiting.set(operation, resolve);
    });
  };
  return {
    api: { read: answer, command: answer } as unknown as OperationApi,
    release: (name, value) => {
      waiting.get(name)?.(value);
      waiting.delete(name);
    },
    asked,
  };
}

function Probe(): JSX.Element {
  const guard = createGeneration().guard;
  const view = useViewState<State>({
    key: 'order',
    identity: 'somebody',
    generation: 0,
    guard,
    first: async api => await (api as unknown as { read(name: string): Promise<State> }).read('first'),
  });
  return (
    <>
      <span data-testid="zone">{view.state === null ? 'nothing' : view.state.zone}</span>
      <button
        type="button"
        data-testid="save"
        onClick={() => {
          view.command('setting:zone', async api => await (api as unknown as { command(n: string): Promise<State> }).command('save'));
        }}
      >
        Save
      </button>
      <button
        type="button"
        data-testid="history"
        onClick={() => {
          view.read(async api => await (api as unknown as { read(n: string): Promise<State> }).read('history'));
        }}
      >
        History
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

async function mounted(api: Scripted): Promise<void> {
  globalThis.callieApi = api.api;
  render(
    <QueryClientProvider client={client()}>
      <Probe />
    </QueryClientProvider>,
  );
  await waitFor(() => {
    expect(api.asked).toContain('first');
  });
  api.release('first', { zone: 'Chicago' });
  await waitFor(() => {
    expect(screen.getByTestId('zone').textContent).toBe('Chicago');
  });
}

describe('two answers in flight at once', () => {
  it('keeps the saved value when a read issued beside the save answers last', async () => {
    const api = scripted();
    await mounted(api);

    // The save goes first and the read is asked for while it is still on the wire, so
    // what the read carries is the state from before the save committed.
    await userEvent.click(screen.getByTestId('save'));
    await userEvent.click(screen.getByTestId('history'));
    expect(api.asked).toEqual(['first', 'save', 'history']);

    api.release('save', { zone: 'Denver' });
    await waitFor(() => {
      expect(screen.getByTestId('zone').textContent).toBe('Denver');
    });

    // The older state, arriving last. It is dropped: the person saved Denver.
    api.release('history', { zone: 'Chicago' });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(screen.getByTestId('zone').textContent).toBe('Denver');
  });

  it('draws a read asked for after the save answered', async () => {
    const api = scripted();
    await mounted(api);

    await userEvent.click(screen.getByTestId('save'));
    api.release('save', { zone: 'Denver' });
    await waitFor(() => {
      expect(screen.getByTestId('zone').textContent).toBe('Denver');
    });

    // Nothing is in flight now, so this one is current and is drawn.
    await userEvent.click(screen.getByTestId('history'));
    api.release('history', { zone: 'Phoenix' });
    await waitFor(() => {
      expect(screen.getByTestId('zone').textContent).toBe('Phoenix');
    });
  });

  it('keeps the newer command when an older one answers behind it', async () => {
    const api = scripted();
    await mounted(api);

    // Two saves at once, which is what P1-4 made possible.
    await userEvent.click(screen.getByTestId('save'));
    const first = 'save';
    api.release(first, { zone: 'Denver' });
    await waitFor(() => {
      expect(screen.getByTestId('zone').textContent).toBe('Denver');
    });
    await userEvent.click(screen.getByTestId('save'));
    api.release('save', { zone: 'Phoenix' });
    await waitFor(() => {
      expect(screen.getByTestId('zone').textContent).toBe('Phoenix');
    });
  });
});
