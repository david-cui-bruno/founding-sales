import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { MutationReceipt } from '../../../shared/contracts/commonContract';
import type { LeadDetail } from '../../../shared/contracts/leadDetailContract';
import type {
  AddLeadNoteRequest,
  CallOutcome,
  LogCallOutcomeRequest,
  TodaySnapshot,
} from '../../../shared/contracts/todayContract';
import { Button } from '../../components/Button';

export type CallOutcomeApi = {
  logCallOutcome(input: LogCallOutcomeRequest): Promise<MutationReceipt>;
  addLeadNote(input: AddLeadNoteRequest): Promise<MutationReceipt>;
  get(): Promise<TodaySnapshot>;
};

export type CallOutcomeSectionProps = {
  detail: LeadDetail;
  api: CallOutcomeApi;
  outboundCommandId?: string;
  /** Called after a save: the next queue lead to open, or null for Today. */
  onSaved(nextPersonId: string | null): void;
};

const OUTCOME_OPTIONS: ReadonlyArray<{ value: CallOutcome; label: string }> = [
  { value: 'no_answer', label: 'No answer' },
  { value: 'voicemail', label: 'Voicemail' },
  { value: 'spoke', label: 'Spoke' },
  { value: 'interview_booked', label: 'Interview booked' },
  { value: 'not_interested', label: 'Not interested' },
  { value: 'opted_out', label: 'Opted out' },
];

/** Noon local on the chosen day keeps the callback inside working hours. */
const callbackInstantFor = (localDate: string): string =>
  new Date(`${localDate}T12:00:00`).toISOString();

const tomorrowLocalDate = (): string => {
  const date = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/**
 * The call outcome section (audit 4.7) on the lead full page: one outcome
 * chip row (single select), an optional promised-callback date, an optional
 * founder note, and [Save & next] (Cmd+Enter) which logs the structured
 * outcome and moves to the next queue lead. A callback date writes the
 * cycle's resurface marker through logCallOutcome.
 */
export function CallOutcomeSection({ detail, api, onSaved, outboundCommandId }: CallOutcomeSectionProps) {
  const [outcome, setOutcome] = useState<CallOutcome | null>(null);
  const [callbackDate, setCallbackDate] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);

  const pendingRef = useRef(false);
  const submittedRef = useRef<LogCallOutcomeRequest | null>(null);
  const submittedCallbackDateRef = useRef<string | null>(null);
  const outcomeSavedRef = useRef(false);
  const noteSavedRef = useRef(false);
  const activeRef = useRef(true);
  useEffect(() => { activeRef.current = true; return () => { activeRef.current = false; }; }, []);
  const canSave = outcome !== null && !saving;

  const save = useCallback(() => {
    if (outcome === null || pendingRef.current) return;
    pendingRef.current = true;
    setSaving(true);
    setFailed(false);
    const run = async () => {
      const previous = submittedRef.current;
      const unchangedLinkedRequest = outboundCommandId !== undefined && previous !== null
        && previous.outboundCommandId === outboundCommandId && previous.personId === detail.personId
        && previous.salesCycleId === detail.salesCycleId && previous.outcome === outcome
        && submittedCallbackDateRef.current === callbackDate;
      const request: LogCallOutcomeRequest = unchangedLinkedRequest ? previous : {
        personId: detail.personId,
        salesCycleId: detail.salesCycleId,
        outcome,
        callbackAt: callbackDate === '' ? null : callbackInstantFor(callbackDate),
        occurredAt: outboundCommandId === undefined ? new Date().toISOString() : submittedRef.current?.occurredAt ?? new Date().toISOString(),
        ...(outboundCommandId === undefined ? {} : { outboundCommandId }),
      };
      submittedRef.current = request;
      submittedCallbackDateRef.current = callbackDate;
      if (!outcomeSavedRef.current) {
        await api.logCallOutcome(request);
        outcomeSavedRef.current = true;
      }
      const trimmed = note.trim();
      if (trimmed.length > 0 && !noteSavedRef.current) {
        await api.addLeadNote({
          personId: detail.personId,
          salesCycleId: detail.salesCycleId,
          text: trimmed,
        });
        noteSavedRef.current = true;
      }
      // Next queue lead: the first row of the first non-empty lane that is
      // not the person just called.
      const snapshot = await api.get();
      const next = snapshot.lanes
        .flatMap((lane) => lane.items)
        .find((item) => item.personId !== detail.personId);
      return next?.personId ?? null;
    };
    run()
      .then((nextPersonId) => {
        pendingRef.current = false;
        if (!activeRef.current) return;
        setSaving(false);
        // Let the Today route (rendered underneath the overlay) refetch.
        window.dispatchEvent(new CustomEvent('callie:outcome-logged'));
        onSaved(nextPersonId);
      })
      .catch(() => {
        pendingRef.current = false;
        if (!activeRef.current) return;
        setSaving(false);
        setFailed(true);
      });
  }, [api, callbackDate, detail, note, outcome, onSaved, outboundCommandId]);

  // Cmd+Enter saves from anywhere inside the section.
  const onKeyDown = useMemo(
    () => (event: KeyboardEvent) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        if (
          sectionRef.current !== null &&
          event.target instanceof Node &&
          sectionRef.current.contains(event.target)
        ) {
          event.preventDefault();
          save();
        }
      }
    },
    [save],
  );

  useEffect(() => {
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onKeyDown]);

  return (
    <section
      ref={sectionRef}
      className="call-outcome"
      aria-label="Call outcome"
    >
      <h3 className="call-outcome__title">Call outcome</h3>
      {outboundCommandId !== undefined && <p>Requested manual association: {outboundCommandId}. The saved command must match this person and cycle.</p>}
      <div
        className="call-outcome__chips"
        role="group"
        aria-label="Outcome"
      >
        {OUTCOME_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            className="call-outcome__chip"
            disabled={saving || outcomeSavedRef.current}
            aria-pressed={outcome === option.value}
            onClick={() =>
              setOutcome((current) =>
                current === option.value ? null : option.value,
              )
            }
          >
            {option.label}
          </button>
        ))}
      </div>
      <div className="call-outcome__details">
        <label className="call-outcome__callback-label">
          Callback promised
          <input
            disabled={saving || outcomeSavedRef.current}
            type="date"
            className="call-outcome__callback"
            value={callbackDate}
            min={tomorrowLocalDate()}
            onChange={(event) => setCallbackDate(event.target.value)}
          />
        </label>
        <label className="call-outcome__note-label">
          Note
          <textarea
            disabled={saving || noteSavedRef.current}
            className="call-outcome__note"
            rows={2}
            placeholder="Optional. Stays on this machine."
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
      </div>
      {failed && (
        <p className="call-outcome__error" role="alert">
          {outcomeSavedRef.current
            ? 'The outcome was saved. The separate note or next-lead request failed.'
            : outboundCommandId !== undefined
              ? 'The linked outcome could not be confirmed. The command must match this person and cycle. Your request is retained. Nothing will be saved unlinked automatically.'
              : 'The outcome could not be saved. Try again.'}
        </p>
      )}
      <div className="call-outcome__actions">
        <Button variant="primary" disabled={!canSave} onClick={save}>
          Save &amp; next
        </Button>
        <span className="call-outcome__hint">⌘⏎ saves · Esc back to Today</span>
      </div>
    </section>
  );
}
