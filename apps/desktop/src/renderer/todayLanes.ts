import { CALL_OUTCOMES } from '@fss/contracts';
import { button, element, orDash } from './firmDom.ts';
import { OUTCOME_LABELS, logCallCommand, outcomeProblem, outcomeSuppresses, OUTCOME_PROBLEM_SENTENCES, SUPPRESSION_WARNINGS, type OutcomeDraft } from './outcomeForm.ts';
import type { TodayBridge, TodayState } from './todayContract.ts';
import type { CardView, TodayScreenView } from './todayView.ts';
import { dueLabel, type LaneSection } from './homeView.ts';

/**
 * The Today lanes, drawn (specification 8.2, 8.3, 9.1, 14.2).
 *
 * G6 wrote this as the Today window's page. Lane g65 made Today the main window's Home
 * and moved the drawing here unchanged in what it offers, so there is one code path for
 * the lanes and Home is its caller (`docs/decisions/g65-today-is-the-home.md`). The
 * cards, the expansion into contact tasks, the snooze or hold, the Call button and the
 * outcome form behave exactly as they did in that window; what changed is where they
 * sit — sections with a grey header, rows with dividers, the expanded firm under its own
 * row — and that a task's instant reads as the business zone's clock.
 *
 * The module holds no rule. It asks `buildTodayView` what to show, `outcomeForm` what a
 * call outcome needs before it may be recorded, and the bridge for everything else. It
 * does not decide whether a task is snoozed or held: it renders the label the view model
 * gives it, and the server decides (8.2). Every value reaches the page through
 * `textContent`, so a firm name containing a tag is a firm name.
 */

export interface LanesHost {
  readonly bridge: TodayBridge;
  /** Draw whatever state the bridge answers with. */
  readonly apply: (next: Promise<TodayState>) => void;
}

export interface LanesContent {
  readonly sections: readonly LaneSection[];
  /** One grey line in place of the lanes, or null when there are cards. */
  readonly emptyLine: string | null;
}

function renderCard(item: HTMLElement, entry: CardView, view: TodayScreenView, host: LanesHost): void {
  const row = element('div', { className: 'row' });
  const main = element('div', { className: 'row-main' });
  main.append(element('span', { className: 'name', text: entry.card.firmName, testId: 'card-firm' }));
  main.append(element('span', { className: 'why', text: entry.countsLabel, testId: 'card-counts' }));
  row.append(main);

  const actions = element('div', { className: 'row-actions' });
  const toggle = button(entry.expanded ? 'Close' : 'Open', 'card-expand', view.expandEnabled);
  toggle.className = 'btn';
  toggle.addEventListener('click', () => {
    host.apply(entry.expanded ? host.bridge.collapse() : host.bridge.expand({ firmId: entry.card.firmId }));
  });
  actions.append(toggle);
  row.append(actions);
  item.append(row);
}

function renderSnooze(panel: HTMLElement, itemId: string, label: string, enabled: boolean, host: LanesHost): void {
  const form = element('form', { className: 'snooze', testId: 'snooze-form' });
  const reason = element('input', { testId: 'snooze-reason' });
  reason.type = 'text';
  reason.required = true;
  reason.placeholder = 'Why';
  reason.disabled = !enabled;
  const returnAt = element('input', { testId: 'snooze-return' });
  returnAt.type = 'datetime-local';
  returnAt.required = true;
  returnAt.disabled = !enabled;

  const submit = button(label, 'snooze-submit', enabled);
  submit.className = 'btn';
  submit.type = 'submit';
  const update = (): void => {
    submit.disabled = !enabled || reason.value.trim().length === 0 || returnAt.value.length === 0;
  };
  reason.addEventListener('input', update);
  returnAt.addEventListener('input', update);
  update();

  form.addEventListener('submit', event => {
    event.preventDefault();
    // `datetime-local` has no zone. The main process resolves it against the
    // workspace's business zone, which is the only zone this page is told about.
    host.apply(host.bridge.snooze({ itemId, reason: reason.value.trim(), returnAt: returnAt.value }));
  });
  form.append(reason, returnAt, submit);
  panel.append(form);
}

