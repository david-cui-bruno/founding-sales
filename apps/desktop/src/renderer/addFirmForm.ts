import { button, element } from './firmDom.ts';
import { ADD_FIRM_FIELDS, TIME_ZONE_CHOICES, addFirmSubmittable, fieldIssues, issueSentence } from './captureView.ts';
import type { AddFirmDraft, AddFirmView } from './firmWorkspaceContract.ts';

/**
 * The Add firm form (lane g84, audit item G02).
 *
 * The smallest complete way to get one firm in: its name, its website and its time zone,
 * and optionally the first person there with their title, email and phone. One press
 * sends one command, and the firm, the person and their address and number land together
 * or not at all. A firm added here is assigned to the person who added it and appears on
 * the pipeline under "Not in the pipeline yet"; its address and number are candidates
 * until they are verified, like every route nobody has checked (7.4).
 *
 * The form is drawn from the bridge's state every time, including after a refusal: the
 * values come back in `view.draft`, and every field the server named carries its sentence
 * underneath and `aria-invalid`. Nothing is validated here but the one thing the button
 * can see for itself — a firm with no name.
 */

export interface AddFirmFormOptions {
  readonly view: AddFirmView;
  readonly actionsEnabled: boolean;
  readonly onSubmit: (draft: AddFirmDraft) => void;
  readonly onCancel: () => void;
  readonly onOpenFirm: (firmId: string) => void;
}

type DraftKey = keyof AddFirmDraft;

export function renderAddFirmForm(root: HTMLElement, options: AddFirmFormOptions): void {
  const { view } = options;
  const form = element('form', { className: 'capture add-firm', testId: 'add-firm-form' });
  form.noValidate = true;
  const inputs = new Map<DraftKey, HTMLInputElement | HTMLSelectElement>();

  const field = (parent: HTMLElement, spec: (typeof ADD_FIRM_FIELDS)[number]): void => {
    const wrapper = element('div', { className: 'field' });
    const id = `add-firm-${spec.key}`;
    const label = element('label', { text: spec.label });
    label.htmlFor = id;
    const input = element('input', { testId: id });
    input.id = id;
    input.type = spec.key === 'contactEmail' ? 'email' : spec.key === 'contactPhone' ? 'tel' : 'text';
    input.value = view.draft[spec.key];
    input.maxLength = spec.maxLength;
    input.autocomplete = 'off';
    input.disabled = !options.actionsEnabled;
    if (spec.placeholder !== '') input.placeholder = spec.placeholder;
    wrapper.append(label, input);
    const issues = fieldIssues(view, spec.column);
    if (issues.length > 0) {
      input.setAttribute('aria-invalid', 'true');
      for (const sentence of issues) {
        wrapper.append(element('p', { className: 'field-issue', text: sentence, testId: `issue-${spec.column}` }));
      }
    }
    inputs.set(spec.key, input);
    parent.append(wrapper);
  };

  const firm = element('fieldset');
  firm.append(element('legend', { text: 'Firm' }));
  for (const spec of ADD_FIRM_FIELDS.slice(0, 2)) field(firm, spec);

  const zoneWrapper = element('div', { className: 'field' });
  const zoneLabel = element('label', { text: 'Time zone' });
  zoneLabel.htmlFor = 'add-firm-timeZone';
  const zone = element('select', { testId: 'add-firm-timeZone' });
  zone.id = 'add-firm-timeZone';
  zone.disabled = !options.actionsEnabled;
  for (const choice of TIME_ZONE_CHOICES) {
    const option = element('option', { text: choice.label });
    option.value = choice.value;
    zone.append(option);
  }
  // A zone the list does not name, from a draft the server refused, is still shown.
  if (!TIME_ZONE_CHOICES.some(choice => choice.value === view.draft.timeZone)) {
    const option = element('option', { text: view.draft.timeZone });
    option.value = view.draft.timeZone;
    zone.append(option);
  }
  zone.value = view.draft.timeZone;
  zoneWrapper.append(zoneLabel, zone);
  const zoneIssues = fieldIssues(view, 'time_zone');
  if (zoneIssues.length > 0) zone.setAttribute('aria-invalid', 'true');
  for (const sentence of zoneIssues) {
    zoneWrapper.append(element('p', { className: 'field-issue', text: sentence, testId: 'issue-time_zone' }));
  }
  inputs.set('timeZone', zone);
  firm.append(zoneWrapper);
  form.append(firm);

  const contact = element('fieldset');
  contact.append(element('legend', { text: 'First contact (optional)' }));
  for (const spec of ADD_FIRM_FIELDS.slice(2)) field(contact, spec);
  form.append(contact);

  const draft = (): AddFirmDraft => {
    const value = (key: DraftKey): string => inputs.get(key)?.value ?? '';
    return {
      name: value('name'),
      website: value('website'),
      timeZone: value('timeZone'),
      contactName: value('contactName'),
      contactTitle: value('contactTitle'),
      contactEmail: value('contactEmail'),
      contactPhone: value('contactPhone'),
    };
  };

  const actions = element('div', { className: 'form-actions' });
  const submit = button('Add firm', 'add-firm-submit', options.actionsEnabled);
  submit.type = 'submit';
  submit.className = 'btn btn-primary';
  const cancel = button('Cancel', 'add-firm-cancel', true);
  cancel.className = 'btn btn-quiet';
  cancel.addEventListener('click', () => {
    options.onCancel();
  });
  actions.append(submit, cancel);
  if (view.duplicateFirmId !== null) {
    const duplicate = view.duplicateFirmId;
    const open = button('Open the firm already here', 'add-firm-open-duplicate', true);
    open.addEventListener('click', () => {
      options.onOpenFirm(duplicate);
    });
    actions.append(open);
  }
  form.append(actions);

  form.addEventListener('submit', event => {
    event.preventDefault();
    const values = draft();
    const name = inputs.get('name');
    if (!addFirmSubmittable(values.name, options.actionsEnabled)) {
      // Said here without asking the server: the one fault the form can see for itself.
      if (name instanceof HTMLInputElement && name.getAttribute('aria-invalid') !== 'true') {
        name.setAttribute('aria-invalid', 'true');
        name.parentElement?.append(
          element('p', { className: 'field-issue', text: issueSentence('firm_name_missing'), testId: 'issue-firm_name' }),
        );
      }
      return;
    }
    options.onSubmit(values);
  });

  root.append(form);
}
