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
  ResolveOutgoingRequest,
  StageChange,
  ValueChange,
} from '../firmWorkspaceContract.ts';
import { routeShown, routeText, type Route } from '../routes.ts';

/**
 * The CRM view's reads and commands: Pipeline, Firms and a firm's page (1.0.14).
 *
 * The main process holds the screen — the board, a firm's page, the Add firm form, a
 * half-finished import, a merge waiting to be resolved — and every call answers the whole
 * of it. So this hook is `useViewState` plus three things only this view needs.
 *
 * **The route follows the screen.** `firm/<id>` opens that firm; `pipeline` and `firms`
 * ask the bridge what it is holding. An explicit navigation opens their list; a reload
 * can restore the capture screen. Neither shows a firm page under the list's name.
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
  /** The firm's own page: the route follows to it. */
  openFirm(firmId: string): void;
  /**
   * The firm in the Pipeline's side panel (S4). The same read as `openFirm`, but the route
   * stays Pipeline and the board is not replaced: the bridge keeps the board beside the firm.
   */
  openPanel(firmId: string): void;
  openPipeline(includeLost?: boolean): void;
  openAddFirm(): void;
  openImport(): void;
  /** macOS's file panel, then the server's preview of whatever it answered. */
  chooseImportFile(): void;
  addFirm(draft: AddFirmDraft, onAccepted?: () => void): void;
  commitImport(): void;
  saveContact(edit: ContactEdit): void;
  /** `onAnswer` hears THIS command's own answer, even when the view drops it for a newer one. */
  changeStage(change: StageChange, onAnswer?: (notice: string | null) => void): void;
  /** A person records an opportunity's monthly value (slice K). */
  setValue(change: ValueChange, onAnswer?: (notice: string | null) => void): void;
  resolveMerge(resolution: MergeResolution): void;
  openOpportunity(): void;
  /**
   * Lane M1: open a firm's deal at a named stage (the "Move to Demo booked" suggestion), for
   * the firm the suggestion was drawn for (review M1R, finding 2).
   */
  openOpportunityAt(firmId: string, stageKey: string): void;
  /** The explicit takeover (P1-1): manual mode with the origin only a person writes. */
  takeOver(reason: string): void;
  /** Name the firm of one held outgoing message (send-path v2, S1 review P1-C). */
  resolveOutgoing(request: ResolveOutgoingRequest): void;
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
export function routeOfState(state: CrmState, from: CrmRouteName, panel = false): Route {
  // The Pipeline's side panel is a firm read that must not move the route (S4).
  if (state.screen === 'firm' && state.firm !== null && panel) return { name: from };
  if (state.screen === 'firm' && state.firm !== null) return { name: 'firm', firmId: state.firm.read.firm.id };
  return { name: state.screen === 'pipeline' ? from : 'firms' };
}

export function useCrm(
  route: Route,
  identity: string | null,
  generation: number,
  guard: Generation,
  /** The firm the Pipeline's panel is open on, read when the view is first drawn (S4). */
  panelFirm: () => string | null = () => null,
  /** Sidebar/menu navigation asks for the list; reloading may restore a capture screen. */
  enterAtRoot = false,
): Crm {
  const wanted = route.name === 'firm' ? route.firmId : null;
  const panelRef = useRef(panelFirm);
  panelRef.current = panelFirm;
  /** Whether the firm on screen was asked for as a full page (true) or for the panel. */
  const [fullPage, setFullPage] = useState(route.name === 'firm');
  const first = useMemo(
    () =>
      async (api: OperationApi): Promise<CrmState> => {
        if (wanted !== null) return await api.read('crm.openFirm', { firmId: wanted });
        // The main process remembers capture screens too. Clicking Firms or Pipeline
        // must leave those screens, rather than reopening Import forever. A reload can
        // still restore a half-finished capture without silently discarding it.
        const held = await api.read('crm.state', {});
        const board = enterAtRoot || held.screen === 'firm'
          ? await api.read('crm.openPipeline', {})
          : held;
        // A panel left open when the view was last left is read again, so it shows the
        // firm as it is now, beside the board (UI criterion 7).
        const panel = route.name === 'pipeline' ? panelRef.current() : null;
        if (panel !== null && board.screen === 'pipeline' && board.pipeline !== null) {
          return await api.read('crm.openFirm', { firmId: panel });
        }
        return board;
      },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wanted, enterAtRoot],
  );
  const view = useViewState<CrmState>({ key: 'crm', identity, generation, guard, first });

  const { read, command } = view;
  const actions = useMemo<CrmActions>(
    () => ({
      openFirm: firmId => {
        setFullPage(true);
        read(api => api.read('crm.openFirm', { firmId }));
      },
      openPanel: firmId => {
        setFullPage(false);
        read(api => api.read('crm.openFirm', { firmId }));
      },
      openPipeline: includeLost => {
        setFullPage(false);
        // `onClick={openPipeline}` hands over the event; only a real boolean is a filter.
        read(api => api.read('crm.openPipeline', typeof includeLost === 'boolean' ? { includeLost } : {}));
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
      addFirm: (draft, onAccepted) => {
        command('add-firm', async api => {
          const answer = await api.command('crm.addFirm', draft);
          if (answer.notice === 'firm_added') onAccepted?.();
          return answer;
        });
      },
      commitImport: () => {
        command('import', api => api.command('crm.commitImport', {}));
      },
      saveContact: edit => {
        command(`contact:${edit.contactId}`, api => api.command('crm.saveContact', edit));
      },
      changeStage: (change, onAnswer) => {
        // Per opportunity, not per board: changing one firm's stage must not disable
        // the control on every other column (P1-4).
        command(`stage:${change.opportunityId}`, async api => {
          const answer = await api.command('crm.changeStage', change);
          onAnswer?.(answer.notice);
          return answer;
        });
      },
      setValue: (change, onAnswer) => {
        command(`value:${change.opportunityId}`, async api => {
          const answer = await api.command('crm.setValue', change);
          onAnswer?.(answer.notice);
          return answer;
        });
      },
      resolveMerge: resolution => {
        command('merge', api => api.command('crm.resolveMerge', resolution));
      },
      openOpportunity: () => {
        command('opportunity', api => api.command('crm.openOpportunity', {}));
      },
      openOpportunityAt: (firmId, stageKey) => {
        command('opportunity', api => api.command('crm.openOpportunity', { firmId, stageKey }));
      },
      takeOver: reason => {
        command('take-over', api => api.command('crm.takeOver', { reason }));
      },
      resolveOutgoing: request => {
        command(`outgoing:${request.messageId}`, api => api.command('crm.resolveOutgoing', request));
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
    const shownRoute = routeOfState(state, from, route.name === 'pipeline' && !fullPage);
    const next: Route = shownRoute.name === 'firm' && route.name === 'firm' && shownRoute.firmId === route.firmId && route.meetingId !== undefined
      ? { ...shownRoute, meetingId: route.meetingId } : shownRoute;
    const text = routeText(next);
    if (shown.current === text) return;
    shown.current = text;
    routeShown(next);
  }, [state, from, route, fullPage]);

  return useMemo(() => ({ ...view, actions, origin: from }), [view, actions, from]);
}
