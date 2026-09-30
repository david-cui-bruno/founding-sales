import { useMemo } from 'react';
import type { OperationApi } from '../../shared/operations.ts';
import { operations } from '../app/bridges.ts';
import type { Generation } from '../app/generation.ts';
import { useViewState, type ViewState } from '../app/useViewState.ts';
import type { DraftStep, SequenceState, TemplateDraft } from '../sequenceContract.ts';

/**
 * The Sequences view's reads and commands (1.0.13).
 *
 * `useViewState` with the sequence operations named. Every call answers the whole state —
 * the sequences, the chosen one's versions, the templates — so a version published here
 * and a template approved there are one answer rather than three things to reconcile.
 */

export interface SequenceActions {
  refresh(): void;
  openSequence(sequenceId: string): void;
  createSequence(name: string): void;
  /**
   * Save, and say whether it was saved (PR 335 review, P1-4): true only when the answer
   * accepted the save. A refusal, an offline answer or a bridge fault is false, and the
   * editor keeps what was typed.
   */
  saveSteps(input: { readonly sequenceVersionId: string; readonly steps: readonly DraftStep[] }): Promise<boolean>;
  saveTemplate(draft: TemplateDraft): Promise<boolean>;
  publish(sequenceVersionId: string): void;
  retire(sequenceVersionId: string): void;
}

export interface Sequences extends ViewState<SequenceState> {
  readonly actions: SequenceActions;
}

const first = async (api: OperationApi): Promise<SequenceState> => await api.read('sequences.state', {});

/** The notices an accepted save answers with (`sequenceBridge.ts`); every other one is not a save. */
export function savedNotice(notice: string | null): boolean {
  return notice !== null && /^(steps_saved|template_saved)(_as_version:\d{1,4})?$/u.test(notice);
}

/**
 * A command whose outcome the caller waits for. `send` is handed `settled`, which wraps
 * the command's work so its answer still goes through `useViewState` (ordering, the
 * session guard, `busy`) and the promise settles with whether that answer accepted the
 * save. No bridge, a bridge fault or a refusal is false.
 */
type Settled = (next: (api: OperationApi) => Promise<SequenceState>) => (api: OperationApi) => Promise<SequenceState>;

function reported(send: (settled: Settled) => void): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    if (operations() === undefined) {
      resolve(false);
      return;
    }
    send(next => async api => {
      try {
        const answer = await next(api);
        resolve(savedNotice(answer.notice));
        return answer;
      } catch (error) {
        resolve(false);
        throw error;
      }
    });
  });
}

export function useSequences(identity: string | null, generation: number, guard: Generation): Sequences {
  const view = useViewState<SequenceState>({ key: 'sequences', identity, generation, guard, first });
  const { read, command } = view;

  const actions = useMemo<SequenceActions>(
    () => ({
      refresh: () => {
        read(api => api.read('sequences.state', {}));
      },
      openSequence: sequenceId => {
        read(api => api.read('sequences.openSequence', { sequenceId }));
      },
      createSequence: name => {
        command('new-sequence', api => api.command('sequences.createSequence', { name }));
      },
      saveSteps: async input =>
        await reported(settled => {
          command(
            `steps:${input.sequenceVersionId}`,
            settled(api =>
              api.command('sequences.saveSteps', { sequenceVersionId: input.sequenceVersionId, steps: [...input.steps] }),
            ),
          );
        }),
      saveTemplate: async draft =>
        await reported(settled => {
          command('template-form', settled(api => api.command('sequences.saveTemplate', draft)));
        }),
      publish: sequenceVersionId => {
        command(`version:${sequenceVersionId}`, api => api.command('sequences.publish', { sequenceVersionId }));
      },
      retire: sequenceVersionId => {
        command(`version:${sequenceVersionId}`, api => api.command('sequences.retire', { sequenceVersionId }));
      },
    }),
    [read, command],
  );

  return useMemo(() => ({ ...view, actions }), [view, actions]);
}
