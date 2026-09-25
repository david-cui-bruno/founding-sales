import { SENDING_STOP_LINE, TEMPLATE_VARIABLE_NAMES } from '@fss/contracts';
import { button, element } from './firmDom.ts';
import type {
  DraftStep,
  SequenceBridge,
  SequenceReadSlice,
  SequenceState,
  SequenceVersion,
  TemplateDraft,
  TemplateVersion,
} from './sequenceContract.ts';
import {
  CHANNEL_LABELS,
  EDITOR_CHANNELS,
  EMPTY_SEQUENCE_STATE,
  NO_ANSWER_LABELS,
  draftChanged,
  draftIssues,
  draftStepsOf,
  moveStep,
  newStep,
  removeStep,
  replaceStep,
  sequenceScreen,
  suggestedPlan,
  templateFormIssues,
  typedBodyOf,
  type VersionPanel,
} from './sequenceView.ts';

/**
 * The sequence editor window (specification 11.1, 11.3, 4.3, 14.2).
 *
 * A fourth entry point beside G2's sign-in page, G3b's firm workspace and G6's Today
 * page, and built the same way: every value reaches the DOM through `textContent`, so
 * a template body containing a tag is a template body; every decision comes from
 * `sequenceView.ts`, so a control that is shown and a control that works cannot
 * disagree; and the page holds no rule of its own.
 *
 * Since lane g88 it is where a founder authors: New sequence (the sequence and its
 * empty draft), a template form that appends the sign-off and stop line itself, typed
 * step controls held here until Save draft, the suggested plan as a fill rather than a
 * sequence, and Publish only once the draft on screen is the draft saved. "Review and
 * resume" opens the dates a resume would give the steps, and only "Resume with these
 * dates" resumes (docs/decisions/g88-founder-authoring-and-review.md).
 *
 * Refusals are rendered rather than hidden, because a disabled button with no
 * explanation is the worst of both:
 *
 *   * a draft that cannot be published says which reason applies;
 *   * a template that cannot be approved lists every issue the server named (12.6);
 *   * a LinkedIn handoff says "FSS does not know whether it was sent", because 11.3
 *     says the system never claims otherwise.
 *
 * Content hashes, footers and stop-condition codes are behind "Details".
 */

const PUBLISH_REFUSAL_SENTENCES: Readonly<Record<string, string>> = Object.freeze({
  version_has_no_steps: 'Add at least one step before publishing.',
  ordinals_not_contiguous: 'The steps are numbered with a gap. Renumber them 1, 2, 3.',
  email_step_needs_approved_template: 'An email step names a template version that is not approved.',
  not_a_draft: 'Only a draft can be published. Editing a published version creates a new draft.',
  admin_only: 'Publishing a sequence is an administrator action.',
  offline: 'Offline. Nothing can be published until the connection comes back.',
});

const bridge = (): SequenceBridge => {
  const value = globalThis.callieSequences;
  if (value === undefined) throw new Error('the Callie sequences bridge is not present');
  return value;
};

let lastState: SequenceState = EMPTY_SEQUENCE_STATE;

/**
 * The draft being edited (lane g88), kept between renders: every answer redraws the page,
 * and an editor redrawn from the server's copy would drop what was being typed. It is
 * forgotten once saved, or when the draft it belongs to is no longer on screen.
 */
let editing: { readonly versionId: string; readonly steps: readonly DraftStep[] } | null = null;

/** The template form, while open (lane g88). Null is closed. */
let templateForm: TemplateDraft | null = null;

function apply(next: Promise<SequenceState>, after?: (state: SequenceState) => void): void {
  void (async () => {
    const state = await next;
    after?.(state);
    render(state);
  })();
}

/** Redraw from the last answer, after a change only this window knows about. */
function redraw(): void {
  render(lastState);
}

function renderSequences(root: HTMLElement, screen: ReturnType<typeof sequenceScreen>): void {
  const heading = element('h2', { className: 'section-head' });
  heading.append(element('span', { text: 'Sequences' }), element('small', { text: String(screen.sequences.length) }));
  root.append(heading);
  const list = element('ul', { className: 'sequence-list', testId: 'sequence-list' });
  for (const entry of screen.sequences) {
    const item = element('li', { className: entry.selected ? 'sequence selected' : 'sequence' });
    item.dataset['testid'] = 'sequence';
    item.append(element('span', { className: 'name', text: entry.name, testId: 'sequence-name' }));
    const open = button('Open', 'sequence-open', true);
    open.addEventListener('click', () => {
      apply(bridge().openSequence({ sequenceId: entry.id }));
    });
    item.append(open);
    list.append(item);
  }
  root.append(list);
  if (screen.sequences.length === 0) {
    root.append(element('p', { className: 'empty', testId: 'sequence-empty', text: 'No sequences yet. Name your first one below.' }));
  }
  renderNewSequence(root, screen.canAuthor);
}

