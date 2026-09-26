import { CALL_OUTCOMES, callbackInstant } from '@fss/contracts';
import { button, element, orDash } from './firmDom.ts';
import {
  OUTCOME_LABELS,
  OUTCOME_PROBLEM_SENTENCES,
  SUPPRESSION_WARNINGS,
  callbackNeedsTime,
  logCallCommand,
  outcomeProblem,
  outcomeSuppresses,
  resolvedCallbackInstant,
  type OutcomeDraft,
} from './outcomeForm.ts';
import type { TodayBridge, TodayState } from './todayContract.ts';
import type { CardView, TaskView, TodayScreenView } from './todayView.ts';
import { dueLabel, type LaneSection } from './homeView.ts';
import { navigate } from './routes.ts';

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
 * Lane g79 added three things, all asked of the view model rather than decided here:
 * the outcome form names the task the call was for and the number just called, so the
 * server can apply the outcome to its step or callback; a paused automated send shows
 * Resume where Pause was; and "Callback — needs a time" offers a day and a time.
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
  // The firm's page, in the same window: the Firms view opens it through the CRM bridge.
  const firm = button('Firm page', 'card-open-firm', true);
  firm.className = 'btn btn-quiet';
  firm.addEventListener('click', () => {
    navigate({ name: 'firm', firmId: entry.card.firmId });
  });
  actions.append(firm);
  const toggle = button(entry.expanded ? 'Close' : 'Open', 'card-expand', true);
  toggle.className = 'btn';
  toggle.addEventListener('click', () => {
    host.apply(entry.expanded ? host.bridge.collapse() : host.bridge.expand({ firmId: entry.card.firmId }));
  });
  actions.append(toggle);
  row.append(actions);
  item.append(row);
}

/** The line that says what a callback's day and time resolve to, or why it has none. */
function callbackLine(instant: string | null, state: TodayState): string {
  if (instant === null) return '';
  return `Callie will put the callback at ${dueLabel(instant, state.businessTimeZone, state.snapshotDate)}.`;
}

function renderSnooze(panel: HTMLElement, entry: TaskView, host: LanesHost): void {
  const itemId = entry.task.itemId;
  const enabled = entry.enabled;
  // An automated send is paused until Resume, so it asks why and not until when
  // (8.2; lane g79, C22). A manual task's snooze needs both.
  const asksReturn = !entry.task.automated;
  const form = element('form', { className: 'snooze', testId: 'snooze-form' });
  const reason = element('input', { testId: 'snooze-reason' });
  reason.type = 'text';
  reason.required = true;
  reason.placeholder = 'Why';
  reason.disabled = !enabled;
  const returnAt = element('input', { testId: 'snooze-return' });
  returnAt.type = 'datetime-local';
  returnAt.required = asksReturn;
  returnAt.disabled = !enabled;
  returnAt.hidden = !asksReturn;

  const submit = button(entry.delayLabel, 'snooze-submit', enabled);
  submit.className = 'btn';
  submit.type = 'submit';
  const update = (): void => {
    submit.disabled = !enabled || reason.value.trim().length === 0 || (asksReturn && returnAt.value.length === 0);
  };
  reason.addEventListener('input', update);
  returnAt.addEventListener('input', update);
  update();

  form.addEventListener('submit', event => {
    event.preventDefault();
    // `datetime-local` has no zone. The main process resolves it against the
    // workspace's business zone, which is the only zone this page is told about.
    host.apply(host.bridge.snooze({ itemId, reason: reason.value.trim(), returnAt: asksReturn ? returnAt.value : '' }));
  });
  form.append(reason, returnAt, submit);
  panel.append(form);
}

/** A paused automated task: says so, and offers the one control that lifts it (C22). */
function renderPaused(panel: HTMLElement, holdId: string, enabled: boolean, host: LanesHost): void {
  const resume = button('Resume', 'pause-release', enabled);
  resume.className = 'btn';
  resume.addEventListener('click', () => {
    host.apply(host.bridge.releasePause({ holdId }));
  });
  panel.append(resume);
}

/** "Callback — needs a time": the day and time the person now confirms (C13). */
function renderSchedule(panel: HTMLElement, callLogId: string, state: TodayState, enabled: boolean, host: LanesHost): void {
  const form = element('form', { className: 'schedule', testId: 'schedule-form' });
  const date = element('input', { testId: 'schedule-date' });
  date.type = 'date';
  date.disabled = !enabled;
  const time = element('input', { testId: 'schedule-time' });
  time.type = 'time';
  time.disabled = !enabled;
  const resolved = element('p', { className: 'quiet', testId: 'schedule-resolved' });
  const submit = button('Set time', 'schedule-submit', false);
  submit.className = 'btn';
  submit.type = 'submit';
  const instant = (): string | null =>
    state.businessTimeZone === null || date.value === '' ? null : callbackInstant(date.value, time.value, state.businessTimeZone);
  const update = (): void => {
    const at = instant();
    resolved.textContent = callbackLine(at, state);
    submit.disabled = !enabled || at === null;
  };
  date.addEventListener('input', update);
  time.addEventListener('input', update);
  update();
  form.addEventListener('submit', event => {
    event.preventDefault();
    host.apply(host.bridge.scheduleCallback({ callLogId, localDate: date.value, localTime: time.value }));
  });
  form.append(date, time, resolved, submit);
  panel.append(form);
}

