import { button, element } from './firmDom.ts';
import type { SequenceBridge, SequenceReadSlice, SequenceState } from './sequenceContract.ts';
import { EMPTY_SEQUENCE_STATE, sequenceScreen } from './sequenceView.ts';

/**
 * The sequence editor window (specification 11.1, 11.3, 4.3, 14.2).
 *
 * A fourth entry point beside G2's sign-in page, G3b's firm workspace and G6's Today
 * page, and built the same way: every value reaches the DOM through `textContent`, so
 * a template body containing a tag is a template body; every decision comes from
 * `sequenceView.ts`, so a control that is shown and a control that works cannot
 * disagree; and the page holds no rule of its own.
 *
 * Three refusals are rendered rather than hidden, because a disabled button with no
 * explanation is the worst of both:
 *
 *   * a draft that cannot be published says which of the four reasons applies;
 *   * a template that cannot be approved says whether the footer is missing or an
 *     unsubscribe link was found (12.6);
 *   * a LinkedIn handoff says "FSS does not know whether it was sent", because 11.3
 *     says the system never claims otherwise.
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

function apply(next: Promise<SequenceState>): void {
  void (async () => {
    render(await next);
  })();
}

function renderSequences(root: HTMLElement, screen: ReturnType<typeof sequenceScreen>): void {
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
}

function renderVersions(root: HTMLElement, screen: ReturnType<typeof sequenceScreen>): void {
  for (const panel of screen.versions) {
    const section = element('section', { className: 'version' });
    section.dataset['testid'] = 'version';
    section.append(element('h2', { text: panel.heading, testId: 'version-heading' }));
    section.append(
      element('p', {
        className: 'stop-conditions',
        testId: 'version-stops',
        text: `Stops on: ${panel.stopConditions.join(', ')}`,
      }),
    );

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

    const publish = button('Publish', 'version-publish', panel.canPublish);
    publish.addEventListener('click', () => {
      apply(bridge().publish({ sequenceVersionId: panel.id }));
    });
    section.append(publish);
    if (panel.publishRefusal !== null) {
      section.append(
        element('p', {
          className: 'refusal',
          testId: 'publish-refusal',
          text: PUBLISH_REFUSAL_SENTENCES[panel.publishRefusal] ?? panel.publishRefusal,
        }),
      );
    }

    const retire = button('Retire', 'version-retire', panel.canRetire);
    retire.addEventListener('click', () => {
      apply(bridge().retire({ sequenceVersionId: panel.id }));
    });
    section.append(retire);
    root.append(section);
  }
}

function renderTemplates(root: HTMLElement, screen: ReturnType<typeof sequenceScreen>): void {
  for (const panel of screen.templates) {
    const section = element('section', { className: 'template' });
    section.dataset['testid'] = 'template';
    section.append(element('h3', { text: panel.label, testId: 'template-label' }));
    section.append(element('p', { className: 'subject', text: panel.subject, testId: 'template-subject' }));
    section.append(element('pre', { className: 'body', text: panel.body, testId: 'template-body' }));
    // 11.1 binds an approval to bytes; an approver should be able to read the digest.
    section.append(
      element('code', { className: 'hash', text: panel.contentHash, testId: 'template-hash' }),
    );
    section.append(element('pre', { className: 'footer', text: panel.footer, testId: 'template-footer' }));

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

    const approve = button(panel.approved ? 'Approved' : 'Approve', 'template-approve', panel.canApprove);
    approve.addEventListener('click', () => {
      apply(bridge().approveTemplate({ templateVersionId: panel.id }));
    });
    section.append(approve);
    root.append(section);
  }
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
    const resume = button('Review and resume', 'hold-resume', row.canResume);
    resume.addEventListener('click', () => {
      apply(bridge().resumeEnrollment({ enrollmentId: row.enrollmentId }));
    });
    item.append(resume);
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
  const root = document.querySelector('#app');
  if (root === null) return;
  root.textContent = '';
  const host = root as HTMLElement;
  const screen = sequenceScreen(state);

  if (screen.banner !== null) {
    host.append(element('p', { className: 'banner', text: screen.banner, testId: 'sequence-banner' }));
  }
  if (screen.notice !== null) {
    host.append(element('p', { className: 'notice', text: screen.notice, testId: 'sequence-notice' }));
  }
  renderUnread(host, screen, 'sequences');
  renderSequences(host, screen);
  renderUnread(host, screen, 'versions');
  renderVersions(host, screen);
  renderUnread(host, screen, 'templates');
  renderTemplates(host, screen);
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
