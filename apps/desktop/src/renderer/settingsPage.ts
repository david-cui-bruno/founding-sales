import { localParts } from '@fss/contracts';
import { element } from './firmDom.ts';
import { POSTURES_HEADING, POSTURE_HINT, postureFormIssues, type PosturesSectionView } from './postureView.ts';
import { adminViewOf } from './settingsView.ts';
import type { AdminBridge, AdminScreen, AdminState, RecordPostureInput } from './settingsContract.ts';

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

/**
 * One slice's history, under the setting it belongs to (lane g78, D04): what is in
 * force now, then each version with the note, and the value it changed from and to.
 * Before g78 the History button fetched the versions and nothing drew them.
 */
function renderHistory(root: HTMLElement, history: NonNullable<ReturnType<typeof adminViewOf>['history']>): void {
  const block = element('section', { className: 'setting-history', testId: 'setting-history' });
  block.append(element('h3', { text: history.heading }));
  block.append(element('p', { text: history.currentLine, testId: 'history-current' }));
  const versions = element('ol', { className: 'history-versions' });
  for (const entry of history.versions) {
    const item = element('li', { className: entry.current ? 'history-version current' : 'history-version' });
    item.dataset['testid'] = 'history-version';
    item.append(element('p', { text: entry.line, testId: 'history-line' }));
    item.append(element('p', { className: 'inert', text: `From ${entry.from}`, testId: 'history-from' }));
    item.append(element('p', { text: `To ${entry.to}`, testId: 'history-to' }));
    versions.append(item);
  }
  block.append(versions);
  root.append(block);
}

function renderSettings(root: HTMLElement, view: ReturnType<typeof adminViewOf>): void {
  // First, because it is the one setting without which Today cannot call anybody.
  renderCallingNumber(root, view);
  // Second, for the same reason: 9.2 step 6 refuses every call to a state without one.
  renderPostures(root, view.postures, view.notice);

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
    if (view.history !== null && view.history.settingKey === row.settingKey) {
      renderHistory(item, view.history);
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
    elsewhere.append(
      element('li', {
        text:
          entry.editedHere === null
            ? `${entry.topic} — ${entry.path} (${entry.ownedBy})`
            : `${entry.topic} — edited on this page, under ${entry.editedHere}`,
      }),
    );
  }
  root.append(elsewhere);
}

/**
 * "Your calling number" (9.1; lane g60).
 *
 * Every role sees it: the number is the person's own, and 9.2 refuses a dial from
 * anybody else's. Adding a number and attesting it are one press when the statement is
 * ticked, and two commands underneath — the bridge sends the registration, then the
 * attestation — because the server keeps a claim and a statement about it apart.
 *
 * The statement box starts unticked. It is the whole of version one's verification
 * (`docs/decisions/g60-calling-identities-are-attested-in-version-one.md`), so it is
 * something the person does, never something the page does for them. The number goes
 * as typed; the server's `number_invalid` comes back as the notice.
 */
