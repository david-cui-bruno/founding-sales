import { CALL_OUTCOMES } from '@fss/contracts';
import { button, element, orDash } from './firmDom.ts';
import { OUTCOME_LABELS, emptyOutcomeDraft, logCallCommand, outcomeProblem, outcomeSuppresses, OUTCOME_PROBLEM_SENTENCES, SUPPRESSION_WARNINGS, type OutcomeDraft } from './outcomeForm.ts';
import type { TodayBridge, TodayState } from './todayContract.ts';
import { buildTodayView, noticeSentence } from './todayView.ts';

/**
 * The Today window (specification 8.2, 8.3, 9.1, 14.2).
 *
 * A third entry point beside `renderer.ts` and `firmWorkspace.ts`, for the reason
 * G3b gave for the second: the windows are opened, used and closed, and the rules
 * about sessions, caches and versions live in the main process where they are tested
 * without Electron. Every value reaches the page through `textContent`, so a firm
 * name containing a tag is a firm name.
 *
 * The page holds no rule. It asks `buildTodayView` what to show, `outcomeForm` what a
 * call outcome needs before it may be recorded, and the bridge for everything else.
 * In particular it does not decide whether a task is snoozed or held: it renders the
 * label the view model gives it, and the server decides (8.2).
 */

const bridge = (): TodayBridge => {
  const value = globalThis.callieToday;
  if (value === undefined) throw new Error('the Callie Today bridge is not present');
  return value;
};

let lastState: TodayState | null = null;
let draft: OutcomeDraft = emptyOutcomeDraft();

function apply(next: Promise<TodayState>): void {
  void (async () => {
    render(await next);
  })();
}

function renderCards(root: HTMLElement, view: ReturnType<typeof buildTodayView>): void {
  const list = element('ul', { className: 'today-cards', testId: 'today-cards' });
  for (const entry of view.cards) {
    const item = element('li', { className: entry.expanded ? 'today-card expanded' : 'today-card' });
    item.dataset['testid'] = 'today-card';
    item.append(element('span', { className: 'lane', text: entry.laneLabel, testId: 'card-lane' }));
    item.append(element('span', { className: 'firm', text: entry.card.firmName, testId: 'card-firm' }));
    item.append(element('span', { className: 'counts', text: entry.countsLabel, testId: 'card-counts' }));
    item.append(element('time', { className: 'due', text: entry.card.dueAt, testId: 'card-due' }));

    const toggle = button(entry.expanded ? 'Close' : 'Open', 'card-expand', view.expandEnabled);
    toggle.addEventListener('click', () => {
      apply(entry.expanded ? bridge().collapse() : bridge().expand({ firmId: entry.card.firmId }));
    });
    item.append(toggle);
    list.append(item);
  }
  root.append(list);
  if (view.emptyMessage !== null) {
    root.append(element('p', { testId: 'today-empty', text: view.emptyMessage }));
  }
}

function renderSnooze(panel: HTMLElement, itemId: string, label: string, enabled: boolean): void {
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
    // workspace's business zone, which is the only zone this window is told about.
    apply(bridge().snooze({ itemId, reason: reason.value.trim(), returnAt: returnAt.value }));
  });
  form.append(reason, returnAt, submit);
  panel.append(form);
}

function renderOutcome(panel: HTMLElement, state: TodayState, enabled: boolean): void {
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
  note.disabled = !enabled;
  const warning = element('p', { className: 'warning', testId: 'outcome-warning' });
  const problem = element('p', { className: 'problem', testId: 'outcome-problem' });
  const submit = button('Record', 'outcome-submit', false);
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
    draft = read();
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
      // is complete before the window offers to send it.
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
    apply(
      bridge().recordOutcome({
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

function renderExpanded(root: HTMLElement, state: TodayState, view: ReturnType<typeof buildTodayView>): void {
  const expanded = state.expanded;
  if (expanded === null) return;
  const panel = element('section', { className: 'today-firm', testId: 'today-firm' });
  panel.append(element('h2', { text: expanded.firmName, testId: 'firm-name' }));

  const list = element('ul', { testId: 'today-tasks' });
  for (const entry of view.tasks) {
    const item = element('li', { testId: 'today-task' });
    item.append(element('span', { className: 'kind', text: entry.label, testId: 'task-kind' }));
    item.append(element('span', { className: 'who', text: orDash(entry.task.contactName), testId: 'task-contact' }));
    item.append(element('time', { text: entry.task.dueAt, testId: 'task-due' }));
    if (entry.task.status === 'snoozed') {
      item.append(
        element('span', { className: 'snoozed', testId: 'task-snoozed', text: `Asleep until ${orDash(entry.task.snoozeUntil)}` }),
      );
    }
    renderSnooze(item, entry.task.itemId, entry.delayLabel, entry.enabled);
    list.append(item);
  }
  panel.append(list);

  const dialling = element('div', { className: 'dial', testId: 'dial-panel' });
  for (const route of view.dialableRoutes) {
    const dial = button(`Call ${route.e164}`, 'dial', view.actionsEnabled);
    dial.addEventListener('click', () => {
      apply(
        bridge().dial({
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

  renderOutcome(panel, state, view.actionsEnabled);
  root.append(panel);
}

export function render(state: TodayState | null): void {
  if (state !== null) lastState = state;
  const current = lastState;
  const root = document.querySelector('#app');
  if (!(root instanceof HTMLElement) || current === null) return;
  const view = buildTodayView(current);

  root.replaceChildren();
  root.append(element('h1', { text: view.heading, testId: 'heading' }));
  if (current.snapshotDate !== null) {
    root.append(element('p', { className: 'date', text: current.snapshotDate, testId: 'snapshot-date' }));
  }

  const banners = element('div', { className: 'banners', testId: 'banners' });
  for (const banner of view.banners) {
    const node = element('p', { className: `banner banner-${banner.tone}`, text: banner.text });
    node.dataset['testid'] = `banner-${banner.tone}`;
    banners.append(node);
  }
  root.append(banners);

  const refresh = button('Refresh', 'refresh', true);
  refresh.addEventListener('click', () => {
    apply(bridge().refresh());
  });
  root.append(refresh);

  renderCards(root, view);
  renderExpanded(root, current, view);
}

export async function boot(): Promise<void> {
  render(await bridge().state());
}

export { noticeSentence };

if (typeof document !== 'undefined') {
  void boot();
}
