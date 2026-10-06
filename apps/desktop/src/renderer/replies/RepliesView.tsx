import { MailOpen, X } from 'lucide-react';
import { useEffect, useRef, type JSX } from 'react';
import { cn } from '../lib/utils.ts';
import { navigate } from '../routes.ts';
import type { ReplyState, ReplySummary } from '../replyContract.ts';
import {
  CALLBACK_REQUIRED_HINT,
  CALLBACK_REQUIRED_LABEL,
  buildReplyView,
  candidateLabel,
  confirmLabel,
  replyNotice,
  summaryDetail,
  type ReplyCardView,
} from '../replyView.ts';
import { Alert } from '../ui/alert.tsx';
import { Button } from '../ui/button.tsx';
import { Input } from '../ui/input.tsx';
import { Label as FieldLabel } from '../ui/label.tsx';
import { Select } from '../ui/select.tsx';
import { Textarea } from '../ui/textarea.tsx';
import { orDash } from '../today/text.ts';
import { Block, Chip, dense, EmptyState, Kbd, Label, Skeleton } from '../v2/parts.tsx';
import { useShortcuts } from '../v2/shortcuts.ts';
import { useKept } from './kept.ts';
import { countQueue, filterQueue, isUncertain, isWaiting, orderQueue, queueFilterOf, type QueueFilter } from './queue.ts';
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
 *
 * ## Layout (S4R)
 *
 * Two regions, as Today has: the queue on the left (waiting first, newest first, J/K to
 * walk and Enter to open), the open reply in the panel. After a reply is answered the next
 * waiting one opens. What is kept above the route is the person's own: the open reply's id,
 * the answer picked, what was typed, the filter and the list's scroll (`kept.ts`).
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

/** The sentence a command left, beside the thing it was about. */
function Notice({ code }: { readonly code: string }): JSX.Element {
  return (
    <p data-testid="banner-info" role="status" className="text-xs leading-relaxed text-muted-foreground">
      {replyNotice(code)}
    </p>
  );
}

function Suggestion({ card }: { readonly card: ReplyCardView }): JSX.Element {
  return (
    <Block data-testid="suggestion" className="flex flex-col gap-1">
      <Label>What Callie read</Label>
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
          <blockquote data-testid="suggestion-excerpt" className="border-l-2 border-strong pl-3 text-sm text-muted-foreground">
            {orDash(card.suggestion.excerpt)}
          </blockquote>
          <p data-testid="suggestion-by" className="text-xs text-faint">
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
    </Block>
  );
}

/**
 * Which conversation the reply belongs to (lane g88, audit G07). One radio per candidate
 * firm, nothing chosen until the person chooses, and a button that sends G7's resolution.
 * The disposition form appears once the card comes back resolved. No form element here
 * either, for the reason at the top of this file.
 */