function renderOutcome(panel: HTMLElement, state: TodayState, enabled: boolean, host: LanesHost): void {
  const expanded = state.expanded;
  if (expanded === null) return;
  const form = element('form', { className: 'outcome', testId: 'outcome-form' });

  const select = element('select', { testId: 'outcome-select' });
  select.disabled = !enabled;
  const blank = element('option', { text: 'What happened…' });
  blank.value = '';
  select.append(blank);
  for (const outcome of CALL_OUTCOMES) {
    const option = element('option', { text: OUTCOME_LABELS[outcome] });
    option.value = outcome;
    select.append(option);
  }

  const note = element('textarea', { testId: 'outcome-note' });
  note.placeholder = 'Note';
  note.disabled = !enabled;
  const warning = element('p', { className: 'warning', testId: 'outcome-warning' });
  const problem = element('p', { className: 'problem', testId: 'outcome-problem' });
  const submit = button('Record', 'outcome-submit', false);
  submit.className = 'btn btn-primary';
  submit.type = 'submit';

  const callback = element('fieldset', { testId: 'outcome-callback' });
  const callbackDate = element('input', { testId: 'callback-date' });
  callbackDate.type = 'date';
  const callbackTime = element('input', { testId: 'callback-time' });
  callbackTime.type = 'time';
  callback.append(element('legend', { text: 'When did you promise to call back?' }), callbackDate, callbackTime);
  callback.hidden = true;

  const read = (): OutcomeDraft => ({
    outcome: select.value === '' ? null : (select.value as OutcomeDraft['outcome']),
    note: note.value,
    callbackLocalDate: callbackDate.value,
    callbackLocalTime: callbackTime.value,
    callbackTimeZone: state.businessTimeZone ?? '',
    // The instant is resolved by the main process, which knows the zone; the form
    // only has to carry a plausible one so `outcomeProblem` can stop an empty draft.
    callbackDueAt:
      callbackDate.value === '' ? '' : `${callbackDate.value}T${callbackTime.value === '' ? '09:00' : callbackTime.value}:00.000Z`,
    doNotCallCoversAllContact: false,
  });

  const update = (): void => {
    const draft = read();
    callback.hidden = draft.outcome !== 'callback_requested';
    const suppression = outcomeSuppresses(draft);
    warning.textContent = suppression === 'none' ? '' : SUPPRESSION_WARNINGS[suppression];
    const stopper = outcomeProblem(draft);
    problem.textContent = stopper === null || draft.outcome === null ? '' : OUTCOME_PROBLEM_SENTENCES[stopper];
    submit.disabled = !enabled || stopper !== null;
  };
  for (const field of [select, note, callbackDate, callbackTime]) field.addEventListener('input', update);
  select.addEventListener('change', update);
  update();

  form.addEventListener('submit', event => {
    event.preventDefault();
    const built = logCallCommand({
      // The main process mints the real command id; this one only proves the draft
      // is complete before the page offers to send it.
      commandId: 'draft',
      clientVersion: '0.0.0',
      firmId: expanded.firmId,
      occurredAt: new Date().toISOString(),
      draft: read(),
    });
    if ('problem' in built) {
      problem.textContent = OUTCOME_PROBLEM_SENTENCES[built.problem];
      return;
    }
    const outcome = built.command.outcome;
    host.apply(
      host.bridge.recordOutcome({
        firmId: expanded.firmId,
        contactId: null,
        routeId: null,
        outcome,
        note: built.command.note ?? '',
        callback:
          built.command.callback === undefined
            ? null
            : {
                localDate: built.command.callback.localDate,
                localTime: built.command.callback.localTime ?? '',
                dueAt: built.command.callback.dueAt,
                sourceTimeZone: built.command.callback.sourceTimeZone,
              },
        doNotCallCoversAllContact: built.command.doNotCallCoversAllContact ?? false,
      }),
    );
  });

  form.append(select, callback, note, warning, problem, submit);
  panel.append(form);
}

