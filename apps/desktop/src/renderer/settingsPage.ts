import { element } from './firmDom.ts';
import { adminViewOf } from './settingsView.ts';
import type { AdminBridge, AdminScreen, AdminState } from './settingsContract.ts';

/**
 * The administration window: Settings, Dashboard, Diagnostics.
 *
 * A third entry point beside `renderer.ts` and `firmWorkspace.ts`, on the pattern
 * G3b and G6 established. Every state change is "ask the bridge, render what came
 * back": there is no local model to go stale and no optimistic update to reconcile,
 * which is 14.2's "contains no authoritative … logic" made structural.
 *
 * Every value reaches the page through `textContent` — `element` from `firmDom.ts`
 * is the only way anything is written — so a prospect's name in a hold reason or a
 * refusal code cannot become markup.
 *
 * Editing a setting is a textarea of JSON rather than a bespoke form per slice.
 * That is a deliberate version-one choice and it is written down in
 * `docs/decisions/g9-settings-editing-is-json.md`: the server validates by key and
 * refuses with `invalid_value`, seven hand-built forms would be seven more places
 * for the contract to drift, and the person using this is the founder.
 */

const bridge = (): AdminBridge => {
  const value = globalThis.callieAdmin;
  if (value === undefined) throw new Error('the Callie administration bridge is not present');
  return value;
};

let lastState: AdminState | null = null;

function apply(next: Promise<AdminState>): void {
  void (async () => {
    render(await next);
  })();
}

function tab(label: string, screen: AdminScreen, current: AdminScreen): HTMLElement {
  const button = element('button', { className: screen === current ? 'tab tab-current' : 'tab', text: label });
  button.dataset['testid'] = `tab-${screen}`;
  button.addEventListener('click', () => {
    apply(bridge().show({ screen }));
  });
  return button;
}

export function render(state: AdminState | null): void {
  if (state !== null) lastState = state;
  const current = lastState;
  const root = document.querySelector('#app');
  if (!(root instanceof HTMLElement) || current === null) return;
  const view = adminViewOf(current);

  root.replaceChildren();
  root.append(element('h1', { text: 'Administration', testId: 'heading' }));

  const tabs = element('nav', { className: 'tabs', testId: 'tabs' });
  tabs.append(
    tab('Settings', 'settings', view.screen),
    tab('Dashboard', 'dashboard', view.screen),
    tab('Diagnostics', 'diagnostics', view.screen),
  );
  root.append(tabs);

  if (view.banner !== null) {
    root.append(element('p', { className: 'banner banner-warning', text: view.banner, testId: 'banner-offline' }));
  }
  if (view.notice !== null) {
    root.append(element('p', { className: 'banner banner-notice', text: view.notice, testId: 'notice' }));
  }

  if (view.screen === 'settings') renderSettings(root, view);
  else renderPanels(root, view);
}

function renderSettings(root: HTMLElement, view: ReturnType<typeof adminViewOf>): void {
  if (view.sending !== null) {
    root.append(element('p', { className: 'sending', text: view.sending.line, testId: 'sending' }));
  }

  const list = element('ul', { className: 'settings', testId: 'settings' });
  for (const row of view.settings) {
    const item = element('li', { className: 'setting' });
    item.dataset['testid'] = `setting-${row.settingKey}`;
    item.append(element('h2', { text: row.label }));
    item.append(element('p', { className: 'provenance', text: row.provenance }));

    const editor = document.createElement('textarea');
    editor.value = JSON.stringify(row.value, null, 2);
    editor.disabled = !row.editable;
    editor.dataset['testid'] = `value-${row.settingKey}`;
    item.append(editor);

    const note = document.createElement('input');
    note.type = 'text';
    note.placeholder = 'Why are you changing this?';
    note.disabled = !row.editable;
    note.dataset['testid'] = `note-${row.settingKey}`;
    item.append(note);

    const save = element('button', { text: 'Save' });
    save.dataset['testid'] = `save-${row.settingKey}`;
    (save as HTMLButtonElement).disabled = !row.editable;
    save.addEventListener('click', () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(editor.value);
      } catch {
        // Not a refusal from the server, so it is not a notice: the page says the
        // value is not readable and sends nothing.
        editor.setAttribute('aria-invalid', 'true');
        return;
      }
      apply(
        bridge().saveSetting({
          settingKey: row.settingKey as Parameters<AdminBridge['saveSetting']>[0]['settingKey'],
          value: parsed,
          changeNote: note.value,
        }),
      );
    });
    item.append(save);

    const history = element('button', { text: 'History' });
    history.dataset['testid'] = `history-${row.settingKey}`;
    history.addEventListener('click', () => {
      apply(
        bridge().openHistory({
          settingKey: row.settingKey as Parameters<AdminBridge['openHistory']>[0]['settingKey'],
        }),
      );
    });
    item.append(history);

    if (row.notEditableBecause !== null) {
      item.append(element('p', { className: 'inert', text: row.notEditableBecause }));
    }
    list.append(item);
  }
  root.append(list);

  const stages = element('ul', { className: 'stages', testId: 'stages' });
  for (const stage of view.stages) {
    const item = element('li', { text: stage.label });
    item.dataset['testid'] = `stage-${stage.key}`;
    if (stage.administrable) {
      const retire = element('button', { text: 'Retire' });
      retire.dataset['testid'] = `retire-${stage.key}`;
      retire.addEventListener('click', () => {
        apply(bridge().retireStage({ stageKey: stage.key }));
      });
      item.append(retire);
    } else if (stage.note !== null) {
      item.append(element('span', { className: 'inert', text: stage.note }));
    }
    stages.append(item);
  }
  root.append(stages);

  renderHolidays(root, view);
  renderSendingAdmin(root, view);

  const elsewhere = element('ul', { className: 'elsewhere', testId: 'elsewhere' });
  for (const entry of view.elsewhere) {
    elsewhere.append(element('li', { text: `${entry.topic} — ${entry.path} (${entry.ownedBy})` }));
  }
  root.append(elsewhere);
}

