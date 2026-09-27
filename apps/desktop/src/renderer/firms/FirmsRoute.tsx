import type { JSX } from 'react';
import { ChevronLeft } from 'lucide-react';
import type { Generation } from '../app/generation.ts';
import { buildFirmWorkspaceView } from '../firmWorkspaceView.ts';
import type { Route } from '../routes.ts';
import { Button } from '../ui/button.tsx';
import { Banners, Page, Row, RowMain, Rows, Section, ViewHeader } from '../ui/layout.tsx';
import { AddFirmForm } from './AddFirmForm.tsx';
import { FirmMerge } from './FirmMerge.tsx';
import { FirmPage } from './FirmPage.tsx';
import { ImportScreen } from './ImportScreen.tsx';
import { PipelineBoard } from './PipelineBoard.tsx';
import { useCrm } from './useCrm.ts';

/**
 * Firms: the pipeline, one firm's page, Add firm, Import and the merge screen (1.0.13).
 *
 * One route shows all five. `firms` is the board or a capture screen the bridge is still
 * holding; `firm/<id>` is that firm, wherever it was opened from — a Today card, a reply
 * card, the board — and "← Pipeline" is the way back that a firm opened in its own window
 * never had.
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
  const state = crm.state;

  if (!crm.available) {
    return (
      <Page>
        <ViewHeader title="Firms" />
        <p data-testid="firms-unavailable" className="mt-6 text-sm text-muted-foreground">
          Callie cannot reach the rest of the app from this window.
        </p>
      </Page>
    );
  }
  if (state === null) {
    return (
      <Page>
        <ViewHeader title="Firms" />
      </Page>
    );
  }

  const view = buildFirmWorkspaceView(state);
  const onFirm = state.screen === 'firm' && state.firm !== null;
  const unplaced = state.pipeline?.unplacedFirms ?? [];

  return (
    <Page data-testid="firms" aria-busy={crm.pending > 0}>
      <ViewHeader
        title={onFirm && state.firm !== null ? state.firm.read.firm.name : view.heading}
        above={
          onFirm ? (
            <Button
              variant="quiet"
              size="sm"
              data-testid="back-to-pipeline"
              className="-ml-2 self-start"
              onClick={crm.actions.openPipeline}
            >
              <ChevronLeft aria-hidden />
              Pipeline
            </Button>
          ) : undefined
        }
        actions={
          state.screen === 'pipeline' ? (
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
        <FirmPage
          page={state.firm}
          sequences={state.sequences}
          actionsEnabled={view.actionsEnabled}
          redactionNotice={view.redactionNotice}
          onSaveContact={crm.actions.saveContact}
          onCheckRoute={crm.actions.checkRoute}
          onOpenOpportunity={crm.actions.openOpportunity}
          onEnroll={crm.actions.enroll}
        />
      ) : state.screen === 'add_firm' && state.addFirm !== null ? (
        <AddFirmForm
          view={state.addFirm}
          actionsEnabled={view.actionsEnabled}
          onSubmit={crm.actions.addFirm}
          onCancel={crm.actions.openPipeline}
          onOpenFirm={crm.actions.openFirm}
        />
      ) : state.screen === 'import' && state.import !== null ? (
        <ImportScreen
          view={state.import}
          actionsEnabled={view.actionsEnabled && state.role === 'admin'}
          onChooseFile={crm.actions.chooseImportFile}
          onCommit={crm.actions.commitImport}
          onDone={crm.actions.openPipeline}
        />
      ) : state.screen === 'merge' && state.merge !== null ? (
        <FirmMerge
          merge={state.merge}
          // 7.2 and 5.2: a merge is an explicit audited command and an admin's. A
          // salesperson sees the conflicts and cannot commit the choice.
          actionsEnabled={view.actionsEnabled && state.role === 'admin'}
          onResolve={crm.actions.resolveMerge}
        />
      ) : state.screen === 'pipeline' && state.pipeline !== null ? (
        <>
          {/* Firms with no open opportunity, which the board has no stage for. A firm
              just added or imported is one, and a board that left them out showed
              nothing for what had just been added. */}
          {unplaced.length === 0 ? null : (
            <Section data-testid="unplaced-firms" title="Not in the pipeline yet" count={unplaced.length}>
              <Rows>
                {unplaced.map(firm => (
                  <Row key={firm.id} data-testid="unplaced-firm" data-firm-id={firm.id}>
                    <RowMain
                      line={
                        <Button
                          variant="link"
                          size="sm"
                          data-testid="unplaced-open-firm"
                          className="h-auto px-0 text-sm"
                          onClick={() => {
                            crm.actions.openFirm(firm.id);
                          }}
                        >
                          {firm.name}
                        </Button>
                      }
                    />
                  </Row>
                ))}
              </Rows>
            </Section>
          )}
          <PipelineBoard
            pipeline={state.pipeline}
            actionsEnabled={view.actionsEnabled}
            onChangeStage={crm.actions.changeStage}
            onOpenFirm={crm.actions.openFirm}
          />
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
