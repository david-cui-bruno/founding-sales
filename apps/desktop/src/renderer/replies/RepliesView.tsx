import { useState, type JSX } from 'react';
import { navigate } from '../routes.ts';
import type { ReplyState } from '../replyContract.ts';
import {
  CALLBACK_REQUIRED_HINT,
  CALLBACK_REQUIRED_LABEL,
  buildReplyView,
  candidateLabel,
  confirmLabel,
  type ReplyCardView,
} from '../replyView.ts';
import { Alert } from '../ui/alert.tsx';
import { Button } from '../ui/button.tsx';
import { Input } from '../ui/input.tsx';
import { Label } from '../ui/label.tsx';
import { Textarea } from '../ui/textarea.tsx';
import { orDash } from '../today/text.ts';
import type { Replies } from './useReplies.ts';

/**
 * The Replies view (specification 8.3, 12.4, 14.2).
 *
 * ## ⚠ D5.1, and the guards it came with
 *
 * The owner decided on 26 September 2026 that a card should open with Callie's guess
 * already chosen, knowingly reversing G7b. The risk G7b named is real — a preselected
 * answer makes agreement and click-through look the same — so three things hold here,
 * and each has a test:
 *
 * **Only pressing Confirm confirms.** There is no `<form>` around the choices and no
 * submit handler anywhere on the card; Confirm is a `type="button"` with an `onClick`.
 * Until 1.0.11 Confirm was a form's submit, which means Enter from any field in it sent
 * the confirmation without the button ever being focused. `reply.spec.ts` presses Enter
 * and Space from the opening focus and from every field and asserts nothing is sent.
 *
 * **The button names the effect, not the choice.** "Stop automated sending and record a
 * do-not-contact", not "Confirm: Asked not to be contacted" — the words of the command
 * that is about to run, from `CONFIRM_LABELS`.
 *
 * **Nothing calls an uncorrected confirmation a review.** The guess is marked as a guess
 * beside the choice it fills in; what the card says afterwards is which disposition was
 * recorded, and no more.
 *
 * ## The content is not cached, anywhere
 *
 * `GET /replies` answers full cards, so nothing here or in `useReplies.ts` keeps one: the
 * body is React state in this component, it goes when the card closes or the view is
 * left, and offline is a banner where the list would be rather than a card from earlier.
 */

function Banners({ banners, prefix }: { readonly banners: ReplyCardView['banners']; readonly prefix: string }): JSX.Element {
  return (
    <>
      {banners.map(banner => (
        <Alert key={`${banner.tone}:${banner.text}`} tone={banner.tone} data-testid={`${prefix}-${banner.tone}`}>
          {banner.text}
        </Alert>
      ))}
    </>
  );
}