/**
 * G8's holiday calendar, edited here and written by G8's command.
 *
 * A calendar is superseded, never edited in place, because every due instant G8
 * stores freezes the calendar version it was computed under. So the control asks for
 * a *new version name* alongside the dates, and the current version is shown beside
 * it rather than prefilled — prefilling it would invite a name that is already taken
 * and a refusal the person did not expect.
 *
 * The dates are one per line, which is the shape a person pastes from a payroll
 * calendar. Splitting is all this does; whether a date is valid, whether there are
 * too many and whether the version is taken are the server's answers.
 */
function renderHolidays(root: HTMLElement, view: ReturnType<typeof adminViewOf>): void {
  const holidays = view.holidays;
  if (holidays === null) return;

  const block = element('section', { className: 'holidays', testId: 'holidays' });
  block.append(element('h2', { text: 'Workspace holidays' }));
  block.append(element('p', { text: holidays.line, testId: 'holidays-current' }));

  const version = document.createElement('input');
  version.type = 'text';
  version.placeholder = 'A name for the new version';
  version.disabled = !holidays.editable;
  version.dataset['testid'] = 'holiday-version';
  block.append(version);

  const dates = document.createElement('textarea');
  dates.value = holidays.dates.join('\n');
  dates.disabled = !holidays.editable;
  dates.dataset['testid'] = 'holiday-dates';
  block.append(dates);

  const save = element('button', { text: 'Replace calendar' });
  save.dataset['testid'] = 'holidays-save';
  (save as HTMLButtonElement).disabled = !holidays.editable;
  save.addEventListener('click', () => {
    apply(
      bridge().recordHolidayCalendar({
        version: version.value,
        dates: dates.value
          .split('\n')
          .map(line => line.trim())
          .filter(line => line.length > 0),
      }),
    );
  });
  block.append(save);

  if (holidays.notEditableBecause !== null) {
    block.append(element('p', { className: 'inert', text: holidays.notEditableBecause }));
  }
  root.append(block);
}

/**
 * G7-2's sending section: the authentication checklist, the per-mailbox cap, and the
 * personal-Gmail guard shown without a control.
 *
 * It is absent, not disabled, for anyone who is not an admin — `view.sendingAdmin`
 * is null — because every `/outbound/*` path answers a salesperson with a redacted
 * 403 and an inert control that exists only to be refused teaches nothing.
 *
 * The checkboxes are four separate facts because the command is: 12.7's checklist is
 * a person recording that they looked, and FSS never queries DNS. The enable is a
 * fifth, and `sending_domains` has a CHECK that refuses it without the other four —
 * the page does not pre-empt that refusal, it shows it.
 */