function Candidates({ card, replies }: { readonly card: ReplyCardView; readonly replies: Replies }): JSX.Element | null {
  const [picked, setPicked] = useKept(`replies:m:${card.messageId}:candidate`, '');
  // This card's own call, not any call anywhere in the window (P1-4).
  const busy = replies.busy(card.messageId);
  if (card.ambiguity.length === 0) return null;
  return (
    <div data-testid="candidate-form" className="mt-3 flex flex-col gap-2">
      <h3 className="text-sm font-medium">Which conversation is this reply about?</h3>
      {card.ambiguity.map(candidate => (
        <label key={candidate.opportunityId??candidate.outreachPlanId} data-testid="ambiguity-candidate" className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="candidate"
            data-testid="candidate-choice"
            value={candidate.opportunityId??candidate.outreachPlanId??''}
            disabled={!card.resolveEnabled || busy}
            checked={picked === (candidate.opportunityId??candidate.outreachPlanId)}
            onChange={() => {
              setPicked(candidate.opportunityId??candidate.outreachPlanId??'');
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
          disabled={!card.resolveEnabled || picked === '' || busy}
          {...(busy ? { 'aria-busy': true } : {})}
          onClick={() => {
            if (picked === '') return;
            const candidate=card.ambiguity.find(c=>(c.opportunityId??c.outreachPlanId)===picked);
            if(candidate?.opportunityId)replies.resolve({messageId:card.messageId,opportunityId:candidate.opportunityId});
            else if(candidate?.outreachPlanId)replies.resolve({messageId:card.messageId,outreachPlanId:candidate.outreachPlanId});
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
  outcome,
}: {
  readonly card: ReplyCardView;
  readonly state: ReplyState;
  readonly replies: Replies;
  /** What the last command on this reply said: it belongs beside the button that sent it. */
  readonly outcome: string | null;
}): JSX.Element | null {
  const id = card.messageId;
  // The model's reading of a time, as a prefill a person may overwrite. 12.4 will not
  // let it be committed without them, so nothing here sends it on its own.
  const [date, time] = (card.callbackPrefill?.localDateTime ?? '').split('T');
  const [callbackDate, setCallbackDate] = useKept(`replies:m:${id}:date`, date ?? '');
  const [callbackTime, setCallbackTime] = useKept(`replies:m:${id}:time`, time ?? '');
  const [firmWideText, setFirmWide] = useKept(`replies:m:${id}:firmwide`, '');
  const firmWide = firmWideText === 'yes';
  const [note, setNote] = useKept(`replies:m:${id}:note`, '');
  // Migration 0025: an inbound question permits a contextual reply, so the default is
  // to grant one — and the select is how a person says no to it.
  const [followUpText, setFollowUp] = useKept(`replies:m:${id}:followup`, 'contextual_reply');
  const grantFollowUp = followUpText === 'contextual_reply';
  if (card.choices.length === 0) return outcome === null ? null : <Notice code={outcome} />;

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
  // Only the two dispositions that mean "they want to hear from us" permit a follow-up.
  // `not_interested` and `opt_out` are refusals, and a permission from one would be
  // absurd; the server ignores the field for them either way.
  const permitsFollowUp = chosen === 'interested' || chosen === 'follow_up_later';

  return (
    <Block data-testid="disposition-form" className="flex flex-col gap-2">
      <Label>What does it mean?</Label>

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
            <Chip data-testid="suggested-hint" tone="outline">
              Callie’s guess
            </Chip>
          ) : null}
        </label>
      ))}

      <p data-testid="consequence" className="text-xs leading-relaxed text-muted-foreground empty:hidden">
        {consequence}
      </p>

      <label
        data-testid="follow-up-label"
        hidden={!permitsFollowUp}
        className="flex flex-col items-start gap-1 text-sm"
      >
        May Callie reply?
        <Select
          data-testid="follow-up-scope"
          value={grantFollowUp ? 'contextual_reply' : ''}
          onChange={event => {
            setFollowUp(event.target.value === 'contextual_reply' ? 'contextual_reply' : 'none');
          }}
        >
          <option value="contextual_reply">Yes — one reply to what they asked</option>
          <option value="">No follow-up</option>
        </Select>
        <span className="text-xs text-muted-foreground">
          A reply to this message, for fourteen days. Not a sequence.
        </span>
      </label>

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
            setFirmWide(event.target.checked ? 'yes' : '');
          }}
          className="size-3.5 accent-[var(--primary)]"
        />
        <span>Nobody at this firm, not just this address</span>
      </label>

      <FieldLabel className="flex-col items-start gap-1">
        Note
        <Textarea
          data-testid="note"
          value={note}
          onChange={event => {
            setNote(event.target.value);
          }}
        />
      </FieldLabel>

      <div className="flex flex-col items-start gap-2">
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
              grantFollowUp,
            });
          }}
        >
          {needsDay ? CALLBACK_REQUIRED_LABEL : confirmLabel(chosen, booked)}
        </Button>
        {outcome === null ? null : <Notice code={outcome} />}
      </div>
    </Block>
  );
}

