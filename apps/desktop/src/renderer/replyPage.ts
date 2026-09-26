import { button, element, orDash } from './firmDom.ts';
import type { ReplyBridge, ReplyDisposition, ReplyState } from './replyContract.ts';
import { buildReplyView, candidateLabel, replyNotice, type ReplyCardView } from './replyView.ts';
import { navigate } from './routes.ts';

/**
 * The Replies view (specification 8.3, 12.4, 14.2).
 *
 * A view of the one window (wave 1): `mount` draws into the shell's column and `unmount`
 * stops it, so an answer that arrives after the person went elsewhere draws nothing.
 * Every rule lives where it can be tested without Electron.
 *
 * The page holds one piece of state — `chosen`, the disposition the person has
 * clicked — and no rules at all. It asks `buildReplyCardView` what to show and what
 * may be pressed. In particular it does not preselect the model's suggestion: the
 * suggestion is rendered beside the choices, `chosen` starts as null, and Confirm is
 * disabled until a person picks one. That is 12.4's authority boundary on screen, and
 * the reason it is written down is `docs/decisions/g7b-the-suggestion-is-not-a-default.md`.
 *
 * Every value reaches the page through `textContent`, without exception. This window
 * renders the text of somebody's mail, which is the one string in this application
 * most likely to contain a tag.
 */

const bridge = (): ReplyBridge => {
  const value = globalThis.callieReplies;
  if (value === undefined) throw new Error('the Callie replies bridge is not present');
  return value;
};

let lastState: ReplyState | null = null;
let chosen: ReplyDisposition | null = null;
/** The shell's column while this view is mounted, or null. */
let container: HTMLElement | null = null;
/** Bumped by every mount and unmount, so an answer to an earlier one is dropped. */
let generation = 0;

function apply(next: Promise<ReplyState>): void {
  const mine = generation;
  void (async () => {
    const state = await next;
    if (mine === generation) render(state);
  })();
}

export function mount(target: HTMLElement): void {
  generation += 1;
  container = target;
  apply(bridge().state());
}

export function unmount(): void {
  generation += 1;
  container = null;
}

function renderSummaries(root: HTMLElement, view: ReturnType<typeof buildReplyView>): void {
  const list = element('ul', { className: 'reply-list', testId: 'reply-list' });
  for (const summary of view.summaries) {
    const item = element('li', { className: summary.open ? 'reply-summary open' : 'reply-summary' });
    item.dataset['testid'] = 'reply-summary';
    item.append(element('span', { className: 'line', text: summary.line, testId: 'summary-line' }));
    const open = button(summary.open ? 'Close' : 'Read', 'reply-open', true);
    open.addEventListener('click', () => {
      // A different card is a different question, so the answer does not travel.
      chosen = null;
      apply(summary.open ? bridge().collapse() : bridge().open({ messageId: summary.card.messageId }));
    });
    item.append(open);
    list.append(item);
  }
  root.append(list);
  if (view.emptyMessage !== null) root.append(element('p', { testId: 'reply-empty', text: view.emptyMessage }));
}

function renderMessage(panel: HTMLElement, card: ReplyCardView): void {
  const head = element('div', { className: 'card-head' });
  head.append(element('h2', { text: card.heading, testId: 'card-firm' }));
  // The firm the reply is about, in the same window: its page is where the deal is
  // marked Lost, a contact is added, or a number is confirmed.
  const firm = button('Open firm', 'reply-open-firm', true);
  firm.className = 'btn btn-quiet';
  firm.addEventListener('click', () => {
    navigate({ name: 'firm', firmId: card.firmId });
  });
  head.append(firm);
  panel.append(head);
  panel.append(element('p', { className: 'from', text: card.fromLine, testId: 'card-from' }));
  panel.append(element('p', { className: 'subject', text: orDash(card.subject), testId: 'card-subject' }));
  if (card.redacted) {
    panel.append(
      element('p', {
        className: 'redacted',
        testId: 'card-redacted',
        text: 'You are not assigned to this firm, so Callie is not showing you the message.',
      }),
    );
  } else {
    const body = element('pre', { className: 'body', text: card.bodyText ?? '', testId: 'card-body' });
    panel.append(body);
    if (card.bodyTruncated) {
      panel.append(element('p', { className: 'truncated', testId: 'card-truncated', text: 'This message was cut short.' }));
    }
  }
}

