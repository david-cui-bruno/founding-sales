import { button, element } from './firmDom.ts';
import type { PipelineView, StageChange } from './firmWorkspaceContract.ts';
import { stageChangeSubmittable } from './firmWorkspaceView.ts';

/**
 * The pipeline (specification 8.1).
 *
 * "The default ordered stages are New, Contacting, Engaged, Qualified, Proposal,
 * Won, and Lost. Admins may rename, reorder, add, or retire nonterminal stages. Won
 * and Lost are terminal... Lost changes require a reason; an LLM may suggest but
 * never commit it."
 *
 * Three things follow, and each one is a decision rather than a layout:
 *
 * **The columns are the workspace's stages, in the workspace's order.** Not a
 * hard-coded seven. A renamed stage is renamed here for free, and a stage this
 * client has never heard of renders rather than breaking the board.
 *
 * **A retired stage is shown when something is still in it and never offered as a
 * destination.** "Retired stages remain readable": an opportunity sitting in one
 * has to be visible, or it is a record nobody can find and nobody can move out.
 *
 * **The Lost reason is required before the command is sent.** The server is the
 * authority — `changeStage` refuses `lost_reason_required` before it writes
 * anything — and this is the client not sending a command it can already see is
 * incomplete. Both halves are tested: the button is disabled without a reason, and
 * the refusal still renders when the server is the one that says no.
 */

export interface PipelineBoardOptions {
  readonly pipeline: PipelineView;
  readonly actionsEnabled: boolean;
  readonly onChangeStage: (change: StageChange) => void;
  readonly onOpenFirm: (firmId: string) => void;
}

export function renderPipelineBoard(root: HTMLElement, options: PipelineBoardOptions): void {
  const board = element('section', { className: 'pipeline', testId: 'pipeline-board' });

  for (const column of options.pipeline.columns) {
    // A retired stage with nothing in it is history nobody needs on screen.
    if (column.stage.retired && column.firms.length === 0) continue;

    const node = element('div', { className: 'pipeline-column', testId: 'pipeline-column' });
    node.dataset['stageKey'] = column.stage.key;
    const heading = element('h2', { testId: 'pipeline-column-name', text: column.stage.displayName });
    if (column.stage.retired) heading.append(element('span', { testId: 'stage-retired', text: ' (retired)' }));
    if (column.stage.terminalKind !== null) {
      heading.append(element('span', { testId: 'stage-terminal', text: ` · ${column.stage.terminalKind}` }));
    }
    node.append(heading);

    const list = element('ul', { testId: 'pipeline-firms' });
    for (const firm of column.firms) {
      const item = element('li', { testId: 'pipeline-firm' });
      item.dataset['firmId'] = firm.id;
      const open = button(firm.name, 'pipeline-open-firm', true);
      open.addEventListener('click', () => {
        options.onOpenFirm(firm.id);
      });
      item.append(open);
      item.append(renderStageChange(firm.id, options));
      list.append(item);
    }
    node.append(list);
    board.append(node);
  }

  root.append(board);
}

function renderStageChange(firmId: string, options: PipelineBoardOptions): HTMLElement {
  const form = element('div', { className: 'stage-change', testId: 'stage-change' });
  const opportunityId = options.pipeline.opportunityIdByFirmId[firmId];
  if (opportunityId === undefined) {
    // No open opportunity: there is no stage to change, and an inert control that
    // refuses when pressed is worse than no control at all.
    form.append(element('span', { testId: 'stage-change-unavailable', text: 'No open opportunity' }));
    return form;
  }

  const select = element('select', { testId: 'stage-select' });
  select.disabled = !options.actionsEnabled;
  // An empty value, explicitly: an `<option>` with no `value` attribute reports its
  // own text, so the placeholder would arrive as the stage key "Move to…" and the
  // button would be enabled before anything had been chosen.
  const placeholder = element('option', { text: 'Move to…' });
  placeholder.value = '';
  select.append(placeholder);
  for (const column of options.pipeline.columns) {
    if (column.stage.retired) continue;
    const option = element('option', { text: column.stage.displayName });
    option.value = column.stage.key;
    select.append(option);
  }

  const reason = element('input', { testId: 'stage-reason' });
  reason.type = 'text';
  reason.placeholder = 'Why was it lost?';
  reason.autocomplete = 'off';
  reason.hidden = true;
  reason.disabled = !options.actionsEnabled;

  const submit = button('Change stage', 'stage-submit', false);

  const terminalKindOf = (stageKey: string): 'won' | 'lost' | null =>
    options.pipeline.columns.find(column => column.stage.key === stageKey)?.stage.terminalKind ?? null;

  const refresh = (): void => {
    const losing = terminalKindOf(select.value) === 'lost';
    reason.hidden = !losing;
    submit.disabled = !stageChangeSubmittable({
      toStageKey: select.value,
      terminalKindOf,
      reason: reason.value,
      actionsEnabled: options.actionsEnabled,
    });
  };
  select.addEventListener('change', refresh);
  reason.addEventListener('input', refresh);
  refresh();

  submit.addEventListener('click', () => {
    options.onChangeStage({
      opportunityId,
      toStageKey: select.value,
      reason: reason.value.trim().length === 0 ? null : reason.value.trim(),
    });
  });

  form.append(select, reason, submit);
  return form;
}