/** "New sequence" (lane g88): a name, and the bridge creates the sequence and its first draft. */
function renderNewSequence(root: HTMLElement, enabled: boolean): void {
  const form = element('form', { className: 'toolbar', testId: 'new-sequence' });
  const name = element('input', { testId: 'new-sequence-name' });
  name.type = 'text';
  name.placeholder = 'Name a new sequence';
  name.maxLength = 200;
  name.autocomplete = 'off';
  name.disabled = !enabled;
  const create = button('New sequence', 'new-sequence-create', enabled);
  create.type = 'submit';
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (name.value.trim() === '') {
      name.setAttribute('aria-invalid', 'true');
      return;
    }
    editing = null;
    apply(bridge().createSequence({ name: name.value.trim() }));
  });
  form.append(name, create);
  root.append(form);
}

/** A version's stop conditions: one sentence, and the codes behind a disclosure. */
function renderStops(section: HTMLElement, panel: VersionPanel): void {
  section.append(element('p', { className: 'stop-conditions', testId: 'version-stops', text: panel.stopSentence }));
  const details = element('details', { className: 'version-details', testId: 'version-details' });
  details.append(element('summary', { text: 'Details' }));
  details.append(element('p', { className: 'inert', text: `Stop conditions: ${panel.stopConditions.join(', ')}` }));
  section.append(details);
}

/** The steps of a version nobody is editing: published, retired, or a draft this person may not change. */
function renderReadOnlySteps(section: HTMLElement, panel: VersionPanel): void {
  const steps = element('ol', { className: 'steps', testId: 'version-steps' });
  for (const step of panel.steps) {
    const item = element('li', { className: 'step' });
    item.dataset['testid'] = 'step';
    item.append(element('span', { className: 'channel', text: step.channel, testId: 'step-channel' }));
    item.append(element('span', { className: 'delay', text: step.delayLabel, testId: 'step-delay' }));
    item.append(element('span', { className: 'detail', text: step.detail, testId: 'step-detail' }));
    if (step.problem !== null) {
      item.append(element('span', { className: 'problem', text: step.problem, testId: 'step-problem' }));
    }
    steps.append(item);
  }
  section.append(steps);
}

function templateLabel(template: TemplateVersion): string {
  const state = template.retiredAt !== null ? ' (retired)' : template.approvedAt === null ? ' (not approved yet)' : '';
  return `${template.name} v${String(template.version)}${state}`;
}

/** One select with its label, the value chosen and a callback with the new value. */
function select(
  testId: string,
  options: readonly { readonly value: string; readonly label: string; readonly disabled?: boolean }[],
  value: string,
  onChange: (value: string) => void,
): HTMLSelectElement {
  const node = element('select', { testId });
  for (const option of options) {
    const entry = element('option', { text: option.label });
    entry.value = option.value;
    entry.disabled = option.disabled === true;
    node.append(entry);
  }
  node.value = value;
  node.addEventListener('change', () => {
    onChange(node.value);
  });
  return node;
}

/**
 * The step editor (lane g88, audit G03): every step of the draft as typed controls — its
 * channel, when it is due, the template an email sends or what a call does when nobody
 * answers — with up, down and remove on hover, and Add call / Add email below. Nothing is
 * sent until Save draft; Publish publishes what was saved.
 */