function Suggestion({ card }: { readonly card: ReplyCardView }): JSX.Element {
  return (
    <section data-testid="suggestion" className="flex flex-col gap-1 border-t border-border pt-3">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">What Callie read</h3>
      <p data-testid="suggestion-class" className="text-sm">
        {card.classLabel}
      </p>
      {card.suggestion === null ? (
        <p data-testid="suggestion-none" className="text-sm text-muted-foreground">
          Callie has no suggestion for this one.
        </p>
      ) : (
        <>
          <p data-testid="suggestion-disposition" className="text-sm">
            {orDash(card.suggestion.dispositionLabel)}
          </p>
          <p data-testid="suggestion-confidence" className="text-xs text-muted-foreground">
            {orDash(card.suggestion.confidenceLabel)}
          </p>
          {/* The quotation, marked as a quotation. It is verified verbatim against the
              message before it is ever stored, so what is on screen is what was written. */}
          <blockquote data-testid="suggestion-excerpt" className="border-l-2 border-border pl-3 text-sm text-muted-foreground">
            {orDash(card.suggestion.excerpt)}
          </blockquote>
          <p data-testid="suggestion-by" className="text-xs text-muted-foreground">
            {orDash(card.suggestion.attribution)}
          </p>
        </>
      )}
      <ul data-testid="signals" className="mt-1 flex flex-col gap-0.5">
        {card.signalLines.map(line => (
          <li key={line} data-testid="signal" className="text-xs text-muted-foreground">
            {line}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Which conversation the reply belongs to (lane g88, audit G07). One radio per candidate
 * firm, nothing chosen until the person chooses, and a button that sends G7's resolution.
 * The disposition form appears once the card comes back resolved. No form element here
 * either, for the reason at the top of this file.
 */
function Candidates({ card, replies }: { readonly card: ReplyCardView; readonly replies: Replies }): JSX.Element | null {
  const [picked, setPicked] = useState<string | null>(null);
  // This card's own call, not any call anywhere in the window (P1-4).
  const busy = replies.busy(card.messageId);
  if (card.ambiguity.length === 0) return null;
  return (
    <div data-testid="candidate-form" className="mt-3 flex flex-col gap-2">
      <h3 className="text-sm font-medium">Which conversation is this reply about?</h3>
      {card.ambiguity.map(candidate => (
        <label key={candidate.opportunityId} data-testid="ambiguity-candidate" className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="candidate"
            data-testid="candidate-choice"
            value={candidate.opportunityId}
            disabled={!card.resolveEnabled || busy}
            checked={picked === candidate.opportunityId}
            onChange={() => {
              setPicked(candidate.opportunityId);
            }}
            className="size-3.5 accent-[var(--primary)]"
          />
          <span>{candidateLabel(candidate)}</span>
        </label>
      ))}
      <div>
        <Button
          variant="outline"
          size="sm"
          data-testid="candidate-submit"
          disabled={!card.resolveEnabled || picked === null || busy}
          {...(busy ? { 'aria-busy': true } : {})}
          onClick={() => {
            if (picked === null) return;
            replies.resolve({ messageId: card.messageId, opportunityId: picked });
          }}
        >
          This one
        </Button>
      </div>
    </div>
  );
}

function Answer({
  card,
  state,
  replies,
}: {
  readonly card: ReplyCardView;
  readonly state: ReplyState;
  readonly replies: Replies;
}): JSX.Element | null {
  // The model's reading of a time, as a prefill a person may overwrite. 12.4 will not
  // let it be committed without them, so nothing here sends it on its own.
  const [date, time] = (card.callbackPrefill?.localDateTime ?? '').split('T');
  const [callbackDate, setCallbackDate] = useState(date ?? '');
  const [callbackTime, setCallbackTime] = useState(time ?? '');
  const [firmWide, setFirmWide] = useState(false);
  const [note, setNote] = useState('');
  if (card.choices.length === 0) return null;

  /*
   * What is actually about to happen, in one place (1.0.12).
   *
   * `booked` is whether a day has been typed — the callback is only created if one was
   * supplied. `needsDay` is the card where Callie read a day and the field is now
   * empty: the server refuses that confirmation with `callback_required`, so Confirm
   * does not offer it. The button never promises something the server will refuse.
   */
  const booked = card.callbackOffered && callbackDate !== '';
  const needsDay = card.callbackRequired && !booked;

  const chosen = replies.chosen;
  const consequence = card.choices.find(choice => choice.selected)?.consequence ?? '';

  return (
    <div data-testid="disposition-form" className="mt-4 flex flex-col gap-2 border-t border-border pt-3">
      <h3 className="text-sm font-medium">What does it mean?</h3>

      {card.choices.map(choice => (
        <label key={choice.disposition} data-testid="choice" className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="disposition"
            data-testid={`choice-${choice.disposition}`}
            value={choice.disposition}
            checked={choice.selected}
            onChange={() => {
              replies.choose(choice.disposition);
            }}
            className="size-3.5 accent-[var(--primary)]"
          />
          <span>{choice.label}</span>
          {choice.suggested ? (
            <span data-testid="suggested-hint" className="rounded bg-muted px-1.5 py-px text-[11px] text-muted-foreground">
              Callie’s guess
            </span>
          ) : null}
        </label>
      ))}

      <p data-testid="consequence" className="text-xs leading-relaxed text-muted-foreground empty:hidden">
        {consequence}
      </p>

      <fieldset data-testid="callback" hidden={!card.callbackOffered} className="flex flex-wrap items-end gap-2 border-0 p-0">
        <legend className="mb-1 w-full text-xs font-medium text-muted-foreground">
          When did they ask you to come back?
        </legend>
        <Input
          data-testid="callback-date"
          type="date"
          required={card.callbackRequired}
          value={callbackDate}
          onChange={event => {
            setCallbackDate(event.target.value);
          }}
          className="w-40"
        />
        <Input
          data-testid="callback-time"
          type="time"
          value={callbackTime}
          onChange={event => {
            setCallbackTime(event.target.value);
          }}
          className="w-28"
        />
        {needsDay ? (
          <p data-testid="callback-required" className="w-full text-xs leading-relaxed text-muted-foreground">
            {CALLBACK_REQUIRED_HINT}
          </p>
        ) : null}
      </fieldset>

      <label data-testid="firm-wide-label" hidden={!card.firmWideOptOutOffered} className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          data-testid="firm-wide"
          checked={firmWide}
          onChange={event => {
            setFirmWide(event.target.checked);
          }}
          className="size-3.5 accent-[var(--primary)]"
        />
        <span>Nobody at this firm, not just this address</span>
      </label>

      <Label className="flex-col items-start gap-1">
        Note
        <Textarea
          data-testid="note"
          value={note}
          onChange={event => {
            setNote(event.target.value);
          }}
        />
      </Label>

      <div>
        {/*
          ⚠ D5.1's first guard. `type="button"`, no form, no submit handler: this
          `onClick` is the only path to `confirm`, so no keystroke in any field above can
          reach it. `ui/button.tsx` defaults every button to `type="button"` for the
          same reason.
        */}
        <Button
          data-testid="confirm"
          disabled={!card.confirmEnabled || needsDay || replies.busy(card.messageId)}
          {...(replies.busy(card.messageId) ? { 'aria-busy': true } : {})}
          onClick={() => {
            if (chosen === null) return;
            replies.confirm({
              messageId: card.messageId,
              disposition: chosen,
              // A `date` and a `time` carry no zone; the main process resolves them
              // against the workspace's business zone, which is the only zone this view
              // is told about.
              callback: booked
                ? { localDate: callbackDate, localTime: callbackTime, sourceTimeZone: state.businessTimeZone ?? '' }
                : null,
              firmWideOptOut: card.firmWideOptOutOffered && firmWide,
              note: note.trim(),
            });
            setNote('');
          }}
        >
          {needsDay ? CALLBACK_REQUIRED_LABEL : confirmLabel(chosen, booked)}
        </Button>
      </div>
    </div>
  );
}

function Card({ card, state, replies }: { readonly card: ReplyCardView; readonly state: ReplyState; readonly replies: Replies }): JSX.Element {
  return (
    <section data-testid="reply-card" className="mt-5 flex flex-col gap-2 border-t border-border pt-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 data-testid="card-firm" className="text-base font-medium">
          {card.heading}
        </h2>
        {/* The firm the reply is about, in the same window: its page is where the deal
            is marked Lost, a contact is added, or a number is confirmed. */}
        <Button
          variant="quiet"
          size="sm"
          data-testid="reply-open-firm"
          onClick={() => {
            navigate({ name: 'firm', firmId: card.firmId });
          }}
        >
          Open firm
        </Button>
      </div>
      <p data-testid="card-from" className="text-sm text-muted-foreground">
        {card.fromLine}
      </p>
      <p data-testid="card-subject" className="text-sm">
        {orDash(card.subject)}
      </p>

      {card.redacted ? (
        <p data-testid="card-redacted" className="text-sm text-muted-foreground">
          You are not assigned to this firm, so Callie is not showing you the message.
        </p>
      ) : (
        <>
          <pre data-testid="card-body" className="rounded-md bg-muted/60 p-3 font-sans text-sm leading-relaxed whitespace-pre-wrap">
            {card.bodyText ?? ''}
          </pre>
          {card.bodyTruncated ? (
            <p data-testid="card-truncated" className="text-xs text-muted-foreground">
              This message was cut short.
            </p>
          ) : null}
        </>
      )}

      <Suggestion card={card} />

      <section data-testid="impact" className="flex flex-col gap-1 border-t border-border pt-3">
        <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">What this affects</h3>
        <ul data-testid="impact-lines" className="flex flex-col gap-0.5">
          {card.impactLines.map(line => (
            <li key={line} data-testid="impact-line" className="text-sm">
              {line}
            </li>
          ))}
        </ul>
        <Candidates card={card} replies={replies} />
      </section>

      <Banners banners={card.banners} prefix="card-banner" />
      <Answer card={card} state={state} replies={replies} />
    </section>
  );
}

export function RepliesView({ replies }: { readonly replies: Replies }): JSX.Element | null {
  const state = replies.state;
  if (state === null) return null;
  const view = buildReplyView(state, replies.chosen);

  return (
    <div className="mx-auto flex w-full max-w-[860px] flex-col px-12 pt-10 pb-20">
      <div className="flex items-baseline justify-between gap-3">
        <h1 data-testid="heading" className="text-2xl font-semibold tracking-tight">
          {view.heading}
        </h1>
        <Button variant="quiet" size="sm" data-testid="refresh" onClick={replies.refresh}>
          Refresh
        </Button>
      </div>
      {state.businessDate === null ? null : (
        <p data-testid="business-date" className="text-sm text-muted-foreground">
          {state.businessDate}
        </p>
      )}

      <div data-testid="banners" className="mt-3 flex flex-col gap-2 empty:hidden">
        <Banners banners={view.banners} prefix="banner" />
      </div>

      <ul data-testid="reply-list" className="mt-4 flex flex-col border-t border-border">
        {view.summaries.map(summary => (
          <li
            key={summary.card.messageId}
            data-testid="reply-summary"
            className="group/reply flex items-center gap-3 border-b border-border py-1.5 last:border-b-0"
          >
            <span data-testid="summary-line" className="min-w-0 flex-1 truncate text-sm">
              {summary.line}
            </span>
            <Button
              variant="outline"
              size="sm"
              data-testid="reply-open"
              disabled={replies.busy(summary.card.messageId)}
              {...(replies.busy(summary.card.messageId) ? { 'aria-busy': true } : {})}
              onClick={() => {
                if (summary.open) replies.close();
                else replies.open(summary.card.messageId);
              }}
            >
              {summary.open ? 'Close' : 'Read'}
            </Button>
          </li>
        ))}
      </ul>
      {view.emptyMessage === null ? null : (
        <p data-testid="reply-empty" className="py-6 text-sm text-muted-foreground">
          {view.emptyMessage}
        </p>
      )}

      {view.card === null ? null : <Card card={view.card} state={state} replies={replies} />}

      {view.classifierLine === null ? null : (
        <p data-testid="classifier-line" className="mt-6 text-xs text-muted-foreground">
          {view.classifierLine}
        </p>
      )}
    </div>
  );
}
