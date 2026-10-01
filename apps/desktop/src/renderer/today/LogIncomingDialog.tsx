import { useEffect, useId, useState, type JSX } from 'react';
import { reasonSentence } from '@fss/contracts';
import { INCOMING_CALL_OUTCOMES, type IncomingCallAnswer, type OperationInput } from '../../shared/operations.ts';
import { useClearDrafts, useDraft, useDrafts } from '../app/drafts.tsx';
import type { TodayCard } from '../todayContract.ts';
import { Button } from '../ui/button.tsx';
import { Dialog } from '../ui/dialog.tsx';
import { Input } from '../ui/input.tsx';
import { Select } from '../ui/select.tsx';
import { Textarea } from '../ui/textarea.tsx';
import { dense } from '../v2/parts.tsx';
import { cn } from '../lib/utils.ts';
import { noticeSentence } from '../todayView.ts';

/**
 * "Log incoming call" (slice S2): a callback that reached David's mobile, logged against
 * its firm and, when he knows who, its contact.
 *
 * Callie has no incoming leg — the caller ID of every call it places is his own number,
 * so a prospect who calls back calls him — and the call has to reach the firm's history
 * by hand. It is the ordinary call log (`POST /calls/log`) with `direction: 'inbound'`
 * (migration 0034): the same assignment rule, the same outcome effects, and never a
 * cadence attempt. When is required (it defaults to now) and so is what happened, because
 * every call log carries one of 9.1's outcomes; the length and the note are optional.
 * The form is a draft, so closing it or moving to another firm keeps what was typed — and
 * the firm it was typed about (S2 review, finding 3): the first edit writes the firm into
 * the draft, so a draft started on A still names A when the dialog is opened again on B,
 * until it is saved or discarded. Before any edit the form follows the firm on screen.
 */

const OUTCOME_LABELS: Readonly<Record<(typeof INCOMING_CALL_OUTCOMES)[number], string>> = Object.freeze({
  interested: 'Interested',
  callback_requested: 'Wants a call back',
  not_interested: 'Not interested',
  referral_or_wrong_person: 'Referred me to someone else',
});

export interface Contact {
  readonly contactId: string;
  readonly name: string;
}

