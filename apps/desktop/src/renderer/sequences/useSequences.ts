import { useMemo } from 'react';
import type { OperationApi } from '../../shared/operations.ts';
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
  saveSteps(input: { readonly sequenceVersionId: string; readonly steps: readonly DraftStep[] }): void;
  saveTemplate(draft: TemplateDraft): void;
  publish(sequenceVersionId: string): void;
  retire(sequenceVersionId: string): void;
}

export interface Sequences extends ViewState<SequenceState> {
  readonly actions: SequenceActions;
}

const first = async (api: OperationApi): Promise<SequenceState> => await api.read('sequences.state', {});

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
        command(api => api.command('sequences.createSequence', { name }));
      },
      saveSteps: input => {
        command(api => api.command('sequences.saveSteps', { sequenceVersionId: input.sequenceVersionId, steps: [...input.steps] }));
      },
      saveTemplate: draft => {
        command(api => api.command('sequences.saveTemplate', draft));
      },
      publish: sequenceVersionId => {
        command(api => api.command('sequences.publish', { sequenceVersionId }));
      },
      retire: sequenceVersionId => {
        command(api => api.command('sequences.retire', { sequenceVersionId }));
      },
    }),
    [read, command],
  );

  return useMemo(() => ({ ...view, actions }), [view, actions]);
}
