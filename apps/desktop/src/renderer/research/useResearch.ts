import { useMemo } from 'react';
import type { OperationApi } from '../../shared/operations.ts';
import type { Generation } from '../app/generation.ts';
import { useViewState, type ViewState } from '../app/useViewState.ts';
import type { ResearchSettingsEdit, ResearchState } from '../researchContract.ts';

/**
 * Research's reads and commands (lane R).
 *
 * `useViewState`, exactly as Firms, Sequences and Settings use it: the main process
 * holds the state, every call answers the whole of it, and there is no local model to
 * go stale. Nothing it holds reaches the disk — TanStack Query has no persister here,
 * and a brief quotes a firm's pages and names a person at it.
 *
 * Three places mount it and each one passes the firm it is about. The Today card and
 * the firm page are the same firm; Settings passes null and reads only the ceilings.
 */

export interface ResearchActions {
  open(firmId: string): void;
  run(firmId: string): void;
  addLink(input: { readonly firmId: string; readonly url: string }): void;
  saveSettings(edit: ResearchSettingsEdit): void;
  busy(form: string): boolean;
}

export interface Research extends ViewState<ResearchState> {
  readonly actions: ResearchActions;
}

/** What counts as one form: the smallest thing somebody presses. */
export const researchForm = {
  run: (firmId: string): string => `research-run:${firmId}`,
  link: (firmId: string): string => `research-link:${firmId}`,
  settings: 'research-settings',
} as const;

export function useResearch(options: {
  /** The firm to read, or null in Settings, where only the ceilings matter. */
  readonly firmId: string | null;
  readonly identity: string | null;
  readonly generation: number;
  readonly guard: Generation;
}): Research {
  const { firmId, identity, generation, guard } = options;
  const first = useMemo(
    () =>
      async (api: OperationApi): Promise<ResearchState> =>
        firmId === null
          ? // `{}` reads the settings through the admin-only command path; a
            // salesperson is answered with `settings: null` rather than a refusal.
            await api.command('research.saveSettings', {})
          : await api.read('research.open', { firmId }),
    [firmId],
  );
  const view = useViewState<ResearchState>({ key: `research:${firmId ?? 'settings'}`, identity, generation, guard, first });

  const actions = useMemo<ResearchActions>(
    () => ({
      open: id => {
        view.read(async api => await api.read('research.open', { firmId: id }));
      },
      run: id => {
        view.command(researchForm.run(id), async api => await api.command('research.run', { firmId: id }));
      },
      addLink: input => {
        view.command(
          researchForm.link(input.firmId),
          async api => await api.command('research.addLink', { firmId: input.firmId, url: input.url }),
        );
      },
      saveSettings: edit => {
        view.command(researchForm.settings, async api => await api.command('research.saveSettings', edit));
      },
      busy: view.busy,
    }),
    [view],
  );

  return useMemo(() => ({ ...view, actions }), [view, actions]);
}
