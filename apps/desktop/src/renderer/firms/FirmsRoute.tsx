import {BookingCapacity} from '../meetings/BookingCapacity.tsx';
import {bookingCapacityPorts} from '../meetings/bookingCapacityPorts.ts';
import {FirmQualification} from '../sourcing/FirmQualification.tsx';
import { Candidates } from '../sourcing/Candidates.tsx';
import { useKept } from '../replies/kept.ts';
import { useEffect, useLayoutEffect, useRef, type JSX } from 'react';
import { ChevronLeft } from 'lucide-react';
import type { Generation } from '../app/generation.ts';
import { inWords } from '../dates.ts';
import { navigate, type Route } from '../routes.ts';
import { Button } from '../ui/button.tsx';
import { Banners, Page, ViewHeader } from '../ui/layout.tsx';
import { Skeleton } from '../v2/parts.tsx';
import { useShortcuts } from '../v2/shortcuts.ts';
import { AddFirmForm } from './AddFirmForm.tsx';
import { FirmMerge } from './FirmMerge.tsx';
import { FirmPage } from './FirmPage.tsx';
import { FirmsList, firmsOf } from './FirmsList.tsx';
import { ImportScreen } from './ImportScreen.tsx';
import { BriefImport } from './BriefImport.tsx';
import { PipelineBoard } from './PipelineBoard.tsx';
import { clearKeptText, nextCommandId, useCrmMemory, type CardEditor } from './crmMemory.ts';
import { BookingsToMatch } from '../meetings/BookingsToMatch.tsx';
import { FirmPanel } from '../pipeline/FirmPanel.tsx';
import { FirmResearch } from '../research/FirmResearch.tsx';
import { PreparedBrief } from '../research/PreparedBrief.tsx';
import { buildFirmWorkspaceView, FIRMS_HEADING, noticeText, PIPELINE_HEADING } from '../firmWorkspaceView.ts';
import type { CrmState, StageChange, ValueChange } from '../firmWorkspaceContract.ts';
import { useCrm } from './useCrm.ts';

/**
 * Pipeline, Firms, one firm's page, Add firm, Import and the merge screen (1.0.14).
 *
 * One component shows all six, because they are one bridge state and moving between them
 * must not remount the view or re-read the board. Which of them is on screen is the route
 * and the bridge's screen together:
 *
 *   * `pipeline` — the board of opportunities being worked, with the per-stage counts on
 *     its column headings. Opening a card shows the firm in a **side panel** beside the
 *     board (S4), so the board keeps its place; "Open firm page" is the full page.
 *   * `firms` — every firm on file, cold ones included, and the place Add firm and Import
 *     are offered, because those two put a firm on file rather than into the pipeline.
 *   * `firm/<id>` — that firm, wherever it was opened from, with a way back that names the
 *     row that sent them.
 *
 * Every state change is "ask the bridge, render what came back". There is no local model
 * to go stale, no optimistic update to reconcile, and no way for the window to believe
 * something the API did not say — which is 14.2's "contains no authoritative sequence,
 * suppression, policy, eligibility, or send logic" made structural rather than promised.
 *
 * What is kept for the person (UI criterion 7) lives in `crmMemory.ts`, above this view:
 * the board's search and scroll, the open panel and its scroll, which editor is open on
 * which card, the firm page's scroll, and the text typed into any of them.
 */

/** The firm page's scroll is the shell column's; it is kept per firm and put back once drawn. */
function useColumnScroll(key: string | null, ready: boolean, offsets: Record<string, number | undefined>): void {
  useLayoutEffect(() => {
    if (key === null || !ready) return undefined;
    const column = document.querySelector<HTMLElement>('[data-region="column"]');
    if (column === null) return undefined;
    // The shell resets a new view to the top after the children's effects; one frame later is ours.
    const frame = requestAnimationFrame(() => {
      column.scrollTop = offsets[key] ?? 0;
    });
    const onScroll = (): void => {
      offsets[key] = column.scrollTop;
    };
    column.addEventListener('scroll', onScroll);
    return () => {
      cancelAnimationFrame(frame);
      column.removeEventListener('scroll', onScroll);
    };
  }, [key, ready, offsets]);
}