function Panel({
  card,
  state,
  replies,
  outcome,
}: {
  readonly card: ReplyCardView;
  readonly state: ReplyState;
  readonly replies: Replies;
  readonly outcome: string | null;
}): JSX.Element {
  const received = state.open?.receivedAt ?? null;
  return (
    <section data-testid="reply-card" className="mx-auto flex w-full max-w-[720px] flex-col gap-2 px-6 py-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 data-testid="card-firm" className="text-lg font-semibold">
          {card.heading}
        </h2>
        <span className="flex shrink-0 items-center gap-1">
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
          <Button variant="quiet" size="icon" className={dense.icon} data-testid="reply-close" aria-label="Close reply (Esc)" title="Close (Esc)" onClick={replies.close}>
            <X />
          </Button>
        </span>
      </div>
      <p data-testid="card-from" className="text-sm text-muted-foreground">
        {card.fromLine}
        {received === null ? null : <span className="tabular text-faint">{`  ·  ${formatReceived(received)}`}</span>}
      </p>
      <p data-testid="card-subject" className="text-sm font-medium">
        {orDash(card.subject)}
      </p>

      {card.redacted ? (
        <p data-testid="card-redacted" className="text-sm text-muted-foreground">
          You are not assigned to this firm, so Callie is not showing you the message.
        </p>
      ) : (
        <>
          <pre data-testid="card-body" className="rounded-md bg-muted/60 p-3 font-sans text-base leading-relaxed whitespace-pre-wrap">
            {card.bodyText ?? ''}
          </pre>
          {card.bodyTruncated ? (
            <p data-testid="card-truncated" className="text-xs text-muted-foreground">
              This message was cut short.
            </p>
          ) : null}
        </>
      )}

      <div className="mt-2">
        <Suggestion card={card} />

        <Block data-testid="impact" className="flex flex-col gap-1">
          <Label>What this affects</Label>
          <ul data-testid="impact-lines" className="flex flex-col gap-0.5">
            {card.impactLines.map(line => (
              <li key={line} data-testid="impact-line" className="text-sm">
                {line}
              </li>
            ))}
          </ul>
          <Candidates card={card} replies={replies} />
        </Block>

        <div className="flex flex-col gap-2 empty:hidden">
          <Banners banners={card.banners} prefix="card-banner" />
        </div>
        <Answer key={card.messageId} card={card} state={state} replies={replies} outcome={outcome} />
      </div>
    </section>
  );
}