function renderDraftEditor(
  section: HTMLElement,
  panel: VersionPanel,
  version: SequenceVersion,
  state: SequenceState,
): readonly DraftStep[] {
  if (editing?.versionId !== version.id) editing = { versionId: version.id, steps: draftStepsOf(version) };
  const steps = editing.steps;
  const update = (next: readonly DraftStep[]): void => {
    editing = { versionId: version.id, steps: next };
    redraw();
  };

  const list = element('ol', { className: 'steps rows', testId: 'version-steps' });
  steps.forEach((step, index) => {
    const item = element('li', { className: 'step' });
    item.dataset['testid'] = 'step';
    const row = element('div', { className: 'row' });
    const main = element('div', { className: 'row-main step-fields' });
    main.append(element('span', { className: 'name', text: `Step ${String(index + 1)}`, testId: 'step-number' }));

    const channels = EDITOR_CHANNELS.map(channel => ({ value: channel, label: CHANNEL_LABELS[channel] }));
    // A LinkedIn step copied from an old version is shown for what it is, and can only be removed.
    const channelOptions =
      step.channel === 'linkedin_task' ? [...channels, { value: 'linkedin_task', label: CHANNEL_LABELS.linkedin_task, disabled: true }] : channels;
    main.append(
      select('step-channel-select', channelOptions, step.channel, value => {
        if (value !== 'email' && value !== 'call_task') return;
        update(replaceStep(steps, index, { ...newStep(value, []), delay: step.delay }));
      }),
    );

    const amount = element('input', { testId: 'step-delay-amount' });
    amount.type = 'number';
    amount.min = '0';
    amount.max = step.delay.unit === 'elapsed' ? '8760' : '365';
    amount.step = '1';
    amount.value = String(step.delay.unit === 'elapsed' ? step.delay.hours : step.delay.days);
    amount.className = 'narrow';
    amount.addEventListener('change', () => {
      const value = Number(amount.value);
      update(
        replaceStep(steps, index, {
          ...step,
          delay: step.delay.unit === 'elapsed' ? { unit: 'elapsed', hours: value } : { unit: 'business_days', days: value },
        }),
      );
    });
    main.append(amount);
    main.append(
      select(
        'step-delay-unit',
        [
          { value: 'business_days', label: 'business days after enrollment' },
          { value: 'elapsed', label: 'hours after enrollment' },
        ],
        step.delay.unit,
        value => {
          const current = step.delay.unit === 'elapsed' ? step.delay.hours : step.delay.days;
          update(
            replaceStep(steps, index, {
              ...step,
              delay: value === 'elapsed' ? { unit: 'elapsed', hours: current } : { unit: 'business_days', days: current },
            }),
          );
        },
      ),
    );

    if (step.channel === 'email') {
      const templates = state.templates.filter(template => template.retiredAt === null || template.id === step.templateVersionId);
      main.append(
        select(
          'step-template',
          [{ value: '', label: 'Choose a template…' }, ...templates.map(template => ({ value: template.id, label: templateLabel(template) }))],
          step.templateVersionId ?? '',
          value => {
            update(replaceStep(steps, index, { ...step, templateVersionId: value === '' ? null : value }));
          },
        ),
      );
    }
    if (step.channel === 'call_task') {
      main.append(
        select(
          'step-no-answer',
          (['advance', 'retry_call'] as const).map(value => ({ value, label: NO_ANSWER_LABELS[value] })),
          step.onNoAnswer ?? 'advance',
          value => {
            if (value !== 'advance' && value !== 'retry_call') return;
            update(replaceStep(steps, index, { ...step, onNoAnswer: value }));
          },
        ),
      );
    }
    const chosen = step.templateVersionId === null ? null : state.templates.find(template => template.id === step.templateVersionId);
    if (step.channel === 'email' && chosen !== undefined && chosen !== null && (chosen.approvedAt === null || chosen.retiredAt !== null)) {
      main.append(
        element('span', {
          className: 'why',
          testId: 'step-problem',
          text: chosen.retiredAt !== null ? 'That template is retired.' : 'Approve this template before publishing.',
        }),
      );
    }
    row.append(main);

    const actions = element('div', { className: 'row-actions' });
    const up = button('Move up', 'step-up', panel.editable && index > 0);
    up.className = 'btn-quiet';
    up.addEventListener('click', () => {
      update(moveStep(steps, index, -1));
    });
    const down = button('Move down', 'step-down', panel.editable && index < steps.length - 1);
    down.className = 'btn-quiet';
    down.addEventListener('click', () => {
      update(moveStep(steps, index, 1));
    });
    const remove = button('Remove', 'step-remove', panel.editable);
    remove.className = 'btn-quiet';
    remove.addEventListener('click', () => {
      update(removeStep(steps, index));
    });
    actions.append(up, down, remove);
    row.append(actions);
    item.append(row);
    list.append(item);
  });
  section.append(list);

  const add = element('div', { className: 'toolbar' });
  if (steps.length === 0) {
    const suggested = button('Start from the suggested plan', 'step-suggested', panel.editable);
    suggested.addEventListener('click', () => {
      update(suggestedPlan(state.templates));
    });
    add.append(suggested);
  }
  for (const channel of EDITOR_CHANNELS) {
    const adder = button(`Add ${CHANNEL_LABELS[channel].toLowerCase()}`, `step-add-${channel}`, panel.editable);
    adder.addEventListener('click', () => {
      update([...steps, newStep(channel, steps)]);
    });
    add.append(adder);
  }
  section.append(add);
  if (steps.length === 0) {
    section.append(
      element('p', {
        className: 'hint',
        testId: 'step-suggested-hint',
        text: 'The suggested plan is a call the day they are enrolled, an email two business days later, and a second call two business days after that. You can change every step before saving.',
      }),
    );
  }

  const issues = draftIssues(steps);
  const problems = element('div', { className: 'draft-issues', testId: 'draft-issues' });
  for (const issue of issues) problems.append(element('p', { className: 'field-issue', text: issue.text }));
  section.append(problems);

  const changed = draftChanged(version, steps);
  const actions = element('div', { className: 'form-actions' });
  const save = button('Save draft', 'draft-save', panel.editable && changed && issues.length === 0);
  save.className = 'btn-primary';
  save.addEventListener('click', () => {
    apply(bridge().saveDraft({ sequenceVersionId: version.id, steps }), answer => {
      if (answer.notice === 'draft_saved') editing = null;
    });
  });
  actions.append(save);
  if (changed) {
    const discard = button('Discard changes', 'draft-discard', true);
    discard.className = 'btn-quiet';
    discard.addEventListener('click', () => {
      editing = null;
      redraw();
    });
    actions.append(discard);
  }
  section.append(actions);
  return steps;
}