/** `YYYY-MM-DDTHH:MM` for a `datetime-local`, on this Mac's clock. */
export function localDateTime(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function LogIncomingDialog({
  open,
  cards,
  firmId: initialFirmId,
  contactsFor,
  enabled,
  onClose,
  onLogged,
  log = async input => {
    const api = globalThis.callieApi;
    if (api === undefined) return { logged: false, reason: 'offline' };
    return await api.command('calls.logIncoming', input);
  },
  now = Date.now,
}: {
  readonly open: boolean;
  readonly cards: readonly TodayCard[];
  /** The firm on screen, which the form starts with. */
  readonly firmId: string | null;
  /** The people Callie knows at a firm: those named on its open card. */
  contactsFor(firmId: string): readonly Contact[];
  readonly enabled: boolean;
  onClose(): void;
  onLogged(firmId: string, answer: IncomingCallAnswer): void;
  readonly log?: (input: OperationInput<'calls.logIncoming'>) => Promise<IncomingCallAnswer>;
  readonly now?: () => number;
}): JSX.Element | null {
  const prefix = 'incoming:';
  const firmKey = `${prefix}firm`;
  const drafts = useDrafts();
  const started = drafts.values[firmKey] !== undefined;
  const [openedAt, setOpenedAt] = useState(() => now());
  const [firmId, setFirmId] = useDraft(firmKey, initialFirmId ?? cards[0]?.firmId ?? '');
  // Any edit pins the firm the form shows into the draft first, so what is typed stays
  // with that firm whatever is selected next.
  const pinned = (set: (value: string) => void) => (value: string): void => {
    if (!started) {
      drafts.set(firmKey, firmId);
      drafts.set(`${prefix}firmName`, cards.find(card => card.firmId === firmId)?.firmName ?? '');
    }
    set(value);
  };
  const [contactId, setContactId] = useDraft(`${prefix}contact`);
  const [when, setWhen] = useDraft(`${prefix}when`, localDateTime(openedAt));
  const [minutes, setMinutes] = useDraft(`${prefix}minutes`);
  const [outcome, setOutcome] = useDraft(`${prefix}outcome`);
  const [note, setNote] = useDraft(`${prefix}note`);
  const draftFirmName = drafts.values[`${prefix}firmName`] ?? '';
  const clear = useClearDrafts();
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const ids = { firm: useId(), contact: useId(), when: useId(), minutes: useId(), outcome: useId(), note: useId() };

  // Opening it starts at the firm on screen and at the current minute, unless a draft says
  // otherwise; nothing is written to the draft until somebody edits a field.
  useEffect(() => {
    if (!open) return;
    setRefusal(null);
    setOpenedAt(now());
    // Only when it opens: the draft owns the fields afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;
  const contacts = firmId === '' ? [] : contactsFor(firmId);
  const occurredAt = when === '' ? null : new Date(when);
  const minutesValue = minutes.trim() === '' ? null : Number(minutes);
  const minutesValid = minutesValue === null || (Number.isFinite(minutesValue) && minutesValue >= 0 && minutesValue <= 1440);
  const chosen = INCOMING_CALL_OUTCOMES.find(value => value === outcome) ?? null;
  const inFuture = occurredAt !== null && occurredAt.getTime() > now() + 60_000;
  const ready = enabled && firmId !== '' && chosen !== null && occurredAt !== null && !Number.isNaN(occurredAt.getTime()) && !inFuture && minutesValid && !busy;

  const submit = (): void => {
    if (!ready || occurredAt === null || chosen === null) return;
    setBusy(true);
    setRefusal(null);
    void log({
      firmId,
      contactId: contacts.some(entry => entry.contactId === contactId) ? contactId : null,
      occurredAt: occurredAt.toISOString(),
      durationSeconds: minutesValue === null ? null : Math.round(minutesValue * 60),
      outcome: chosen,
      note: note.trim(),
    })
      .then(
        answer => {
          if (answer.logged) {
            clear(prefix);
            onLogged(firmId, answer);
          } else setRefusal(answer.reason ?? 'refused');
        },
        () => {
          setRefusal('offline');
        },
      )
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Dialog
      open
      title="Log incoming call"
      onClose={onClose}
      data-testid="log-incoming-dialog"
      footer={
        <>
          {started ? (
            <Button
              variant="ghost"
              data-testid="incoming-discard"
              className={cn(dense.md, 'mr-auto text-muted-foreground')}
              onClick={() => {
                clear(prefix);
                setRefusal(null);
              }}
            >
              Discard draft
            </Button>
          ) : null}
          <Button variant="ghost" className={dense.md} onClick={onClose}>
            Cancel
          </Button>
          <Button data-testid="log-incoming-save" className={dense.md} disabled={!ready} onClick={submit} {...(busy ? { 'aria-busy': true } : {})}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {started && initialFirmId !== null && firmId !== initialFirmId ? (
          <p data-testid="incoming-draft-firm" className="rounded-md bg-warn-soft px-2.5 py-1.5 text-xs text-warn-ink">
            This draft is for {draftFirmName === '' ? 'another firm' : draftFirmName}, where you started it — not the firm on screen. Change the firm below or discard the draft.
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          A callback that reached your mobile. It goes on the firm’s history as an incoming call, and never counts as one of your call attempts.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <label htmlFor={ids.firm} className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            Firm
            <Select
              id={ids.firm}
              data-testid="incoming-firm"
              className="h-7 border-strong text-sm font-normal text-foreground"
              value={firmId}
              onChange={event => {
                setFirmId(event.target.value);
                drafts.set(`${prefix}firmName`, cards.find(card => card.firmId === event.target.value)?.firmName ?? '');
                setContactId('');
              }}
            >
              {cards.length === 0 && !started ? <option value="">No firm on today’s list</option> : null}
              {started && !cards.some(card => card.firmId === firmId) ? (
                <option value={firmId}>{draftFirmName === '' ? 'The firm this draft was started on' : draftFirmName}</option>
              ) : null}
              {cards.map(card => (
                <option key={card.firmId} value={card.firmId}>
                  {card.firmName}
                </option>
              ))}
            </Select>
          </label>
          <label htmlFor={ids.contact} className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            Who
            <Select
              id={ids.contact}
              data-testid="incoming-contact"
              className="h-7 border-strong text-sm font-normal text-foreground"
              value={contactId}
              onChange={event => pinned(setContactId)(event.target.value)}
            >
              <option value="">Not sure / the office</option>
              {contacts.map(contact => (
                <option key={contact.contactId} value={contact.contactId}>
                  {contact.name}
                </option>
              ))}
            </Select>
          </label>
          <label htmlFor={ids.when} className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            When
            <Input
              id={ids.when}
              data-testid="incoming-when"
              type="datetime-local"
              className="h-7 border-strong text-sm font-normal"
              value={when}
              onChange={event => pinned(setWhen)(event.target.value)}
            />
          </label>
          <label htmlFor={ids.minutes} className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            <span>
              Length <span className="font-normal text-faint">· minutes, optional</span>
            </span>
            <Input
              id={ids.minutes}
              data-testid="incoming-minutes"
              inputMode="numeric"
              className="h-7 border-strong text-sm font-normal"
              value={minutes}
              placeholder="5"
              onChange={event => pinned(setMinutes)(event.target.value)}
            />
          </label>
        </div>
        <label htmlFor={ids.outcome} className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
          What came of it
          <Select
            id={ids.outcome}
            data-testid="incoming-outcome"
            className="h-7 border-strong text-sm font-normal text-foreground"
            value={chosen ?? ''}
            onChange={event => pinned(setOutcome)(event.target.value)}
          >
            <option value="">Choose one…</option>
            {INCOMING_CALL_OUTCOMES.map(value => (
              <option key={value} value={value}>
                {OUTCOME_LABELS[value]}
              </option>
            ))}
          </Select>
        </label>
        <label htmlFor={ids.note} className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
          <span>
            Notes <span className="font-normal text-faint">· optional</span>
          </span>
          <Textarea
            id={ids.note}
            data-testid="incoming-note"
            rows={3}
            className="resize-none border-strong text-sm font-normal"
            value={note}
            maxLength={2000}
            placeholder="Wants to move the demo to Wednesday"
            onChange={event => pinned(setNote)(event.target.value)}
          />
        </label>
        {chosen === 'callback_requested' ? (
          <p className="text-xs text-muted-foreground">Today’s list gets “Callback — needs a time” for this firm, where you set the day.</p>
        ) : null}
        {inFuture ? <p className="text-xs text-danger-ink">That time is in the future.</p> : null}
        {!minutesValid ? <p className="text-xs text-danger-ink">The length is a number of minutes.</p> : null}
        {refusal === null ? null : (
          <p data-testid="incoming-refused" role="alert" className="text-xs text-danger-ink">
            {refusal === 'offline' ? 'Callie is offline. Nothing was saved; the form is kept.' : noticeSentence(refusal) || reasonSentence(refusal)}
          </p>
        )}
      </div>
    </Dialog>
  );
}
