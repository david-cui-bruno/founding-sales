import { useEffect, useId, useRef, useState } from 'react';

import type {
  LogPastActivityRequest,
  TodayItem,
} from '../../../shared/contracts/todayContract';
import { titleCaseDisplayName } from '../../../shared/displayText';
import { useModalDialog } from '../../app/useModalDialog';
import { Button } from '../../components/Button';
import { Select } from '../../components/Select';

export type LogPastActivityDialogProps = {
  item: Pick<TodayItem, 'personId' | 'salesCycleId' | 'personName'>;
  busy: boolean;
  onSubmit(request: LogPastActivityRequest): Promise<void>;
  onClose(): void;
};

type PastKind = LogPastActivityRequest['kind'];

const KIND_OPTIONS: ReadonlyArray<{ value: PastKind; label: string }> = [
  { value: 'call', label: 'Call' },
  { value: 'voicemail', label: 'Voicemail' },
  { value: 'text', label: 'Text' },
  { value: 'email', label: 'Email' },
  { value: 'note', label: 'Note' },
];

const todayLocalDate = (): string => {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/**
 * Small modal for "Log past activity": kind, date (defaults today, noon
 * local so it stays inside the founder's day), and a required summary.
 * Notes log as internal; everything else logs as outbound.
 */
export function LogPastActivityDialog({
  item,
  busy,
  onSubmit,
  onClose,
}: LogPastActivityDialogProps) {
  const titleId = useId();
  const [kind, setKind] = useState<PastKind>('call');
  const [date, setDate] = useState(todayLocalDate);
  const [summary, setSummary] = useState('');
  const [priceStated, setPriceStated] = useState(false);
  const pendingRef = useRef(false);
  const generation = useRef(0);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const modal = useModalDialog({ open: true, dialogRef, canDismiss: () => !pendingRef.current && !busy,
    onDismiss: onClose, initialFocus: () => summaryRef.current });
  const locked = busy || pending;
  const summaryRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setKind('call');
    setDate(todayLocalDate());
    setSummary('');
    setPriceStated(false);
    pendingRef.current = false;
    setPending(false); setFailed(false);
    generation.current++;
    return () => { generation.current++; };
  }, [item.personId, item.salesCycleId]);

  const submit = async () => {
    const trimmed = summary.trim();
    const occurredAt = new Date(`${date}T12:00:00`);
    if (busy || pendingRef.current || trimmed.length === 0 || !Number.isFinite(occurredAt.getTime()) || date > todayLocalDate()) return;
    pendingRef.current = true; setPending(true); setFailed(false);
    const current = generation.current;
    try { await onSubmit({
      personId: item.personId,
      salesCycleId: item.salesCycleId,
      kind,
      direction: kind === 'note' ? 'internal' : 'outbound',
      occurredAt: occurredAt.toISOString(),
      summary: trimmed,
      outcome: kind !== 'note' && priceStated ? 'price_said' : null,
    });
    } catch { if (generation.current === current) setFailed(true); }
    finally { if (generation.current === current) { pendingRef.current = false; setPending(false); } }
  };

  return (
    <dialog ref={dialogRef} aria-labelledby={titleId} className="today-dialog motion-dialog-in"
      onCancel={modal.onCancel} onKeyDown={modal.onKeyDown} onChange={() => setFailed(false)}>
        <h2 className="today-dialog__title" id={titleId}>
          {`Log past activity · ${titleCaseDisplayName(item.personName)}`}
        </h2>
        <div className="today-dialog__row">
          <Select<PastKind>
            label="Activity kind"
            disabled={locked}
            options={KIND_OPTIONS}
            value={kind}
            onChange={(value) => {
              setKind(value); setFailed(false);
              if (value === 'note') setPriceStated(false);
            }}
          />
          <label className="today-dialog__date-label">
            Date
            <input
              type="date"
              disabled={locked}
              className="today-dialog__date"
              value={date}
              max={todayLocalDate()}
              onChange={(event) => setDate(event.target.value)}
            />
          </label>
        </div>
        <label className="today-dialog__summary-label">
          What happened
          <textarea
            ref={summaryRef}
            disabled={locked}
            className="today-dialog__summary"
            rows={3}
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
          />
        </label>
        <label className="today-dialog__price">
          <input type="checkbox" checked={priceStated} disabled={kind === 'note' || locked}
            onChange={(event) => setPriceStated(event.target.checked)} />
          I stated the price
        </label>
        <p>Only for an actual past communication. Logging does not confirm an offer or payment.</p>
        {failed && <p role="alert">Past activity save was not confirmed. Your input is still here. Check Activity before logging it again.</p>}
        <div className="today-dialog__actions">
          <Button
            variant="primary"
            disabled={locked || summary.trim().length === 0}
            onClick={() => { void submit(); }}
          >
            Log activity
          </Button>
          <Button variant="quiet" disabled={locked} onClick={() => modal.requestDismiss('close-button')}>
            Cancel
          </Button>
        </div>
    </dialog>
  );
}
