import { useState, type JSX } from 'react';
import type { PipelineView, StageChange } from '../firmWorkspaceContract.ts';
import { stageChangeSubmittable } from '../firmWorkspaceView.ts';
import { Button } from '../ui/button.tsx';
import { Input } from '../ui/input.tsx';
import { Row, RowActions, RowMain, Rows, Section, Tag } from '../ui/layout.tsx';
import { Select } from '../ui/select.tsx';

/**
 * The pipeline (specification 8.1).
 *
 * "The default ordered stages are New, Contacting, Engaged, Qualified, Proposal,
 * Won, and Lost. Admins may rename, reorder, add, or retire nonterminal stages. Won
 * and Lost are terminal... Lost changes require a reason; an LLM may suggest but
 * never commit it."
 *
 * Three things follow, and each one is a decision rather than a layout.
 *
 * **The stages are the workspace's, in the workspace's order.** Not a hard-coded seven.
 * A renamed stage is renamed here for free, and a stage this client has never heard of
 * renders rather than breaking the board.
 *
 * **A retired stage is shown when something is still in it and never offered as a
 * destination.** "Retired stages remain readable": an opportunity sitting in one has to
 * be visible, or it is a record nobody can find and nobody can move out.
 *
 * **The Lost reason is required before the command is sent.** The server is the
 * authority — `changeStage` refuses `lost_reason_required` before it writes anything —
 * and this is the client not sending a command it can already see is incomplete.
 *
 * It is a list of stages rather than a row of columns, which is what it was until
 * 1.0.13: seven columns in an 860px measure is seven columns nobody can read, and a
 * founder with a hundred firms wants to scan them, not drag them.
 */

function StageChangeControl({
  firmId,
  pipeline,
  actionsEnabled,
  onChangeStage,
}: {
  readonly firmId: string;
  readonly pipeline: PipelineView;
  readonly actionsEnabled: boolean;
  onChangeStage(change: StageChange): void;
}): JSX.Element {
  const [toStageKey, setToStageKey] = useState('');
  const [reason, setReason] = useState('');
  const opportunityId = pipeline.opportunityIdByFirmId[firmId];

  if (opportunityId === undefined) {
    // No open opportunity: there is no stage to change, and an inert control that
    // refuses when pressed is worse than no control at all.
    return (
      <span data-testid="stage-change" className="flex items-center">
        <Tag data-testid="stage-change-unavailable">No open opportunity</Tag>
      </span>
    );
  }

  const terminalKindOf = (stageKey: string): 'won' | 'lost' | null =>
    pipeline.columns.find(column => column.stage.key === stageKey)?.stage.terminalKind ?? null;
  const losing = terminalKindOf(toStageKey) === 'lost';
  const submittable = stageChangeSubmittable({ toStageKey, terminalKindOf, reason, actionsEnabled });

  return (
    <span data-testid="stage-change" className="flex items-center gap-1">
      {losing ? (
        <Input
          data-testid="stage-reason"
          placeholder="Why was it lost?"
          autoComplete="off"
          disabled={!actionsEnabled}
          value={reason}
          onChange={event => {
            setReason(event.target.value);
          }}
          className="h-7 w-44 text-xs"
        />
      ) : null}
      <Select
        data-testid="stage-select"
        aria-label="Move to"
        disabled={!actionsEnabled}
        value={toStageKey}
        onChange={event => {
          setToStageKey(event.target.value);
        }}
        className="h-7 w-36 text-xs"
      >
        {/* An empty value, explicitly: an option with no `value` reports its own text,
            so the placeholder would arrive as the stage key "Move to…". */}
        <option value="">Move to…</option>
        {pipeline.columns
          .filter(column => !column.stage.retired)
          .map(column => (
            <option key={column.stage.key} value={column.stage.key}>
              {column.stage.displayName}
            </option>
          ))}
      </Select>
      <Button
        size="sm"
        variant="outline"
        data-testid="stage-submit"
        disabled={!submittable}
        onClick={() => {
          onChangeStage({ opportunityId, toStageKey, reason: reason.trim() === '' ? null : reason.trim() });
        }}
      >
        Change stage
      </Button>
    </span>
  );
}

export function PipelineBoard({
  pipeline,
  actionsEnabled,
  onChangeStage,
  onOpenFirm,
}: {
  readonly pipeline: PipelineView;
  readonly actionsEnabled: boolean;
  onChangeStage(change: StageChange): void;
  onOpenFirm(firmId: string): void;
}): JSX.Element {
  return (
    <div data-testid="pipeline-board">
      {pipeline.columns
        // A retired stage with nothing in it is history nobody needs on screen.
        .filter(column => !(column.stage.retired && column.firms.length === 0))
        .map(column => (
          <Section
            key={column.stage.key}
            data-testid="pipeline-column"
            data-stage-key={column.stage.key}
            title={column.stage.displayName}
            count={column.firms.length}
            actions={
              <>
                {column.stage.retired ? <Tag data-testid="stage-retired">retired</Tag> : null}
                {column.stage.terminalKind === null ? null : (
                  <Tag data-testid="stage-terminal" tone={column.stage.terminalKind === 'won' ? 'ok' : 'none'}>
                    {column.stage.terminalKind}
                  </Tag>
                )}
              </>
            }
          >
            <span data-testid="pipeline-column-name" className="sr-only">
              {column.stage.displayName}
            </span>
            {column.firms.length === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">Nothing here.</p>
            ) : (
              <Rows data-testid="pipeline-firms">
                {column.firms.map(firm => (
                  <Row key={firm.id} data-testid="pipeline-firm" data-firm-id={firm.id}>
                    <RowMain
                      line={
                        <Button
                          variant="link"
                          size="sm"
                          data-testid="pipeline-open-firm"
                          className="h-auto px-0 text-sm"
                          onClick={() => {
                            onOpenFirm(firm.id);
                          }}
                        >
                          {firm.name}
                        </Button>
                      }
                      detail={[firm.locality, firm.regionCode].filter(part => part !== null).join(', ') || null}
                    />
                    <RowActions>
                      <StageChangeControl
                        firmId={firm.id}
                        pipeline={pipeline}
                        actionsEnabled={actionsEnabled}
                        onChangeStage={onChangeStage}
                      />
                    </RowActions>
                  </Row>
                ))}
              </Rows>
            )}
          </Section>
        ))}
    </div>
  );
}