function renderOutcome(panel: HTMLElement, state: TodayState, view: TodayScreenView, enabled: boolean, host: LanesHost): void {
  const expanded = state.expanded;
  if (expanded === null) return;
  const form = element('form', { className: 'outcome', testId: 'outcome-form' });

  // The number the last Call button handed to the phone app, when it was this firm's:
  // the outcome is recorded against it and the ticket that authorized it (C16).
  const lastCall = state.lastCall !== undefined && state.lastCall !== null && state.lastCall.firmId === expanded.firmId
    ? state.lastCall
    : null;
  const called = element('p', {
    className: 'quiet',
    testId: 'outcome-call',
    text: lastCall === null ? 'Not after a call from Callie: this records the call as history.' : `The call to ${lastCall.e164}.`,
  });

  // Which task the call was for, so its step or callback moves on (C04, C17).
  const taskSelect = element('select', { testId: 'outcome-task' });
  taskSelect.disabled = !enabled;
  const noTask = element('option', { text: 'Not for a task on this card' });
  noTask.value = '';
  taskSelect.append(noTask);
  for (const entry of view.tasks.filter(candidate => candidate.callable)) {
    const option = element('option', { text: `${entry.label} — ${orDash(entry.task.contactName)}` });
    option.value = entry.task.itemId;
    taskSelect.append(option);
  }
  taskSelect.value = view.outcomeItemId ?? '';

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
  const callbackResolved = element('p', { className: 'quiet', testId: 'callback-resolved' });
  callback.append(
    element('legend', { text: 'When did you promise to call back?' }),
    callbackDate,
    callbackTime,
    callbackResolved,
  );
  callback.hidden = true;

  const read = (): OutcomeDraft => ({
    outcome: select.value === '' ? null : (select.value as OutcomeDraft['outcome']),
    note: note.value,
    callbackLocalDate: callbackDate.value,
    callbackLocalTime: callbackTime.value,
    callbackTimeZone: state.businessTimeZone ?? '',
    callbackDueAt: '',
    doNotCallCoversAllContact: false,
  });

  const update = (): void => {
    const draft = read();
    callback.hidden = draft.outcome !== 'callback_requested';
    // The instant the domain's own clock gives the day and time, shown back so the
    // person confirms the instant that will be stored (9.1, C18) — including the hour
    // a DST gap moves it to. With no day at all it says where the callback will wait.
    callbackResolved.textContent = callbackNeedsTime(draft)
      ? 'No day yet? Record it anyway: “Callback — needs a time” goes on today’s list.'
      : callbackLine(resolvedCallbackInstant(draft), state);
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
      draft: read(),
    });
    if ('problem' in built) {
      problem.textContent = OUTCOME_PROBLEM_SENTENCES[built.problem];
      return;
    }
    const outcome = built.command.outcome;
    const itemId = taskSelect.value === '' ? null : taskSelect.value;
    const task = view.tasks.find(entry => entry.task.itemId === itemId)?.task ?? null;
    const draft = read();
    host.apply(
      host.bridge.recordOutcome({
        firmId: expanded.firmId,
        contactId: lastCall?.contactId ?? task?.contactId ?? null,
        routeId: lastCall?.routeId ?? null,
        itemId,
        outcome,
        note: built.command.note ?? '',
        callback:
          outcome !== 'callback_requested' || callbackNeedsTime(draft)
            ? null
            : {
                localDate: draft.callbackLocalDate.trim(),
                localTime: draft.callbackLocalTime.trim(),
                dueAt: built.command.callback?.dueAt ?? '',
                sourceTimeZone: draft.callbackTimeZone,
              },
        doNotCallCoversAllContact: built.command.doNotCallCoversAllContact ?? false,
      }),
    );
  });

  form.append(called, taskSelect, select, callback, note, warning, problem, submit);
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
    if (entry.paused) what.append(element('span', { className: 'tag', testId: 'task-paused', text: 'Paused' }));
    item.append(what);
    const holdId = entry.task.pauseHoldId;
    const callLogId = entry.task.callLogId;
    if (typeof holdId === 'string') renderPaused(item, holdId, view.actionsEnabled, host);
    else if (typeof callLogId === 'string') renderSchedule(item, callLogId, state, entry.enabled, host);
    else renderSnooze(item, entry, host);
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

  renderOutcome(panel, state, view, view.actionsEnabled, host);
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