function renderSuggestion(panel: HTMLElement, card: ReplyCardView): void {
  const box = element('section', { className: 'suggestion', testId: 'suggestion' });
  box.append(element('h3', { text: 'What Callie read' }));
  box.append(element('p', { className: 'class', text: card.classLabel, testId: 'suggestion-class' }));
  if (card.suggestion === null) {
    box.append(element('p', { testId: 'suggestion-none', text: 'Callie has no suggestion for this one.' }));
  } else {
    box.append(
      element('p', {
        className: 'disposition',
        testId: 'suggestion-disposition',
        text: orDash(card.suggestion.dispositionLabel),
      }),
    );
    box.append(
      element('p', { className: 'confidence', testId: 'suggestion-confidence', text: orDash(card.suggestion.confidenceLabel) }),
    );
    // The quotation, marked as a quotation. It is verified verbatim against the
    // message before it is ever stored, so what is on screen is what was written.
    box.append(element('blockquote', { testId: 'suggestion-excerpt', text: orDash(card.suggestion.excerpt) }));
    box.append(element('p', { className: 'by', testId: 'suggestion-by', text: orDash(card.suggestion.attribution) }));
  }
  const signals = element('ul', { className: 'signals', testId: 'signals' });
  for (const line of card.signalLines) signals.append(element('li', { text: line, testId: 'signal' }));
  box.append(signals);
  panel.append(box);
}

function renderImpact(panel: HTMLElement, card: ReplyCardView): void {
  const box = element('section', { className: 'impact', testId: 'impact' });
  box.append(element('h3', { text: 'What this affects' }));
  const list = element('ul', { testId: 'impact-lines' });
  for (const line of card.impactLines) list.append(element('li', { text: line, testId: 'impact-line' }));
  box.append(list);
  renderCandidates(box, card);
  panel.append(box);
}

/**
 * Which conversation the reply belongs to (lane g88, audit G07). One radio per candidate
 * firm, nothing chosen until the person chooses, and a button that sends G7's resolution.
 * The disposition form appears once the card comes back resolved.
 */
function renderCandidates(box: HTMLElement, card: ReplyCardView): void {
  if (card.ambiguity.length === 0) return;
  const form = element('form', { className: 'candidates', testId: 'candidate-form' });
  form.append(element('h3', { text: 'Which conversation is this reply about?' }));
  let picked: string | null = null;
  const submit = button('This one', 'candidate-submit', false);
  submit.type = 'submit';
  for (const candidate of card.ambiguity) {
    const label = element('label', { className: 'candidate-choice' });
    label.dataset['testid'] = 'ambiguity-candidate';
    const radio = element('input', { testId: 'candidate-choice' });
    radio.type = 'radio';
    radio.name = 'candidate';
    radio.value = candidate.opportunityId;
    radio.disabled = !card.resolveEnabled;
    radio.addEventListener('change', () => {
      picked = candidate.opportunityId;
      submit.disabled = !card.resolveEnabled;
    });
    label.append(radio, element('span', { text: candidateLabel(candidate) }));
    form.append(label);
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (picked === null) return;
    apply(bridge().resolve({ messageId: card.messageId, opportunityId: picked }));
  });
  form.append(submit);
  box.append(form);
}