function renderVersions(root: HTMLElement, screen: ReturnType<typeof sequenceScreen>, state: SequenceState): void {
  const drafts = new Set(state.versions.filter(version => version.state === 'draft').map(version => version.id));
  if (editing !== null && !drafts.has(editing.versionId)) editing = null;

  for (const panel of screen.versions) {
    const version = state.versions.find(entry => entry.id === panel.id);
    const section = element('section', { className: 'version' });
    section.dataset['testid'] = 'version';
    section.append(element('h2', { text: panel.heading, testId: 'version-heading' }));
    renderStops(section, panel);

    let unsaved = false;
    if (panel.editable && version !== undefined) {
      const steps = renderDraftEditor(section, panel, version, state);
      unsaved = draftChanged(version, steps);
    } else {
      renderReadOnlySteps(section, panel);
    }

    const actions = element('div', { className: 'form-actions' });
    if (panel.state === 'draft') {
      const publish = button('Publish', 'version-publish', panel.canPublish && !unsaved);
      publish.addEventListener('click', () => {
        apply(bridge().publish({ sequenceVersionId: panel.id }));
      });
      actions.append(publish);
    }
    if (panel.canStartDraft) {
      const draft = button('Edit as a new draft', 'version-new-draft', true);
      draft.addEventListener('click', () => {
        apply(bridge().createDraft({ sequenceId: version?.sequenceId ?? state.selectedSequenceId ?? '' }));
      });
      actions.append(draft);
    }
    if (panel.state === 'published') {
      const retire = button('Retire', 'version-retire', panel.canRetire);
      retire.className = 'btn-quiet';
      retire.addEventListener('click', () => {
        apply(bridge().retire({ sequenceVersionId: panel.id }));
      });
      actions.append(retire);
    }
    section.append(actions);
    if (panel.state === 'draft' && unsaved) {
      section.append(element('p', { className: 'hint', testId: 'publish-unsaved', text: 'Save the draft before publishing it.' }));
    } else if (panel.publishRefusal !== null && panel.state === 'draft') {
      section.append(
        element('p', {
          className: 'refusal',
          testId: 'publish-refusal',
          text: PUBLISH_REFUSAL_SENTENCES[panel.publishRefusal] ?? panel.publishRefusal,
        }),
      );
    }
    root.append(section);
  }
}