function renderCallingNumber(root: HTMLElement, view: ReturnType<typeof adminViewOf>): void {
  const section = view.callingNumber;
  const block = element('section', { className: 'calling-number', testId: 'calling-number' });
  block.append(element('h2', { text: 'Your calling number' }));
  block.append(element('p', { text: section.summary, testId: 'calling-number-summary' }));

  const list = element('ul', { className: 'calling-numbers', testId: 'calling-numbers' });
  for (const number of section.numbers) {
    const item = element('li', { text: number.line });
    item.dataset['testid'] = `calling-number-${number.id}`;
    item.dataset['status'] = number.status;
    if (number.canAttest) {
      const attest = element('button', { text: `Attest: ${section.statement}` });
      attest.dataset['testid'] = `calling-number-attest-${number.id}`;
      attest.addEventListener('click', () => {
        apply(bridge().attestCallingNumber({ identityId: number.id }));
      });
      item.append(attest);
    }
    if (number.canRetire) {
      const retire = element('button', { text: 'Stop using this number' });
      retire.dataset['testid'] = `calling-number-retire-${number.id}`;
      retire.addEventListener('click', () => {
        apply(bridge().retireCallingNumber({ identityId: number.id }));
      });
      item.append(retire);
    }
    list.append(item);
  }
  block.append(list);

  const number = document.createElement('input');
  number.type = 'tel';
  number.placeholder = '+1 401 555 0123';
  number.disabled = !section.canAdd;
  number.dataset['testid'] = 'calling-number-e164';
  block.append(number);

  const label = document.createElement('input');
  label.type = 'text';
  label.placeholder = 'A name for it, such as Mobile (optional)';
  label.maxLength = 80;
  label.disabled = !section.canAdd;
  label.dataset['testid'] = 'calling-number-label';
  block.append(label);

  const statement = element('label', { text: section.statement });
  const attested = document.createElement('input');
  attested.type = 'checkbox';
  attested.disabled = !section.canAdd;
  attested.dataset['testid'] = 'calling-number-attested';
  statement.prepend(attested);
  block.append(statement);

  const add = element('button', { text: 'Add number' });
  add.dataset['testid'] = 'calling-number-add';
  (add as HTMLButtonElement).disabled = !section.canAdd;
  add.addEventListener('click', () => {
    if (number.value.trim() === '') {
      number.setAttribute('aria-invalid', 'true');
      return;
    }
    apply(bridge().addCallingNumber({ e164: number.value, label: label.value, attested: attested.checked }));
  });
  block.append(add);

  block.append(element('p', { className: 'hint', text: section.hint }));
  if (section.notEditableBecause !== null) {
    block.append(element('p', { className: 'inert', text: section.notEditableBecause }));
  }
  root.append(block);
}

/**
 * What the posture form last sent, kept so a refused form comes back filled in: every
 * answer redraws the page, and a form redrawn empty would make the person tick the four
 * statements again. Forgotten once a posture is recorded.
 */
let postureDraft: RecordPostureInput | null = null;