function renderExpanded(parent: HTMLElement, state: TodayState, view: TodayScreenView, host: LanesHost): void {
  const expanded = state.expanded;
  if (expanded === null) return;
  const panel = element('section', { className: 'today-firm', testId: 'today-firm' });
  // The row above already names the firm; the heading is for a screen reader.
  panel.append(element('h3', { className: 'visually-hidden', text: expanded.firmName, testId: 'firm-name' }));

  const list = element('ul', { className: 'tasks', testId: 'today-tasks' });
  for (const entry of view.tasks) {
    const item = element('li', { className: 'task', testId: 'today-task' });
    const due = element('time', { className: 'when', text: dueLabel(entry.task.dueAt, state.businessTimeZone, state.snapshotDate), testId: 'task-due' });
    due.dateTime = entry.task.dueAt;
    item.append(due);
    const what = element('span', { className: 'what' });
    what.append(element('span', { className: 'kind', text: entry.label, testId: 'task-kind' }));
    what.append(element('span', { className: 'who', text: orDash(entry.task.contactName), testId: 'task-contact' }));
    if (entry.task.status === 'snoozed') {
      const until = entry.task.snoozeUntil === null ? null : dueLabel(entry.task.snoozeUntil, state.businessTimeZone, state.snapshotDate);
      what.append(element('span', { className: 'tag', testId: 'task-snoozed', text: `Asleep until ${orDash(until)}` }));
    }
    item.append(what);
    renderSnooze(item, entry.task.itemId, entry.delayLabel, entry.enabled, host);
    list.append(item);
  }
  panel.append(list);

  const dialling = element('div', { className: 'dial', testId: 'dial-panel' });
  for (const route of view.dialableRoutes) {
    const dial = button(`Call ${route.e164}`, 'dial', view.actionsEnabled);
    dial.className = 'btn btn-primary';
    dial.addEventListener('click', () => {
      host.apply(
        host.bridge.dial({
          firmId: expanded.firmId,
          contactId: route.contactId,
          routeId: route.routeId,
          // 9.2: the version the card *displays* is the version the server checks.
          routeVersion: route.version,
        }),
      );
    });
    dialling.append(dial);
  }
  dialling.append(element('p', { className: 'limitation', testId: 'dial-limitation', text: state.handoffNotice }));
  panel.append(dialling);

  renderOutcome(panel, state, view.actionsEnabled, host);
  parent.append(panel);
}

/**
 * The lanes into `root`: one section per run of the server's order, a row per firm,
 * and the expanded firm's tasks, routes and outcome form under its own row.
 */
export function renderLanes(
  root: HTMLElement,
  state: TodayState,
  view: TodayScreenView,
  content: LanesContent,
  host: LanesHost,
): void {
  const lanes = element('div', { className: 'today-cards', testId: 'today-cards' });
  let expandedShown = false;
  for (const section of content.sections) {
    const block = element('section', { className: 'lane', testId: 'lane' });
    block.dataset['lane'] = section.lane;
    const heading = element('h2', { className: 'section-head' });
    heading.append(element('span', { text: section.label, testId: 'lane-label' }));
    heading.append(element('small', { text: String(section.cards.length), testId: 'lane-count' }));
    block.append(heading);

    const list = element('ul', { className: 'rows' });
    for (const entry of section.cards) {
      const item = element('li', { className: entry.expanded ? 'today-card expanded' : 'today-card', testId: 'today-card' });
      renderCard(item, entry, view, host);
      if (entry.expanded) {
        renderExpanded(item, state, view, host);
        expandedShown = true;
      }
      list.append(item);
    }
    block.append(list);
    lanes.append(block);
  }
  // A firm expanded and then gone from the list at the next read keeps its tasks on
  // screen until it is closed, as it did in G6's window.
  if (!expandedShown) renderExpanded(lanes, state, view, host);
  root.append(lanes);

  if (content.emptyLine !== null) {
    root.append(element('p', { className: 'quiet empty', testId: 'today-empty', text: content.emptyLine }));
  }
}
