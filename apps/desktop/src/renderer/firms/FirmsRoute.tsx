import { useRef, useState, type JSX } from 'react';
import { ChevronLeft } from 'lucide-react';
import type { Generation } from '../app/generation.ts';
import type { Route } from '../routes.ts';
import { Button } from '../ui/button.tsx';
import { Banners, Page, ViewHeader } from '../ui/layout.tsx';
import { AddFirmForm } from './AddFirmForm.tsx';
import { FirmMerge } from './FirmMerge.tsx';
import { FirmPage } from './FirmPage.tsx';
import { FirmsList, firmsOf } from './FirmsList.tsx';
import { ImportScreen } from './ImportScreen.tsx';
import { emptyBoardMemory, PipelineBoard, type BoardMemory } from './PipelineBoard.tsx';
import { BookingsToMatch } from '../meetings/BookingsToMatch.tsx';
import { FirmResearch } from '../research/FirmResearch.tsx';
import { buildFirmWorkspaceView, FIRMS_HEADING, PIPELINE_HEADING } from '../firmWorkspaceView.ts';
import { useCrm } from './useCrm.ts';

/**
 * Pipeline, Firms, one firm's page, Add firm, Import and the merge screen (1.0.14).
 *
 * One component shows all six, because they are one bridge state and moving between them
 * must not remount the view or re-read the board. Which of them is on screen is the route
 * and the bridge's screen together:
 *
 *   * `pipeline` — the board of opportunities being worked, with the per-stage counts on
 *     its column headings. Firms with no open opportunity are not on it; they are in the
 *     list under Firms, which is the whole of the change 1.0.14 made here.
 *   * `firms` — every firm on file, cold ones included, and the place Add firm and Import
 *     are offered, because those two put a firm on file rather than into the pipeline.
 *   * `firm/<id>` — that firm, wherever it was opened from, with a way back that names the
 *     row that sent them: Pipeline from the board, Firms from the list or from a Today or
 *     reply card, which sent them from neither.
 *
 * Every state change is "ask the bridge, render what came back". There is no local model
 * to go stale, no optimistic update to reconcile, and no way for the window to believe
 * something the API did not say — which is 14.2's "contains no authoritative sequence,
 * suppression, policy, eligibility, or send logic" made structural rather than promised.
 */

export function FirmsRoute({
  route,
  identity,
  generation,
  guard,
}: {
  readonly route: Route;
  readonly identity: string | null;
  readonly generation: number;
  readonly guard: Generation;
}): JSX.Element {
  const crm = useCrm(route, identity, generation, guard);
  // The board's search and scroll outlive the firm page opened from it (slice K): this
  // component is not remounted between the two screens, so they are kept here.
  const [boardSearch, setBoardSearch] = useState('');
  const boardMemory = useRef<BoardMemory>(emptyBoardMemory());
  const state = crm.state;
  // Which row asked for this view. The board answer is the same answer on both, so the
  // route says which reading of it to draw.
  const onPipelineRow = route.name === 'pipeline';
  const rowHeading = onPipelineRow ? PIPELINE_HEADING : FIRMS_HEADING;

  if (!crm.available) {
    return (
      <Page>
        <ViewHeader title={rowHeading} />
        <p data-testid="firms-unavailable" className="mt-6 text-sm text-muted-foreground">
          Callie cannot reach the rest of the app from this window.
        </p>
      </Page>
    );
  }
  if (state === null) {
    return (
      <Page>
        <ViewHeader title={rowHeading} />
      </Page>
    );
  }

  const view = buildFirmWorkspaceView(state);
  const onFirm = state.screen === 'firm' && state.firm !== null;
  // Add firm and Import put a firm on file, so they belong to Firms and not to the board.
  const onFirmsList = state.screen === 'pipeline' && !onPipelineRow;

  return (
    <Page data-testid="firms" aria-busy={crm.pending > 0} className={onPipelineRow ? 'max-w-none' : undefined}>
      <ViewHeader
        title={
          onFirm && state.firm !== null ? state.firm.read.firm.name : state.screen === 'pipeline' ? rowHeading : view.heading
        }
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
        <>
        <FirmPage
          page={state.firm}
          sequences={state.sequences}
          actionsEnabled={view.actionsEnabled}
          busy={crm.busy}
          redactionNotice={view.redactionNotice}
          onSaveContact={crm.actions.saveContact}
          onCheckRoute={crm.actions.checkRoute}
          onOpenOpportunity={crm.actions.openOpportunity}
          onEnroll={crm.actions.enroll}
          onTakeOver={crm.actions.takeOver}
          heldOutgoing={state.heldOutgoing}
          notice={state.notice}
          onResolveOutgoing={crm.actions.resolveOutgoing}
          onBasicsSaved={() => {
            if (state.firm !== null) crm.actions.openFirm(state.firm.read.firm.id);
          }}
        />
        {/* Its own read, because the firm page's contract is strict behind
            `pageVersion` and a key added to it is a wire break (lane R). */}
        <FirmResearch
          firmId={state.firm.read.firm.id}
          identity={identity}
          generation={generation}
          guard={guard}
          enabled={view.actionsEnabled}
        />
        </>
      ) : state.screen === 'add_firm' && state.addFirm !== null ? (
        <AddFirmForm
          view={state.addFirm}
          actionsEnabled={view.actionsEnabled && !crm.busy('add-firm')}
          onSubmit={crm.actions.addFirm}
          onCancel={crm.actions.openPipeline}
          onOpenFirm={crm.actions.openFirm}
        />
      ) : state.screen === 'import' && state.import !== null ? (
        <ImportScreen
          view={state.import}
          actionsEnabled={view.actionsEnabled && state.role === 'admin' && !crm.busy('import')}
          onChooseFile={crm.actions.chooseImportFile}
          onCommit={crm.actions.commitImport}
          onDone={crm.actions.openPipeline}
        />
      ) : state.screen === 'merge' && state.merge !== null ? (
        <FirmMerge
          merge={state.merge}
          // 7.2 and 5.2: a merge is an explicit audited command and an admin's. A
          // salesperson sees the conflicts and cannot commit the choice.
          actionsEnabled={view.actionsEnabled && state.role === 'admin' && !crm.busy('merge')}
          onResolve={crm.actions.resolveMerge}
        />
      ) : state.screen === 'pipeline' && state.pipeline !== null ? (
        onPipelineRow ? (
          /* The board, and only the firms in a stage on it. Firms with no open
             opportunity have no column to be in and are under Firms instead, where
             a firm just added or imported is the first thing a person sees. */
          <>
            {/* Slice M1: Cal.com bookings Callie could not attach to a firm. Nothing while there are none. */}
            <BookingsToMatch
              firms={firmsOf(state.pipeline)}
              actionsEnabled={view.actionsEnabled}
              onMatched={() => {
                crm.actions.openPipeline(state.pipeline?.includeLost === true);
              }}
            />
            <PipelineBoard
              pipeline={state.pipeline}
              actionsEnabled={view.actionsEnabled}
              stageBusy={opportunityId => crm.busy(`stage:${opportunityId}`)}
              valueBusy={opportunityId => crm.busy(`value:${opportunityId}`)}
              search={boardSearch}
              memory={boardMemory}
              onSearch={setBoardSearch}
              onShowLost={crm.actions.openPipeline}
              onChangeStage={crm.actions.changeStage}
              onSetValue={crm.actions.setValue}
              onOpenFirm={crm.actions.openFirm}
            />
          </>
        ) : (
          <FirmsList pipeline={state.pipeline} onOpenFirm={crm.actions.openFirm} />
        )
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