function formatReceived(instant: string): string {
  const at = new Date(instant);
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

const FILTER_NAMES: Readonly<Record<QueueFilter, string>> = Object.freeze({
  all: 'in all',
  waiting: 'to answer',
  uncertain: 'uncertain',
});

/**
 * The period and the counts, as controls (criterion 5). Every number says it is today's;
 * the uncertain count is apart from the firm one, "3 to answer (+1 uncertain)"; and
 * each number opens the list it counts.
 */
function Counts({
  cards,
  filter,
  onFilter,
}: {
  readonly cards: readonly ReplySummary[];
  readonly filter: QueueFilter;
  onFilter(next: QueueFilter): void;
}): JSX.Element {
  const counts = countQueue(cards);
  const pill = (name: QueueFilter, count: number, testId: string): JSX.Element => (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={filter === name}
      onClick={() => onFilter(filter === name ? 'all' : name)}
      className={cn(
        'rounded-sm px-1 tabular transition-colors hover:bg-pressed',
        filter === name ? 'bg-selected font-medium text-foreground' : 'text-muted-foreground',
      )}
    >
      {`${String(count)} ${FILTER_NAMES[name]}`}
    </button>
  );
  return (
    <p data-testid="reply-counts" className="text-xs leading-5 text-muted-foreground">
      <span>Today:</span>{' '}
      {pill('waiting', counts.waiting, 'count-waiting')}
      {counts.uncertain === 0 ? null : (
        <span className="whitespace-nowrap">
          {' '}
          <span aria-hidden>(+</span>
          {pill('uncertain', counts.uncertain, 'count-uncertain')}
          <span aria-hidden>)</span>
        </span>
      )}{' '}
      <span aria-hidden>·</span> {pill('all', counts.all, 'count-all')}
    </p>
  );
}

export function RepliesView({ replies }: { readonly replies: Replies }): JSX.Element | null {
  const state = replies.state;
  const [filterText, setFilterText] = useKept('replies:filter', 'all');
  const filter = queueFilterOf(filterText);
  const [scrollText, setScrollText] = useKept('replies:scroll', '0');
  const list = useRef<HTMLUListElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedScroll = useRef(scrollText);
  savedScroll.current = scrollText;
  const restoredScroll = useRef(false);
  const remember = useRef(setScrollText);
  remember.current = setScrollText;
  const view = state === null ? null : buildReplyView(state, replies.chosen);
  const open = state?.open ?? null;

  useEffect(() => {
    // Restored once, when the lane first draws; afterwards the scroll is the person's.
    if (restoredScroll.current || state === null || scroller.current === null) return;
    restoredScroll.current = true;
    scroller.current.scrollTop = Number(savedScroll.current) || 0;
  }, [state]);

  useEffect(
    () => () => {
      // Leaving: keep where the list was and cancel a pending save.
      if (scrollTimer.current !== null) clearTimeout(scrollTimer.current);
    },
    [],
  );

  // Navigation keys never run a command (K4): they move focus among the rows that can take it,
  // skipping a row whose own command is on the wire, and focus never stays on a command button.
  const rows = (): HTMLButtonElement[] =>
    list.current === null ? [] : [...list.current.querySelectorAll<HTMLButtonElement>('[data-testid="reply-open"]')];
  const step = (by: 1 | -1): void => {
    const all = rows();
    const enabled = all.filter(row => !row.disabled);
    const leave = (): void => {
      if (document.activeElement instanceof HTMLElement && !all.includes(document.activeElement as HTMLButtonElement)) document.activeElement.blur();
    };
    if (enabled.length === 0) {
      leave();
      return;
    }
    const current = all.findIndex(row => row === document.activeElement);
    const anchor = current >= 0 ? current : all.findIndex(row => row.getAttribute('aria-current') === 'true');
    let target: HTMLButtonElement | undefined;
    if (anchor < 0) target = by === 1 ? enabled[0] : enabled[enabled.length - 1];
    else {
      const rest = by === 1 ? all.slice(anchor + 1) : all.slice(0, anchor).reverse();
      target = rest.find(row => !row.disabled) ?? (current >= 0 ? all[current] : undefined);
    }
    if (target === undefined || target.disabled) {
      leave();
      return;
    }
    target.focus();
  };
  useShortcuts({
    next: () => step(1),
    previous: () => step(-1),
    close: () => {
      if (open !== null) replies.close();
    },
  });

  if (state === null || view === null) {
    return (
      <div data-testid="replies-view" className="callie-v2 flex h-screen min-w-0 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
          <h1 data-testid="heading" className="text-sm font-semibold">
            Replies
          </h1>
        </header>
        {replies.failed ? (
          <EmptyState
            testId="reply-error"
            icon={<MailOpen />}
            title="Callie could not read the replies"
            actions={
              <Button variant="outline" size="sm" data-testid="reply-retry" onClick={replies.retry}>
                Try again
              </Button>
            }
          >
            Nothing was changed. Replies are never kept on this Mac, so there is nothing to show until this answers.
          </EmptyState>
        ) : (
          <div data-testid="reply-loading" aria-busy className="flex w-[340px] flex-col gap-3 px-4 py-4">
            <Skeleton className="w-3/4" />
            <Skeleton className="w-1/2" />
            <Skeleton className="w-2/3" />
          </div>
        )}
      </div>
    );
  }

  const ordered = orderQueue(state.cards);
  const shown = filterQueue(ordered, filter);
  const openId = open?.messageId ?? null;
  const outcome = replies.outcome;
  const outcomeOnPanel = outcome !== null && outcome.messageId === openId;
  const outcomeOnRow = outcome !== null && !outcomeOnPanel && shown.some(card => card.messageId === outcome.messageId);
  // A sentence about the lane itself (offline, a read's refusal) stays above the list; one
  // about a reply goes with that reply, and only a reply nowhere on screen falls back here.
  const listBanners = view.banners.filter(banner => !(outcome !== null && state.notice === outcome.code && banner.text === replyNotice(outcome.code)));
  const orphan = outcome !== null && !outcomeOnPanel && !outcomeOnRow ? outcome.code : null;

  return (
    <div
      data-testid="replies-view"
      aria-busy={replies.pending > 0}
      className="callie-v2 grid h-screen min-w-0 grid-cols-[minmax(280px,340px)_minmax(0,1fr)]"
    >
      <section data-region="reply-queue" aria-label="Replies" className="flex min-h-0 flex-col border-r border-border bg-sidebar">
        <header className="flex shrink-0 flex-col justify-center gap-0.5 border-b border-border px-4 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-baseline gap-2">
              <h1 data-testid="heading" className="text-sm font-semibold">
                Replies
              </h1>
              {state.businessDate === null ? null : (
                <span data-testid="business-date" className="text-xs text-faint tabular">
                  {state.businessDate}
                </span>
              )}
            </span>
            <span className="flex items-center gap-1">
              <span aria-hidden className="flex items-center gap-1 text-xs text-faint">
                <Kbd>J</Kbd>
                <Kbd>K</Kbd>
              </span>
              <Button variant="quiet" size="sm" data-testid="refresh" onClick={replies.refresh}>
                Refresh
              </Button>
            </span>
          </div>
          {state.cards.length === 0 ? null : <Counts cards={state.cards} filter={filter} onFilter={next => setFilterText(next)} />}
        </header>

        <div
          ref={scroller}
          data-testid="queue-list"
          className="min-h-0 flex-1 overflow-y-auto px-2 py-2"
          onScroll={event => {
            const top = event.currentTarget.scrollTop;
            if (scrollTimer.current !== null) clearTimeout(scrollTimer.current);
            scrollTimer.current = setTimeout(() => remember.current(String(Math.round(top))), 150);
          }}
        >
          <div data-testid="banners" className="flex flex-col gap-2 px-1 pb-2 empty:hidden">
            <Banners banners={listBanners} prefix="banner" />
            {orphan === null ? null : <Notice code={orphan} />}
            {replies.failed ? (
              <p data-testid="reply-read-failed" className="flex items-center gap-2 text-xs text-muted-foreground">
                Callie could not refresh the list.
                <Button variant="quiet" size="sm" data-testid="reply-retry" onClick={replies.retry}>
                  Try again
                </Button>
              </p>
            ) : null}
          </div>

          <ul data-testid="reply-list" ref={list} className="flex flex-col gap-px">
            {shown.map(summary => {
              const isOpen = summary.messageId === openId;
              const waiting = isWaiting(summary);
              const busy = replies.busy(summary.messageId);
              return (
                <li key={summary.messageId} data-testid="reply-summary" data-waiting={waiting ? 'true' : 'false'}>
                  <button
                    type="button"
                    data-testid="reply-open"
                    aria-current={isOpen ? 'true' : undefined}
                    disabled={busy}
                    {...(busy ? { 'aria-busy': true } : {})}
                    onClick={() => {
                      if (isOpen) replies.close();
                      else replies.open(summary.messageId);
                    }}
                    className={cn(
                      'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors disabled:opacity-60',
                      isOpen ? 'bg-selected' : 'hover:bg-pressed',
                    )}
                  >
                    <span aria-hidden className="flex h-5 items-center">
                      {waiting ? (
                        <span className={cn('size-1.5 rounded-full', isUncertain(summary) ? 'bg-faint' : 'bg-link')} />
                      ) : (
                        <span className="size-1.5 rounded-full border border-strong" />
                      )}
                    </span>
                    <span data-testid="summary-line" className="flex min-w-0 flex-1 flex-col">
                      <span className={cn('truncate text-sm', waiting || isOpen ? 'font-medium' : 'text-muted-foreground')}>{summary.firmName}</span>
                      <span className="truncate text-xs text-muted-foreground">{summaryDetail(summary)}</span>
                    </span>
                    <span className="tabular pt-0.5 text-xs text-faint">{formatReceived(summary.receivedAt)}</span>
                  </button>
                  {outcome !== null && outcome.messageId === summary.messageId && outcomeOnRow ? (
                    <div className="px-6 pb-1.5">
                      <Notice code={outcome.code} />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {view.emptyMessage !== null ? (
            <EmptyState testId="reply-empty" icon={<MailOpen />} title={view.emptyMessage} />
          ) : shown.length === 0 ? (
            <EmptyState testId="reply-filter-empty" title="Nothing here">
              <Button variant="quiet" size="sm" onClick={() => setFilterText('all')}>
                Show everything from today
              </Button>
            </EmptyState>
          ) : null}

          {view.classifierLine === null ? null : (
            <p data-testid="classifier-line" className="mt-4 px-2 text-xs text-faint">
              {view.classifierLine}
            </p>
          )}
        </div>
      </section>

      <div data-region="reply-panel" className="min-h-0 overflow-y-auto">
        {view.card === null ? (
          <EmptyState icon={<MailOpen />} title="Choose a reply to read it" testId="reply-panel-empty" className="h-full">
            Use J and K to move, Enter to open.
          </EmptyState>
        ) : (
          <Panel card={view.card} state={state} replies={replies} outcome={outcomeOnPanel ? outcome.code : null} />
        )}
      </div>
    </div>
  );
}