function renderTemplates(root: HTMLElement, screen: ReturnType<typeof sequenceScreen>, state: SequenceState): void {
  const heading = element('h2', { className: 'section-head' });
  heading.append(element('span', { text: 'Templates' }), element('small', { text: String(screen.templates.length) }));
  root.append(heading);

  for (const panel of screen.templates) {
    const template = state.templates.find(entry => entry.id === panel.id);
    const section = element('section', { className: 'template' });
    section.dataset['testid'] = 'template';
    section.append(element('h3', { text: panel.label, testId: 'template-label' }));
    section.append(
      element('span', {
        className: panel.retired ? 'tag' : panel.approved ? 'tag tag-ok' : 'tag',
        text: panel.retired ? 'Retired' : panel.approved ? 'Approved' : 'Not approved',
        testId: 'template-status',
      }),
    );
    section.append(element('p', { className: 'subject', text: panel.subject, testId: 'template-subject' }));
    section.append(element('pre', { className: 'body', text: panel.body, testId: 'template-body' }));

    if (!panel.footerPresent) {
      section.append(
        element('p', {
          className: 'refusal',
          testId: 'template-problem',
          text: 'The body does not end with the approved footer block.',
        }),
      );
    }
    if (panel.unsubscribeMentioned) {
      section.append(
        element('p', {
          className: 'refusal',
          testId: 'template-problem',
          text: 'The text mentions an unsubscribe link. FSS uses reply-to-stop only.',
        }),
      );
    }

    const actions = element('div', { className: 'form-actions' });
    if (!panel.approved) {
      const approve = button('Approve', 'template-approve', panel.canApprove);
      approve.addEventListener('click', () => {
        apply(bridge().approveTemplate({ templateVersionId: panel.id }));
      });
      actions.append(approve);
    }
    if (template !== undefined && screen.canAuthor) {
      const next = button('New version', 'template-new-version', true);
      next.className = 'btn-quiet';
      next.addEventListener('click', () => {
        templateForm = {
          templateId: template.templateId,
          name: template.name,
          subject: template.subject,
          body: typedBodyOf(template),
          signOff: template.footerSignOff,
        };
        redraw();
      });
      actions.append(next);
    }
    section.append(actions);

    // 11.1 binds an approval to bytes, and the digest is there for whoever wants to read
    // it — behind the disclosure, with the footer block and the declared variables (G08).
    const details = element('details', { className: 'template-details', testId: 'template-details' });
    details.append(element('summary', { text: 'Details' }));
    details.append(element('p', { className: 'inert', text: 'Footer block:' }));
    details.append(element('pre', { className: 'footer', text: panel.footer, testId: 'template-footer' }));
    details.append(element('p', { className: 'inert', text: 'Content hash:' }));
    details.append(element('code', { className: 'hash', text: panel.contentHash, testId: 'template-hash' }));
    if (template !== undefined) {
      details.append(
        element('p', {
          className: 'inert',
          text: `Variables: ${template.requiredVariables.length === 0 ? 'none' : template.requiredVariables.join(', ')}`,
        }),
      );
    }
    section.append(details);
    root.append(section);
  }

  if (templateForm === null) {
    const open = button('New template', 'template-new', screen.canAuthor);
    open.addEventListener('click', () => {
      templateForm = { templateId: null, name: '', subject: '', body: '', signOff: '' };
      redraw();
    });
    const bar = element('div', { className: 'toolbar' });
    bar.append(open);
    root.append(bar);
    return;
  }
  renderTemplateForm(root, templateForm, screen.canAuthor);
}

/**
 * The template form (lane g88): a name, a subject, the email, and the sign-off. The stop
 * line is not typed: every email ends with the sign-off and then it, and the form shows
 * that ending under the body. Saving writes an unapproved version; Approve, on the
 * template, is the separate act 11.1 asks for.
 */