function renderAnswer(panel: HTMLElement, card: ReplyCardView, state: ReplyState): void {
  if (card.choices.length === 0) return;
  const form = element('form', { className: 'disposition', testId: 'disposition-form' });
  form.append(element('h3', { text: 'What does it mean?' }));

  const consequence = element('p', { className: 'consequence', testId: 'consequence' });
  const callback = element('fieldset', { testId: 'callback' });
  const callbackDate = element('input', { testId: 'callback-date' });
  callbackDate.type = 'date';
  const callbackTime = element('input', { testId: 'callback-time' });
  callbackTime.type = 'time';
  callback.append(element('legend', { text: 'When did they ask you to come back?' }), callbackDate, callbackTime);
  const firmWide = element('input', { testId: 'firm-wide' });
  firmWide.type = 'checkbox';
  const firmWideLabel = element('label', { className: 'firm-wide', testId: 'firm-wide-label' });
  firmWideLabel.append(firmWide, element('span', { text: 'Nobody at this firm, not just this address' }));
  const note = element('textarea', { testId: 'note' });
  const submit = button(card.confirmLabel, 'confirm', card.confirmEnabled);
  submit.type = 'submit';

  // The model's reading of a time, as a prefill a person may overwrite. 12.4 will not
  // let it be committed without them, so nothing here submits it on its own.
  if (card.callbackPrefill !== null) {
    const [date, time] = card.callbackPrefill.localDateTime.split('T');
    callbackDate.value = date ?? '';
    callbackTime.value = time ?? '';
  }

  for (const choice of card.choices) {
    const label = element('label', { className: 'choice' });
    label.dataset['testid'] = 'choice';
    const radio = element('input', { testId: `choice-${choice.disposition}` });
    radio.type = 'radio';
    radio.name = 'disposition';
    radio.value = choice.disposition;
    radio.checked = choice.selected;
    radio.addEventListener('change', () => {
      chosen = choice.disposition;
      render(null);
    });
    label.append(radio, element('span', { text: choice.label }));
    if (choice.suggested) {
      label.append(element('span', { className: 'suggested', testId: 'suggested-hint', text: 'Callie’s guess' }));
    }
    form.append(label);
    if (choice.selected) consequence.textContent = choice.consequence;
  }

  callback.hidden = !card.callbackOffered;
  callbackDate.required = card.callbackRequired;
  firmWideLabel.hidden = !card.firmWideOptOutOffered;

  form.addEventListener('submit', event => {
    event.preventDefault();
    if (chosen === null) return;
    apply(
      bridge().confirm({
        messageId: card.messageId,
        disposition: chosen,
        // `datetime-local` has no zone; the main process resolves it against the
        // workspace's business zone, which is the only zone this window is told.
        callback:
          card.callbackOffered && callbackDate.value !== ''
            ? {
                localDate: callbackDate.value,
                localTime: callbackTime.value,
                sourceTimeZone: state.businessTimeZone ?? '',
              }
            : null,
        firmWideOptOut: card.firmWideOptOutOffered && firmWide.checked,
        note: note.value.trim(),
      }),
    );
    chosen = null;
  });

  form.append(consequence, callback, firmWideLabel, note, submit);
  panel.append(form);
}

export function render(state: ReplyState | null): void {
  if (state !== null) lastState = state;
  const current = lastState;
  const root = container;
  if (root === null || current === null) return;
  const view = buildReplyView(current, chosen);

  root.replaceChildren();
  root.append(element('h1', { text: view.heading, testId: 'heading' }));
  if (current.businessDate !== null) {
    root.append(element('p', { className: 'date', text: current.businessDate, testId: 'business-date' }));
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
    chosen = null;
    apply(bridge().refresh());
  });
  root.append(refresh);

  renderSummaries(root, view);

  if (view.card !== null) {
    const panel = element('section', { className: 'reply-card', testId: 'reply-card' });
    renderMessage(panel, view.card);
    renderSuggestion(panel, view.card);
    renderImpact(panel, view.card);
    for (const banner of view.card.banners) {
      const node = element('p', { className: `banner banner-${banner.tone}`, text: banner.text });
      node.dataset['testid'] = `card-banner-${banner.tone}`;
      panel.append(node);
    }
    renderAnswer(panel, view.card, current);
    root.append(panel);
  }

  if (view.classifierLine !== null) {
    root.append(element('p', { className: 'classifier', testId: 'classifier-line', text: view.classifierLine }));
  }
}

export { replyNotice };
