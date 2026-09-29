import { useEffect, useMemo, useRef, useState } from 'react';
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
 * The CRM view's reads and commands: Pipeline, Firms and a firm's page (1.0.14).
 *
 * The main process holds the screen — the board, a firm's page, the Add firm form, a
 * half-finished import, a merge waiting to be resolved — and every call answers the whole
 * of it. So this hook is `useViewState` plus three things only this view needs.
 *
 * **The route follows the screen.** `firm/<id>` opens that firm; `pipeline` and `firms`
 * ask the bridge what it is holding, and never show a firm page under either name.
 * Opening a firm from the board or from the list stays in this view and the route follows
 * through `routeShown`, so nothing is mounted again and the sidebar stays true.
 *
 * **One board read serves both routes.** `POST /pipeline/board` answers with every active
 * firm — the ones in a stage, in their columns, and the ones with no open opportunity
 * beside them — so Pipeline and Firms are two readings of one answer rather than two
 * reads. `crm.openPipeline` is the name that answer has always had.
 *
 * **Where the person came from is remembered.** A firm page's way back says Pipeline when
 * the board sent them and Firms when the list did; a firm opened from a Today or reply
 * card was sent by neither, and its way back is Firms, which is where a firm page lives.
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
  /** The row a firm page's way back names: the board, or the list. */
  readonly origin: CrmRouteName;
}

/** The two sidebar rows this view answers for. A firm's page is under Firms. */
export type CrmRouteName = 'pipeline' | 'firms';

/**
 * The route the state on screen is.
 *
 * A firm page is its own route. Everything else — the board, the list, and the three
 * capture screens — is the row the person was already on, because the board answer is
 * the same answer on both and the bridge's screen cannot tell them apart. A capture
 * screen is Firms', which is where Add firm and Import are offered.
 */
export function routeOfState(state: CrmState, from: CrmRouteName): Route {
  if (state.screen === 'firm' && state.firm !== null) return { name: 'firm', firmId: state.firm.read.firm.id };
  return { name: state.screen === 'pipeline' ? from : 'firms' };
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
        // Pipeline and Firms are the board read, or a capture screen the bridge is still
        // holding; a firm page it last showed is not what either row means.
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
        // Per opportunity, not per board: changing one firm's stage must not disable
        // the control on every other column (P1-4).
        command(`stage:${change.opportunityId}`, api => api.command('crm.changeStage', change));
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

  // The row the person is on, kept across the firm page they open from it. A firm
  // reached from a Today or reply card was sent by neither row, and Firms is where a
  // firm page lives, so that is what its way back says.
  const [from, setFrom] = useState<CrmRouteName>(route.name === 'pipeline' ? 'pipeline' : 'firms');
  useEffect(() => {
    if (route.name === 'pipeline' || route.name === 'firms') setFrom(route.name);
  }, [route.name]);

  // The screen the bridge answered with is where the window is. The route follows it
  // rather than the other way round, and `routeShown` moves nothing and mounts nothing.
  const state = view.state;
  const shown = useRef<string | null>(null);
  useEffect(() => {
    if (state === null) return;
    const next = routeOfState(state, from);
    const text = next.name === 'firm' ? `firm/${next.firmId}` : next.name;
    if (shown.current === text) return;
    shown.current = text;
    routeShown(next);
  }, [state, from]);

  return useMemo(() => ({ ...view, actions, origin: from }), [view, actions, from]);
}