/** Today's date in the business zone, as `YYYY-MM-DD`, for the form's first value. */
function todayIn(zone: string): string {
  try {
    return localParts(Date.now(), zone).date;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/**
 * State postures (9.2 step 6, 10.1; lane g84, audit item G04).
 *
 * Settings used to print `/postures — G4 policy` here, and a call to a state without a
 * posture was refused with nothing on the Mac that could record one. This is the form:
 * the state, the day it takes effect and when to review it, the statements
 * `statePosture.ts` asks the founder to confirm — in its words, read from the API — the
 * rule quoted for the state where the release carries one, and a note. It sends the same
 * command the path named. What the form checks first is what the server would refuse;
 * the server still decides, and its refusal is the notice.
 *
 * The recorded postures are listed above it with Revoke; the JSON the API answered is
 * behind "Show as JSON", which is where the raw view went.
 */
function renderPostures(root: HTMLElement, section: PosturesSectionView | null, notice: string | null): void {
  if (section === null) return;
  if (notice === 'Posture recorded.') postureDraft = null;
  const block = element('section', { className: 'postures', testId: 'postures' });
  block.append(element('h2', { text: POSTURES_HEADING }));
  block.append(element('p', { text: section.summary, testId: 'postures-summary' }));

  if (section.unread !== null) {
    block.append(element('p', { className: 'inert', text: section.unread, testId: 'postures-unread' }));
    const retry = element('button', { text: 'Retry' });
    retry.dataset['testid'] = 'postures-retry';
    retry.addEventListener('click', () => {
      apply(bridge().show({ screen: 'settings' }));
    });
    block.append(retry);
  }

  const rows = element('ul', { className: 'rows', testId: 'posture-rows' });
  for (const row of section.rows) {
    const item = element('li', { testId: 'posture-row' });
    item.dataset['state'] = row.state;
    const line = element('div', { className: 'row' });
    const main = element('div', { className: 'row-main' });
    main.append(element('span', { className: 'name', text: row.line, testId: 'posture-line' }));
    line.append(main);
    // One cell on the right, so the row stays the two columns `.row` lays out.
    const side = element('div', { className: 'row-side' });
    const tone = row.tag.tone === 'ok' ? 'tag tag-ok' : row.tag.tone === 'stop' ? 'tag tag-stop' : 'tag';
    if (row.canRevoke) {
      const actions = element('div', { className: 'row-actions' });
      const revoke = element('button', { text: 'Revoke' });
      revoke.dataset['testid'] = `posture-revoke-${row.id}`;
      revoke.addEventListener('click', () => {
        apply(bridge().revokePosture({ postureId: row.id }));
      });
      actions.append(revoke);
      side.append(actions);
    }
    side.append(element('span', { className: tone, text: row.tag.text, testId: 'posture-status' }));
    line.append(side);
    item.append(line);
    rows.append(item);
  }
  block.append(rows);

  const form = element('div', { className: 'capture posture-form', testId: 'posture-form' });
  form.append(element('h3', { text: 'Record a posture' }));
  const draft = postureDraft;

  const stateField = element('div', { className: 'field' });
  const stateLabel = element('label', { text: 'State' });
  stateLabel.htmlFor = 'posture-state';
  const state = element('select', { testId: 'posture-state' });
  state.id = 'posture-state';
  state.disabled = !section.editable;
  const none = element('option', { text: 'Choose a state' });
  none.value = '';
  state.append(none);
  for (const option of section.stateOptions) {
    const entry = element('option', { text: option.label });
    entry.value = option.value;
    state.append(entry);
  }
  state.value = draft?.state ?? '';
  stateField.append(stateLabel, state);
  form.append(stateField);

  // The rule quoted for the chosen state, verbatim, or a line saying the release has none.
  const rule = element('div', { className: 'posture-rule', testId: 'posture-rule' });
  const showRule = (): void => {
    rule.replaceChildren();
    if (state.value === '') return;
    const quoted = section.rules[state.value] ?? null;
    if (quoted === null) {
      rule.append(
        element('p', {
          text: 'This release quotes no rule for this state. Record a posture only after you, or counsel, have checked it.',
          testId: 'posture-rule-none',
        }),
      );
      return;
    }
    rule.append(element('p', { text: quoted.summary, testId: 'posture-rule-summary' }));
    for (const citation of quoted.citations) {
      rule.append(element('p', { className: 'quiet', text: `${citation.title} — ${citation.url}` }));
      rule.append(element('blockquote', { text: citation.quote }));
    }
  };
  state.addEventListener('change', showRule);
  showRule();
  form.append(rule);

  const dateField = (id: string, label: string, value: string, hint: string | null): HTMLInputElement => {
    const wrapper = element('div', { className: 'field' });
    const caption = element('label', { text: label });
    caption.htmlFor = id;
    const input = element('input', { testId: id });
    input.id = id;
    input.type = 'date';
    input.value = value;
    input.disabled = !section.editable;
    wrapper.append(caption, input);
    if (hint !== null) wrapper.append(element('p', { className: 'hint', text: hint }));
    form.append(wrapper);
    return input;
  };
  const effectiveFrom = dateField('posture-effective-from', 'Takes effect', draft?.effectiveFromDate ?? todayIn(section.zone), null);
  const review = dateField(
    'posture-review',
    'Review by',
    draft?.reviewDate ?? '',
    'Leave empty for one year after it takes effect.',
  );

  const statements = element('div', { className: 'posture-statements', testId: 'posture-statements' });
  const boxes = section.statements.map(statement => {
    const label = element('label', { className: 'posture-statement' });
    const box = element('input', { testId: `posture-statement-${statement.key}` });
    box.type = 'checkbox';
    box.checked = draft?.confirmedStatements.includes(statement.key) ?? false;
    box.disabled = !section.editable;
    label.append(box, element('span', { text: statement.text }));
    statements.append(label);
    return [statement.key, box] as const;
  });
  form.append(statements);

  const noteField = element('div', { className: 'field' });
  const noteLabel = element('label', { text: 'Note (optional)' });
  noteLabel.htmlFor = 'posture-note';
  const note = element('textarea', { testId: 'posture-note' });
  note.id = 'posture-note';
  note.placeholder = 'Where you read it, or your registration number';
  note.maxLength = 1000;
  note.value = draft?.note ?? '';
  note.disabled = !section.editable;
  noteField.append(noteLabel, note);
  form.append(noteField);

  const issues = element('div', { className: 'posture-issues', testId: 'posture-issues' });
  form.append(issues);

  const actions = element('div', { className: 'form-actions' });
  const record = element('button', { className: 'btn btn-primary', text: 'Record posture' });
  record.dataset['testid'] = 'posture-record';
  (record as HTMLButtonElement).disabled = !section.editable;
  record.addEventListener('click', () => {
    const input: RecordPostureInput = {
      state: state.value,
      effectiveFromDate: effectiveFrom.value,
      reviewDate: review.value,
      confirmedStatements: boxes.filter(([, box]) => box.checked).map(([key]) => key),
      note: note.value,
    };
    const found = postureFormIssues(input, {
      statementCount: section.statements.length,
      records: section.recordsForCheck,
      zone: section.zone,
    });
    issues.replaceChildren();
    for (const control of [state, effectiveFrom, review, note]) control.removeAttribute('aria-invalid');
    if (found.length > 0) {
      for (const issue of found) {
        issues.append(element('p', { className: 'field-issue', text: issue.text, testId: `posture-issue-${issue.field}` }));
        const control =
          issue.field === 'state' ? state : issue.field === 'effectiveFrom' ? effectiveFrom : issue.field === 'reviewDate' ? review : issue.field === 'note' ? note : null;
        control?.setAttribute('aria-invalid', 'true');
      }
      return;
    }
    postureDraft = input;
    apply(bridge().recordPosture(input));
  });
  actions.append(record);
  form.append(actions);
  form.append(element('p', { className: 'hint', text: POSTURE_HINT }));
  if (section.notEditableBecause !== null) {
    form.append(element('p', { className: 'inert', text: section.notEditableBecause, testId: 'posture-inert' }));
  }
  block.append(form);

  const json = element('details', { className: 'postures-json', testId: 'postures-json' });
  json.append(element('summary', { text: 'Show as JSON' }), element('pre', { text: section.json, testId: 'postures-json-body' }));
  block.append(json);
  root.append(block);
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
  if (view.sendingUnread !== null) {
    renderSendingUnread(root, view.sendingUnread.line);
    return;
  }
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

/**
 * The sending section when its read failed (lane g69): the heading, one grey line with
 * the code, and Retry. Retry is the Settings tab pressed again — `show` re-reads the
 * settings, the sending posture and the calling numbers — so it needs no channel of
 * its own.
 */
function renderSendingUnread(root: HTMLElement, line: string): void {
  const block = element('section', { className: 'sending-admin', testId: 'sending-admin' });
  block.append(element('h2', { text: 'Sending domain and caps' }));
  block.append(element('p', { className: 'inert', text: line, testId: 'sending-unread' }));
  const retry = element('button', { text: 'Retry' });
  retry.dataset['testid'] = 'sending-retry';
  retry.addEventListener('click', () => {
    apply(bridge().show({ screen: 'settings' }));
  });
  block.append(retry);
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

/**
 * The screen the window was opened on, when its opener named one (lane g65).
 *
 * The Window menu's ⌘5 opens `settings.html?screen=settings` and ⌘6
 * `settings.html?screen=dashboard`; Home's sidebar calls the same openers. Anything
 * else, including no query at all, is the screen the bridge last showed.
 */
export function requestedScreen(search: string): AdminScreen | null {
  const screen = new URLSearchParams(search).get('screen');
  return screen === 'settings' || screen === 'dashboard' || screen === 'diagnostics' ? screen : null;
}

/** The window's entry point. Guarded so importing this module in a test is inert. */
if (typeof document !== 'undefined' && document.querySelector('#app') !== null) {
  const screen = requestedScreen(location.search);
  apply(screen === null ? bridge().state() : bridge().show({ screen }));
}