function renderSendingAdmin(root: HTMLElement, view: ReturnType<typeof adminViewOf>): void {
  const section = view.sendingAdmin;
  if (section === null) return;

  const block = element('section', { className: 'sending-admin', testId: 'sending-admin' });
  block.append(element('h2', { text: 'Sending domain and caps' }));
  block.append(element('p', { text: section.domainLine, testId: 'sending-domain' }));
  block.append(element('p', { className: 'inert', text: section.guard.line, testId: 'sending-guard' }));
  block.append(element('p', { className: 'inert', text: section.guard.readOnlyBecause }));

  if (section.domain !== null) {
    const domain = section.domain;
    const boxes = (['spfPass', 'dkimPass', 'dmarcPass', 'postmasterReviewed', 'automatedSendingEnabled'] as const).map(
      name => {
        const label = element('label', { text: name });
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.disabled = !section.editable;
        box.dataset['testid'] = `sending-${name}`;
        label.prepend(box);
        block.append(label);
        return [name, box] as const;
      },
    );

    const record = element('button', { text: 'Record checklist' });
    record.dataset['testid'] = 'sending-record';
    (record as HTMLButtonElement).disabled = !section.editable;
    record.addEventListener('click', () => {
      const flag = (name: string): boolean => boxes.find(entry => entry[0] === name)?.[1].checked === true;
      apply(
        bridge().recordSendingAuthentication({
          domain,
          spfPass: flag('spfPass'),
          dkimPass: flag('dkimPass'),
          dmarcPass: flag('dmarcPass'),
          postmasterReviewed: flag('postmasterReviewed'),
          automatedSendingEnabled: flag('automatedSendingEnabled'),
        }),
      );
    });
    block.append(record);
  }

  const ramps = element('ul', { className: 'ramps', testId: 'ramps' });
  for (const ramp of section.ramps) {
    const item = element('li', { text: ramp.line });
    item.dataset['testid'] = `ramp-${ramp.mailboxId}`;

    const amount = document.createElement('input');
    amount.type = 'number';
    amount.disabled = !ramp.editable;
    amount.dataset['testid'] = `cap-${ramp.mailboxId}`;
    item.append(amount);

    for (const [label, key] of [
      ['Lower to', 'lowerTo'],
      ['Raise to', 'raiseTo'],
    ] as const) {
      const button = element('button', { text: label });
      button.dataset['testid'] = `${key}-${ramp.mailboxId}`;
      (button as HTMLButtonElement).disabled = !ramp.editable;
      button.addEventListener('click', () => {
        const value = Number.parseInt(amount.value, 10);
        if (!Number.isInteger(value)) {
          amount.setAttribute('aria-invalid', 'true');
          return;
        }
        // The bounds are 12.7's and the server's. Nothing is clamped here: a raise
        // above 75 must come back as a refusal an admin reads, not a silent 75.
        apply(bridge().setSendingCap({ mailboxId: ramp.mailboxId, [key]: value }));
      });
      item.append(button);
    }
    ramps.append(item);
  }
  block.append(ramps);
  root.append(block);
}

function renderPanels(root: HTMLElement, view: ReturnType<typeof adminViewOf>): void {
  const panels = element('div', { className: 'panels', testId: 'panels' });
  for (const panel of view.panels) {
    const section = element('section', { className: 'panel' });
    section.dataset['testid'] = `panel-${panel.title.toLowerCase().replaceAll(' ', '-')}`;
    section.append(element('h2', { text: panel.title }));
    if (panel.unavailable !== null) {
      // Not zero. "Nothing can tell you how many" and "none" are different sentences.
      section.append(element('p', { className: 'unavailable', text: panel.unavailable }));
    }
    for (const line of panel.lines) section.append(element('p', { text: line }));
    panels.append(section);
  }
  root.append(panels);

  if (view.screen === 'diagnostics') {
    const alerts = element('ul', { className: 'alerts', testId: 'alerts' });
    for (const alert of view.alerts) {
      const item = element('li', { text: alert.label });
      item.dataset['testid'] = `alert-${alert.alertId}`;
      if (alert.runbookPath !== null) {
        item.append(element('span', { className: 'runbook', text: alert.runbookPath }));
      }
      if (alert.acknowledgeable) {
        const button = element('button', { text: 'Acknowledge' });
        button.dataset['testid'] = `acknowledge-${alert.alertId}`;
        button.addEventListener('click', () => {
          apply(bridge().acknowledgeAlert({ alertId: alert.alertId }));
        });
        item.append(button);
      }
      alerts.append(item);
    }
    root.append(alerts);
  }
}

/** The window's entry point. Guarded so importing this module in a test is inert. */
if (typeof document !== 'undefined' && document.querySelector('#app') !== null) {
  apply(bridge().state());
}
