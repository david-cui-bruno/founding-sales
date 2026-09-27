import { useEffect, useMemo, useRef } from 'react';
import type { OperationApi } from '../../shared/operations.ts';
import { importBridge } from '../app/bridges.ts';
import type { Generation } from '../app/generation.ts';
import { useViewState, type ViewState } from '../app/useViewState.ts';
import type {
  AddFirmDraft,
  CheckRouteRequest,
  ContactEdit,
  CrmState,
  EnrollRequest,
  MergeResolution,
  StageChange,
} from '../firmWorkspaceContract.ts';
import { routeShown, type Route } from '../routes.ts';

/**
 * The Firms view's reads and commands (1.0.13).
 *
 * The main process holds the screen — the board, a firm's page, the Add firm form, a
 * half-finished import, a merge waiting to be resolved — and every call answers the whole
 * of it. So this hook is `useViewState` plus two things only Firms needs.
 *
 * **The route follows the screen.** `firm/<id>` opens that firm; `firms` asks the bridge
 * what it is holding, and never shows a firm page under that name, because the sidebar's
 * Firms means the board. Opening a firm from the board stays in this view and the route
 * follows through `routeShown`, so nothing is mounted again and the sidebar stays true.
 *
 * **Choosing a file is not an operation.** It opens macOS's file panel, so it is a named
 * channel like dialling, and the CSV never crosses the bridge.
 */

export interface CrmActions {
  openFirm(firmId: string): void;
  openPipeline(): void;
  openAddFirm(): void;
  openImport(): void;
  /** macOS's file panel, then the server's preview of whatever it answered. */
  chooseImportFile(): void;
  addFirm(draft: AddFirmDraft): void;
  commitImport(): void;
  saveContact(edit: ContactEdit): void;
  changeStage(change: StageChange): void;
  resolveMerge(resolution: MergeResolution): void;
  openOpportunity(): void;
  enroll(request: EnrollRequest): void;
  checkRoute(request: CheckRouteRequest): void;
}

export interface Crm extends ViewState<CrmState> {
  readonly actions: CrmActions;
}

/** The route the state on screen is: one firm's, or the Firms view's. */
export function routeOfState(state: CrmState): Route {
  return state.screen === 'firm' && state.firm !== null ? { name: 'firm', firmId: state.firm.read.firm.id } : { name: 'firms' };
}

export function useCrm(
  route: Route,
  identity: string | null,
  generation: number,
  guard: Generation,
): Crm {
  const wanted = route.name === 'firm' ? route.firmId : null;
  const first = useMemo(
    () =>
      async (api: OperationApi): Promise<CrmState> => {
        if (wanted !== null) return await api.read('crm.openFirm', { firmId: wanted });
        // The sidebar's Firms is the board, or a capture screen the bridge is still
        // holding; a firm page it last showed is not what Firms means.
        const held = await api.read('crm.state', {});
        return held.screen === 'firm' ? await api.read('crm.openPipeline', {}) : held;
      },
    [wanted],
  );
  const view = useViewState<CrmState>({ key: 'crm', identity, generation, guard, first });

  const { read, command } = view;
  const actions = useMemo<CrmActions>(
    () => ({
      openFirm: firmId => {
        read(api => api.read('crm.openFirm', { firmId }));
      },
      openPipeline: () => {
        read(api => api.read('crm.openPipeline', {}));
      },
      openAddFirm: () => {
        read(api => api.read('crm.openAddFirm', {}));
      },
      openImport: () => {
        read(api => api.read('crm.openImport', {}));
      },
      chooseImportFile: () => {
        const bridge = importBridge();
        if (bridge === undefined) return;
        command('import', async () => await bridge.choose());
      },
      addFirm: draft => {
        command('add-firm', api => api.command('crm.addFirm', draft));
      },
      commitImport: () => {
        command('import', api => api.command('crm.commitImport', {}));
      },
      saveContact: edit => {
        command(`contact:${edit.contactId}`, api => api.command('crm.saveContact', edit));
      },
      changeStage: change => {
        command('stage', api => api.command('crm.changeStage', change));
      },
      resolveMerge: resolution => {
        command('merge', api => api.command('crm.resolveMerge', resolution));
      },
      openOpportunity: () => {
        command('opportunity', api => api.command('crm.openOpportunity', {}));
      },
      enroll: request => {
        command('enroll', api => api.command('crm.enroll', request));
      },
      checkRoute: request => {
        command(`route:${request.routeId}`, api => api.command('crm.checkRoute', request));
      },
    }),
    [read, command],
  );

  // The screen the bridge answered with is where the window is. The route follows it
  // rather than the other way round, and `routeShown` moves nothing and mounts nothing.
  const state = view.state;
  const shown = useRef<string | null>(null);
  useEffect(() => {
    if (state === null) return;
    const next = routeOfState(state);
    const text = next.name === 'firm' ? `firm/${next.firmId}` : 'firms';
    if (shown.current === text) return;
    shown.current = text;
    routeShown(next);
  }, [state]);

  return useMemo(() => ({ ...view, actions }), [view, actions]);
}