function renderTemplateForm(root: HTMLElement, draft: TemplateDraft, enabled: boolean): void {
  const form = element('form', { className: 'capture template-form', testId: 'template-form' });
  form.noValidate = true;
  form.append(element('h3', { text: draft.templateId === null ? 'New template' : 'New version of this template' }));
  let current = draft;
  const field = (
    key: 'name' | 'subject' | 'body' | 'signOff',
    label: string,
    multiline: boolean,
    hint: string | null,
  ): HTMLInputElement | HTMLTextAreaElement => {
    const wrapper = element('div', { className: 'field' });
    const id = `template-form-${key}`;
    const caption = element('label', { text: label });
    caption.htmlFor = id;
    const input = multiline ? element('textarea', { testId: id }) : element('input', { testId: id });
    if (input instanceof HTMLInputElement) {
      input.type = 'text';
      input.autocomplete = 'off';
    }
    input.id = id;
    input.value = current[key];
    input.disabled = !enabled;
    input.addEventListener('input', () => {
      current = { ...current, [key]: input.value };
      templateForm = current;
    });
    wrapper.append(caption, input);
    if (hint !== null) wrapper.append(element('p', { className: 'hint', text: hint }));
    form.append(wrapper);
    return input;
  };
  field('name', 'Name', false, null);
  field('subject', 'Subject', false, null);
  field(
    'body',
    'Email',
    true,
    `You can use ${TEMPLATE_VARIABLE_NAMES.map(name => `{${name}}`).join(', ')}. Plain text, one link at most, 89 words with the sign-off.`,
  );
  field('signOff', 'Sign-off', true, 'Your name, and anything that goes under it.');
  form.append(element('p', { className: 'hint', text: 'Every email ends with your sign-off and then:' }));
  form.append(element('blockquote', { text: SENDING_STOP_LINE, testId: 'template-stop-line' }));

  const issues = element('div', { className: 'template-issues', testId: 'template-issues' });
  form.append(issues);
  const actions = element('div', { className: 'form-actions' });
  const save = button('Save template', 'template-save', enabled);
  save.type = 'submit';
  save.className = 'btn-primary';
  const cancel = button('Cancel', 'template-cancel', true);
  cancel.className = 'btn-quiet';
  cancel.addEventListener('click', () => {
    templateForm = null;
    redraw();
  });
  actions.append(save, cancel);
  form.append(actions);

  form.addEventListener('submit', event => {
    event.preventDefault();
    const found = templateFormIssues(current);
    issues.replaceChildren();
    if (found.length > 0) {
      for (const issue of found) {
        issues.append(element('p', { className: 'field-issue', text: issue.text, testId: `template-issue-${issue.field}` }));
      }
      return;
    }
    const sent = current;
    apply(bridge().createTemplate(sent), answer => {
      if (answer.notice === 'template_created') templateForm = null;
    });
  });
  root.append(form);
}

function renderLinkedIn(root: HTMLElement, screen: ReturnType<typeof sequenceScreen>): void {
  const panel = screen.linkedIn;
  if (panel === null) return;
  const section = element('section', { className: 'linkedin' });
  section.dataset['testid'] = 'linkedin-card';
  section.append(element('h2', { text: panel.heading, testId: 'linkedin-heading' }));
  section.append(element('pre', { className: 'message', text: panel.message, testId: 'linkedin-message' }));
  section.append(element('p', { className: 'status', text: panel.statusLabel, testId: 'linkedin-status' }));

  const open = button('Open LinkedIn & copy message', 'linkedin-open', panel.canOpenAndCopy);
  open.addEventListener('click', () => {
    apply(bridge().completeLinkedIn({ stepExecutionId: panel.stepExecutionId }));
  });
  section.append(open);

  const undo = button('Undo', 'linkedin-undo', panel.canUndo);
  undo.addEventListener('click', () => {
    apply(bridge().undoLinkedIn({ stepExecutionId: panel.stepExecutionId }));
  });
  section.append(undo);

  const replied = button('They replied', 'linkedin-replied', panel.canRecordResult);
  replied.addEventListener('click', () => {
    apply(bridge().recordLinkedInResult({ enrollmentId: panel.enrollmentId, result: 'replied' }));
  });
  section.append(replied);

  const none = button('No engagement', 'linkedin-none', panel.canRecordResult);
  none.addEventListener('click', () => {
    apply(bridge().recordLinkedInResult({ enrollmentId: panel.enrollmentId, result: 'no_engagement' }));
  });
  section.append(none);
  root.append(section);
}