export function FirmsRoute({
  route,
  enterAtRoot = false,
  identity,
  generation,
  guard,
}: {
  readonly route: Route;
  /** Explicit navigation opens the requested list, even if a capture screen was left open. */
  readonly enterAtRoot?: boolean;
  readonly identity: string | null;
  readonly generation: number;
  readonly guard: Generation;
}): JSX.Element {
  const { memory, touch } = useCrmMemory(identity, generation);
  const crm = useCrm(route, identity, generation, guard, () => memory.panelFirmId, enterAtRoot);
  const state = crm.state;
  const [firmsTab, setFirmsTab] = useKept('firms:tab', 'firms');
  // Which row asked for this view. The board answer is the same answer on both, so the
  // route says which reading of it to draw.
  const onPipelineRow = route.name === 'pipeline';
  const rowHeading = onPipelineRow ? PIPELINE_HEADING : FIRMS_HEADING;
  const boardMemory = useRef(memory.board);
  boardMemory.current = memory.board;

  const panelFirmId = onPipelineRow ? memory.panelFirmId : null;

  // The panel's firm is read again whenever the board has been read (a command, Back from the
  // firm page, a Lost filter): the board read leaves the bridge's firm as it was. It is read
  // again as well when an OLDER read landed last and left another firm in the shared state
  // (rule K7): without this the selected panel would wait for an answer that already came.
  const attempts = useRef<{ readonly firm: string; count: number } | null>(null);
  useEffect(() => {
    if (state === null || crm.pending > 0 || panelFirmId === null || state.pipeline === null) return;
    const shownId = state.firm?.read.firm.id ?? null;
    if (state.screen === 'firm' && shownId === panelFirmId) {
      attempts.current = null;
      return;
    }
    const outcome = state.notice === null || state.notice === 'stage_changed' || state.notice === 'value_recorded';
    const stale = state.screen === 'firm' && shownId !== panelFirmId;
    if (!(stale || (state.screen === 'pipeline' && outcome))) return;
    // A read that keeps failing must not loop: three tries per selection, then Retry.
    const tries = attempts.current?.firm === panelFirmId ? attempts.current.count : 0;
    if (tries >= 3) return;
    attempts.current = { firm: panelFirmId, count: tries + 1 };
    crm.actions.openPanel(panelFirmId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, crm.pending, panelFirmId]);

  const hasEditors = Object.values(memory.cardEditor).some(editor => editor !== undefined);
  useShortcuts({
    close: () => {
      if (!onPipelineRow) return;
      if (hasEditors) {
        // Escape closes an editor and keeps its draft; it never discards (criterion 2).
        for (const opportunityId of Object.keys(memory.cardEditor)) touchPending(opportunityId);
        memory.cardEditor = {};
        touch();
      } else if (memory.panelFirmId !== null) {
        memory.panelFirmId = null;
        touch();
      }
    },
  });

  const onFirm = state !== null && state.screen === 'firm' && state.firm !== null && route.name === 'firm';
  const firmId = onFirm && state.firm !== null ? state.firm.read.firm.id : null;
  useColumnScroll(firmId, firmId !== null, memory.pageScroll);

  if (!crm.available) {
    return (
      <Page className="callie-v2">
        <ViewHeader title={rowHeading} />
        <p data-testid="firms-unavailable" className="mt-6 text-sm text-muted-foreground">
          Callie cannot reach the rest of the app from this window.
        </p>
      </Page>
    );
  }
  if (state === null) {
    // Loading: the shape of what is coming, so nothing jumps when it arrives.
    return onPipelineRow ? (
      <div data-testid="pipeline-loading" aria-busy="true" className="callie-v2 flex h-screen flex-col">
        <header data-testid="column-head" className="flex h-11 shrink-0 items-center border-b border-border px-5">
          <h1 data-testid="heading" className="text-sm font-semibold">
            {rowHeading}
          </h1>
        </header>
        <div className="flex min-h-0 flex-1 gap-3 overflow-hidden p-4">
          {[0, 1, 2, 3].map(column => (
            <div key={column} className="flex w-[248px] shrink-0 flex-col gap-2 rounded-lg bg-sidebar p-3">
              <Skeleton className="w-24" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ))}
        </div>
      </div>
    ) : (
      <Page className="callie-v2">
        <ViewHeader title={rowHeading} />
      </Page>
    );
  }

  const stageNames = new Map((state.pipeline?.stages ?? state.pipeline?.columns.map(column => column.stage) ?? []).map(stage => [stage.key, stage.displayName] as const));
  const stageName = (key: string): string => stageNames.get(key) ?? inWords(key);
  // On the board, a stage or value answer is said next to its card (criterion 6), so it is
  // not also a banner across the page. Offline and "update required" stay: they block everything.
  // Only while a card on screen actually shows it (rule K3): otherwise the notice is the
  // only place the answer is said, and it stays a banner.
  const onBoard = new Set(Object.values(state.pipeline?.opportunityIdByFirmId ?? {}));
  const cardShowsNotice =
    onPipelineRow &&
    state.notice !== null &&
    Object.entries(memory.feedback).some(([opportunityId, entry]) => entry?.code === state.notice && onBoard.has(opportunityId));
  const view = buildFirmWorkspaceView(cardShowsNotice ? { ...state, notice: null } : state);
  // Add firm and Import put a firm on file, so they belong to Firms and not to the board.
  const onFirmsList = state.screen === 'pipeline' && !onPipelineRow;
  const onCapture = state.screen === 'add_firm' || state.screen === 'import' || state.screen === 'merge';
  // A fresh route also fences late command answers from the screen being left.
  const backToFirms = (): void => navigate({ name: 'firms' });
  const cardOf = (id: string) => state.pipeline?.cards?.[id];

  /** David opened or closed this card's editor: a late answer must leave it alone. */
  function touchPending(opportunityId: string): void {
    const pending = memory.pending[opportunityId];
    if (pending === undefined) return;
    if (pending.submitClose) {
      pending.submitClose = false;
      return;
    }
    pending.touched = true;
  }

  /**
   * This command's own answer, whenever it arrives (K3). It is said beside its card, it
   * clears the draft when it went through, and when it was refused it brings the editor back
   * only if David has not touched that card's editor since he sent it.
   */
  const settle = (opportunityId: string, commandId: number, editor: CardEditor) => (notice: string | null): void => {
    const pending = memory.pending[opportunityId];
    if (pending?.commandId !== commandId) return;
    delete memory.pending[opportunityId];
    const code = notice ?? 'malformed_body';
    memory.feedback[opportunityId] = { code };
    if (code === 'stage_changed' || code === 'value_recorded') {
      clearKeptText(`${editor}:${opportunityId}`);
    } else if (!pending.touched && memory.cardEditor[opportunityId] === undefined) {
      memory.cardEditor[opportunityId] = editor;
    }
    touch();
  };
  const send = (opportunityId: string, editor: CardEditor, run: (onAnswer: (notice: string | null) => void) => void): void => {
    delete memory.feedback[opportunityId];
    const commandId = nextCommandId();
    memory.pending[opportunityId] = { editor, commandId, touched: false, submitClose: true };
    run(settle(opportunityId, commandId, editor));
    touch();
  };
  const changeStage = (change: StageChange): void => {
    send(change.opportunityId, 'move', onAnswer => {
      crm.actions.changeStage(change, onAnswer);
    });
  };
  const setValue = (change: ValueChange): void => {
    send(change.opportunityId, 'value', onAnswer => {
      crm.actions.setValue(change, onAnswer);
    });
  };

  const firmBody = (variant: 'page' | 'panel', firm: NonNullable<CrmState['firm']>): JSX.Element => (
    <FirmPage
      page={firm}
      {...(route.name === 'firm' && route.firmId === firm.read.firm.id && route.meetingId !== undefined ? { initialMeetingId: route.meetingId } : {})}
      sequences={state.sequences}
      actionsEnabled={view.actionsEnabled}
      busy={crm.busy}
      redactionNotice={view.redactionNotice}
      onSaveContact={crm.actions.saveContact}
      onCheckRoute={crm.actions.checkRoute}
      onOpenOpportunity={crm.actions.openOpportunity}
      onApplyStageSuggestion={(suggestion, suggestedFirmId) => {
        // Lane M1: the ordinary manual commands — a move of the open deal from the stage the
        // suggestion was read at, or opening one at the stage for the firm it was read for.
        if (suggestion.opportunityId !== null) {
          changeStage({
            opportunityId: suggestion.opportunityId,
            toStageKey: suggestion.stageKey,
            reason: null,
            ...(typeof suggestion.fromStageKey === 'string' ? { expectedStageKey: suggestion.fromStageKey } : {}),
          });
        } else crm.actions.openOpportunityAt(suggestedFirmId, suggestion.stageKey);
      }}
      onEnroll={crm.actions.enroll}
      onTakeOver={crm.actions.takeOver}
      heldOutgoing={state.heldOutgoing}
      notice={state.notice}
      onResolveOutgoing={crm.actions.resolveOutgoing}
      onBasicsSaved={() => {
        if (variant === 'page') crm.actions.openFirm(firm.read.firm.id);
        else crm.actions.openPanel(firm.read.firm.id);
      }}
      card={cardOf(firm.read.firm.id)}
      stageName={stageName}
      variant={variant}
      guard={guard}
      research={
        <>
          {/* Lane PB: the prepared brief, negotiated on the firm page read
              (`include: ['preparedBrief']`), beside Callie's own research. */}
          {state.role==='admin'?<FirmQualification key={`qualification:${firm.read.firm.id}`} firmId={firm.read.firm.id} enabled={view.actionsEnabled}/>:null}
          {firm.visibility === 'assigned_or_admin' && firm.preparedBrief != null ? (
            <div className="mb-4">
              <PreparedBrief key={firm.read.firm.id} brief={firm.preparedBrief} />
            </div>
          ) : null}
          {/* Its own read, because the firm page's contract is strict behind
              `pageVersion` and a key added to it is a wire break (lane R). */}
          <FirmResearch
            firmId={firm.read.firm.id}
            identity={identity}
            generation={generation}
            guard={guard}
            enabled={view.actionsEnabled}
          />
        </>
      }
    />
  );

  // ----- The Pipeline: the board, and beside it the open firm ---------------------------
  if (onPipelineRow && state.pipeline !== null && (state.screen === 'pipeline' || state.screen === 'firm')) {
    const shown = state.firm !== null && state.firm.read.firm.id === panelFirmId ? state.firm : null;
    const panelName =
      shown?.read.firm.name ??
      state.pipeline.columns.flatMap(column => column.firms).find(entry => entry.id === panelFirmId)?.name ??
      'Firm';
    return (
      <div data-testid="firms" aria-busy={crm.pending > 0} className="callie-v2 flex h-screen flex-col">
        <header data-testid="column-head" className="flex h-11 shrink-0 items-center gap-3 border-b border-border px-5">
          <h1 data-testid="heading" className="text-sm font-semibold">
            {rowHeading}
          </h1>
        </header>
        {view.banners.length === 0 ? null : (
          <div className="px-5">
            <Banners notices={view.banners} />
          </div>
        )}
        <div className="shrink-0 max-h-64 overflow-y-auto px-5"><BookingCapacity key={`booking:${identity}:${String(generation)}`} ports={bookingCapacityPorts} onOpenFirm={crm.actions.openFirm} /></div>
        {/* Slice M1: Cal.com bookings Callie could not attach to a firm. Nothing while there are none. */}
        <BookingsToMatch
          firms={firmsOf(state.pipeline)}
          actionsEnabled={view.actionsEnabled}
          onMatched={() => {
            crm.actions.openPipeline(state.pipeline?.includeLost === true);
          }}
        />
        <div className="flex min-h-0 flex-1">
          <PipelineBoard
            pipeline={state.pipeline}
            actionsEnabled={view.actionsEnabled}
            stageBusy={opportunityId => crm.busy(`stage:${opportunityId}`)}
            valueBusy={opportunityId => crm.busy(`value:${opportunityId}`)}
            search={memory.search}
            memory={boardMemory}
            onSearch={text => {
              memory.search = text;
              touch();
            }}
            onShowLost={crm.actions.openPipeline}
            onChangeStage={changeStage}
            onSetValue={setValue}
            onOpenFirm={id => {
              memory.panelScroll = id === memory.panelFirmId ? memory.panelScroll : 0;
              memory.panelFirmId = id;
              crm.actions.openPanel(id);
              touch();
            }}
            selectedFirmId={panelFirmId}
            cardEditors={memory.cardEditor}
            onCardEditor={(opportunityId, editor) => {
              touchPending(opportunityId);
              if (editor === null) delete memory.cardEditor[opportunityId];
              else memory.cardEditor[opportunityId] = editor;
              touch();
            }}
            feedback={memory.feedback}
            onlyWithoutValue={memory.onlyWithoutValue}
            onOnlyWithoutValue={on => {
              memory.onlyWithoutValue = on;
              touch();
            }}
          />
          {panelFirmId === null ? null : (
            <FirmPanel
              name={panelName}
              scroll={memory.panelScroll}
              onScroll={offset => {
                memory.panelScroll = offset;
              }}
              onOpenFull={() => {
                crm.actions.openFirm(panelFirmId);
              }}
              onClose={() => {
                memory.panelFirmId = null;
                touch();
              }}
            >
              {shown !== null ? (
                firmBody('panel', shown)
              ) : state.screen === 'pipeline' && state.notice !== null && crm.pending === 0 ? (
                <div data-testid="firm-panel-error" role="alert" className="flex items-center gap-2 text-sm text-muted-foreground">
                  <span>{noticeText(state.notice)}</span>
                  <Button
                    variant="quiet"
                    size="sm"
                    data-testid="firm-panel-retry"
                    onClick={() => {
                      crm.actions.openPanel(panelFirmId);
                    }}
                  >
                    Retry
                  </Button>
                </div>
              ) : (
                <div data-testid="firm-panel-loading" aria-busy="true" className="flex flex-col gap-2">
                  <Skeleton className="w-40" />
                  <Skeleton className="w-full" />
                  <Skeleton className="w-3/4" />
                </div>
              )}
            </FirmPanel>
          )}
        </div>
      </div>
    );
  }

  // ----- Everything else: Firms, the firm's page, Add firm, Import, merge ----------------
  const firmSummary =
    onFirm && state.firm !== null
      ? [state.firm.read.firm.locality, state.firm.read.firm.regionCode].filter(part => part !== null && part !== '').join(', ') || null
      : null;
  return (
    <Page
      data-testid="firms"
      aria-busy={crm.pending > 0}
      className={onFirm ? 'callie-v2 max-w-[1180px] px-10 pt-5' : 'callie-v2'}
    >
      <ViewHeader
        title={
          onFirm && state.firm !== null ? state.firm.read.firm.name : state.screen === 'pipeline' ? rowHeading : view.heading
        }
        summary={firmSummary}
        above={
          onFirm ? (
            <Button
              variant="quiet"
              size="sm"
              data-testid="back-to-pipeline"
              className="-ml-2 self-start"
              onClick={() => {
                crm.actions.openPipeline();
              }}
            >
              <ChevronLeft aria-hidden />
              {crm.origin === 'pipeline' ? PIPELINE_HEADING : FIRMS_HEADING}
            </Button>
          ) : onCapture ? (
            <Button variant="quiet" size="sm" className="-ml-2 self-start" onClick={backToFirms}>
              <ChevronLeft aria-hidden />
              Back to Firms
            </Button>
          ) : undefined
        }
        actions={
          onFirmsList ? (
            <div data-testid="crm-toolbar" className="flex items-center gap-1">
              <Button size="sm" data-testid="open-add-firm" disabled={!view.actionsEnabled} onClick={crm.actions.openAddFirm}>
                Add firm
              </Button>
              {/* 5.2: import is an administrator's command. A salesperson is not offered
                  the button, and the domain refuses them if they reach the screen anyway. */}
              {state.role === 'admin' ? (
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="open-import"
                  disabled={!view.actionsEnabled}
                  onClick={crm.actions.openImport}
                >
                  Import CSV
                </Button>
              ) : null}
            </div>
          ) : undefined
        }
      />
      <Banners notices={view.banners} />

      {onFirm && state.firm !== null ? (
        firmBody('page', state.firm)
      ) : state.screen === 'add_firm' && state.addFirm !== null ? (
        <AddFirmForm
          view={state.addFirm}
          actionsEnabled={view.actionsEnabled && !crm.busy('add-firm')}
          onSubmit={crm.actions.addFirm}
          onCancel={backToFirms}
          onOpenFirm={crm.actions.openFirm}
        />
      ) : state.screen === 'import' && state.import !== null ? (
        <>
          <ImportScreen
            view={state.import}
            actionsEnabled={view.actionsEnabled && state.role === 'admin' && !crm.busy('import')}
            onChooseFile={crm.actions.chooseImportFile}
            onCommit={crm.actions.commitImport}
            onDone={backToFirms}
          />
          {/* Lane PB: prepared briefs from a JSON file, an administrator's import too. */}
          {state.role === 'admin' ? <BriefImport enabled={view.actionsEnabled} /> : null}
        </>
      ) : state.screen === 'merge' && state.merge !== null ? (
        <FirmMerge
          merge={state.merge}
          // 7.2 and 5.2: a merge is an explicit audited command and an admin's. A
          // salesperson sees the conflicts and cannot commit the choice.
          actionsEnabled={view.actionsEnabled && state.role === 'admin' && !crm.busy('merge')}
          onResolve={crm.actions.resolveMerge}
        />
      ) : state.screen === 'pipeline' && state.pipeline !== null ? (
        <>
          {onFirmsList && state.role === 'admin' ? <div className="mb-5 flex gap-2" aria-label="Firms views"><Button size="sm" variant={firmsTab === 'firms' ? 'outline' : 'quiet'} aria-pressed={firmsTab === 'firms'} onClick={() => setFirmsTab('firms')}>All firms</Button><Button size="sm" variant={firmsTab === 'candidates' ? 'outline' : 'quiet'} aria-pressed={firmsTab === 'candidates'} onClick={() => setFirmsTab('candidates')}>Candidates</Button></div> : null}
          {onFirmsList && state.role === 'admin' && firmsTab === 'candidates' ? <Candidates enabled={view.actionsEnabled} /> : <FirmsList pipeline={state.pipeline} onOpenFirm={crm.actions.openFirm} />}
        </>
      ) : (
        // A screen with nothing in it is a state the main process should not produce, and
        // saying so is better than an empty page that looks like an empty pipeline.
        <p data-testid="nothing-to-show" className="mt-6 text-sm text-muted-foreground">
          There is nothing to show here yet.
        </p>
      )}
    </Page>
  );
}
