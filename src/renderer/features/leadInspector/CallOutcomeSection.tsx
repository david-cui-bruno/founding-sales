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
export function CallOutcomeSection({ detail, api, onSaved }: CallOutcomeSectionProps) {
  const [outcome, setOutcome] = useState<CallOutcome | null>(null);
  const [callbackDate, setCallbackDate] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);

  const canSave = outcome !== null && !saving;

  const save = useCallback(() => {
    if (outcome === null || saving) return;
    setSaving(true);
    setFailed(false);
    const run = async () => {
      await api.logCallOutcome({
        personId: detail.personId,
        salesCycleId: detail.salesCycleId,
        outcome,
        callbackAt: callbackDate === '' ? null : callbackInstantFor(callbackDate),
        occurredAt: new Date().toISOString(),
      });
      const trimmed = note.trim();
      if (trimmed.length > 0) {
        await api.addLeadNote({
          personId: detail.personId,
          salesCycleId: detail.salesCycleId,
          text: trimmed,
        });
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
        setSaving(false);
        // Let the Today route (rendered underneath the overlay) refetch.
        window.dispatchEvent(new CustomEvent('callie:outcome-logged'));
        onSaved(nextPersonId);
      })
      .catch(() => {
        setSaving(false);
        setFailed(true);
      });
  }, [api, callbackDate, detail, note, outcome, onSaved, saving]);

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
          The outcome could not be saved. Try again.
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