function renderHoldReview(root: HTMLElement, screen: ReturnType<typeof sequenceScreen>): void {
  if (screen.holdReview.length === 0) return;
  const section = element('section', { className: 'hold-review' });
  section.dataset['testid'] = 'hold-review';
  section.append(element('h2', { text: 'Enrollments waiting for review' }));
  for (const row of screen.holdReview) {
    const item = element('div', { className: 'hold' });
    item.dataset['testid'] = 'hold-row';
    item.append(element('p', { text: row.explanation, testId: 'hold-explanation' }));
    if (!row.reviewing) {
      // Opens the review. It never resumes: the review's own button is the only one that does.
      const review = button('Review and resume', 'hold-resume', row.canResume);
      review.addEventListener('click', () => {
        apply(bridge().reviewEnrollment({ enrollmentId: row.enrollmentId }));
      });
      item.append(review);
    }
    const review = screen.resumeReview;
    if (row.reviewing && review !== null) {
      const panel = element('div', { className: 'resume-review', testId: 'resume-review' });
      panel.append(element('h3', { text: review.heading }));
      panel.append(element('p', { text: review.summary, testId: 'resume-summary' }));
      if (review.holdLines.length > 0) {
        const holds = element('ul', { className: 'inert', testId: 'resume-holds' });
        for (const line of review.holdLines) holds.append(element('li', { text: line }));
        panel.append(holds);
      }
      const steps = element('ol', { className: 'rows', testId: 'resume-steps' });
      for (const step of review.steps) {
        const entry = element('li', { testId: 'resume-step' });
        const line = element('div', { className: 'row' });
        const main = element('div', { className: 'row-main' });
        main.append(element('span', { className: 'name', text: step.label, testId: 'resume-step-label' }));
        main.append(
          element('span', {
            className: 'why',
            testId: 'resume-step-dates',
            text: step.moved ? `${step.from} → ${step.to}` : `${step.to} (unchanged)`,
          }),
        );
        line.append(main);
        entry.append(line);
        steps.append(entry);
      }
      panel.append(steps);
      panel.append(element('p', { className: 'hint', text: review.zoneLine }));
      const actions = element('div', { className: 'form-actions' });
      const confirm = button(review.confirmLabel, 'resume-confirm', review.canConfirm);
      confirm.className = 'btn-primary';
      confirm.addEventListener('click', () => {
        apply(bridge().resumeEnrollment({ enrollmentId: review.enrollmentId }));
      });
      const cancel = button('Not now', 'resume-cancel', true);
      cancel.className = 'btn-quiet';
      cancel.addEventListener('click', () => {
        apply(bridge().closeReview());
      });
      actions.append(confirm, cancel);
      panel.append(actions);
      item.append(panel);
    }
    section.append(item);
  }
  root.append(section);
}

/**
 * One slice the window could not read (lane g78, D06): its grey line and Retry, drawn
 * where the slice would have been. Retry re-reads the whole window — `state()` asks all
 * four reads again — so it needs no channel of its own, the way Administration's
 * sending Retry re-shows Settings.
 */
function renderUnread(root: HTMLElement, screen: ReturnType<typeof sequenceScreen>, slice: SequenceReadSlice): void {
  const unread = screen.unread.find(entry => entry.slice === slice);
  if (unread === undefined) return;
  const block = element('div', { className: 'sequence-unread', testId: `sequence-unread-${slice}` });
  block.append(element('p', { className: 'inert', text: unread.line, testId: 'sequence-unread-line' }));
  const retry = button('Retry', `sequence-retry-${slice}`, true);
  retry.addEventListener('click', () => {
    apply(bridge().state());
  });
  block.append(retry);
  root.append(block);
}

export function render(state: SequenceState): void {
  lastState = state;
  const root = document.querySelector('#app');
  if (root === null) return;
  root.textContent = '';
  const host = root as HTMLElement;
  const screen = sequenceScreen(state);
  host.append(element('h1', { text: 'Sequences', testId: 'heading' }));

  if (screen.banner !== null) {
    host.append(element('p', { className: 'banner', text: screen.banner, testId: 'sequence-banner' }));
  }
  if (screen.notice !== null) {
    host.append(element('p', { className: 'notice', text: screen.notice, testId: 'sequence-notice' }));
  }
  renderUnread(host, screen, 'sequences');
  renderSequences(host, screen);
  renderUnread(host, screen, 'versions');
  renderVersions(host, screen, state);
  renderUnread(host, screen, 'templates');
  renderTemplates(host, screen, state);
  renderLinkedIn(host, screen);
  renderUnread(host, screen, 'enrollments');
  renderHoldReview(host, screen);
}

/** The window's entry point. Renders the empty screen, then whatever the bridge says. */
export function start(): void {
  render(EMPTY_SEQUENCE_STATE);
  apply(bridge().state());
}

if (typeof document !== 'undefined' && document.querySelector('#app') !== null) start();
