import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  TriageLead,
  TriageQueue,
} from '../../../shared/contracts/todayContract';
import type { QualificationGateReason } from '../../../shared/contracts/leadDetailContract';
import { titleCaseDisplayName } from '../../../shared/displayText';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { Select } from '../../components/Select';
import { cloudSignalLabel, formatCloudChip } from '../leads/cloudSignalLabels';

export type TriageDecision = 'ready' | 'later' | 'dismiss';

export type TriageModeProps = {
  queue: TriageQueue;
  busy: boolean;
  /** Applies one decision to the current lead; the container refetches. */
  onDecide(lead: TriageLead, decision: TriageDecision, dismissReason: QualificationGateReason | null): void;
  /** Leaves triage mode; the persisted position already tracks decisions. */
  onExit(): void;
};

/** Founder-facing labels for the exact qualification gate reasons. */
const DISMISS_REASON_OPTIONS: ReadonlyArray<{
  value: QualificationGateReason;
  label: string;
}> = [
  { value: 'out_of_area', label: 'Out of area' },
  { value: 'no_relevant_decision_relationship', label: 'Not a decision maker' },
  { value: 'institutional_outside_icp', label: 'Institutional, outside ICP' },
  { value: 'harmful_operator', label: 'Harmful operator' },
  { value: 'non_paying_operator', label: 'Won\u2019t pay for tools' },
  { value: 'unresolved_duplicate', label: 'Unresolved duplicate' },
];

/**
 * Triage mode (audit 4.6): one unreviewed lead at a time, full width, with
 * a "Reviewing K of N" counter over a thin progress track. Keys: 1 = Ready
 * (the confirm-ready transition), 2 = Later (+30 days resurface), 3 = Not a
 * fit (whale's Dismiss reason Select; Esc backs out of the reason picker).
 * Esc exits triage saving the resume position.
 */
export function TriageMode({ queue, busy, onDecide, onExit }: TriageModeProps) {
  // The queue refetches after every decision with an advanced persisted
  // position, so the counter derives entirely from the queue itself.
  const [dismissing, setDismissing] = useState(false);
  const [dismissReason, setDismissReason] =
    useState<QualificationGateReason | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const lead = queue.items[0] ?? null;
  const totalThisPass = queue.position + queue.items.length;
  const reviewingIndex = queue.position + 1;
  const percent = totalThisPass === 0
    ? 100
    : Math.round((queue.position / totalThisPass) * 100);

  useEffect(() => {
    rootRef.current?.focus();
  }, [lead?.salesCycleId, dismissing]);

  const decide = useCallback(
    (decision: TriageDecision, reason: QualificationGateReason | null) => {
      if (lead === null || busy) return;
      setDismissing(false);
      setDismissReason(null);
      onDecide(lead, decision, reason);
    },
    [busy, lead, onDecide],
  );

  const exit = useCallback(() => {
    onExit();
  }, [onExit]);

  const exitRef = useRef(onExit);
  exitRef.current = onExit;
  useEffect(() => {
    if (lead === null) {
      // Pass complete: leave triage. The container resets the saved
      // position because the queue is empty.
      exitRef.current();
    }
  }, [lead]);

  if (lead === null) {
    return null;
  }

  const name = titleCaseDisplayName(lead.personName);

  return (
    <div
      ref={rootRef}
      className="triage"
      role="region"
      aria-label="Review unreviewed leads"
      tabIndex={-1}
      onKeyDown={(event) => {
        const target = event.target as HTMLElement;
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
          return;
        }
        switch (event.key) {
          case 'Escape':
            event.preventDefault();
            if (dismissing) {
              setDismissing(false);
              setDismissReason(null);
            } else {
              exit();
            }
            return;
          case '1':
            event.preventDefault();
            decide('ready', null);
            return;
          case '2':
            event.preventDefault();
            decide('later', null);
            return;
          case '3':
            event.preventDefault();
            setDismissing(true);
            return;
          default:
        }
      }}
    >
      <header className="triage__header">
        <p className="triage__counter">
          {`Reviewing ${reviewingIndex} of ${totalThisPass}`}
        </p>
        <div
          className="triage__progress"
          role="progressbar"
          aria-label="Triage progress"
          aria-valuemin={0}
          aria-valuemax={totalThisPass}
          aria-valuenow={reviewingIndex - 1}
        >
          <div className="triage__progress-fill" style={{ width: `${percent}%` }} />
        </div>
        <Button variant="quiet" onClick={exit}>
          Done for now
        </Button>
      </header>

      <article className="triage__card" aria-label={`${name} triage`}>
        <div className="triage__identity">
          <Avatar name={lead.personName} />
          <div className="triage__identity-text">
            <h2 className="triage__name">{name}</h2>
            {lead.contextLabel !== null && (
              <p className="triage__context">{lead.contextLabel}</p>
            )}
          </div>
          {lead.cloudScores !== null && (
            <span className="triage__cloud-chip">
              {formatCloudChip(lead.cloudScores)}
            </span>
          )}
        </div>
        {lead.cloudSignals.length > 0 && (
          <ul className="triage__signals" aria-label="Cloud signals">
            {lead.cloudSignals.map((signal) => (
              <li key={signal}>{cloudSignalLabel(signal)}</li>
            ))}
          </ul>
        )}
        <dl className="triage__facts">
          {lead.propertySummary !== null && (
            <div>
              <dt>Property</dt>
              <dd>{lead.propertySummary}</dd>
            </div>
          )}
          {lead.phone !== null && (
            <div>
              <dt>Phone</dt>
              <dd>{lead.phone}</dd>
            </div>
          )}
          {lead.email !== null && (
            <div>
              <dt>Email</dt>
              <dd>{lead.email}</dd>
            </div>
          )}
        </dl>

        {!dismissing ? (
          <div className="triage__actions">
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => decide('ready', null)}
            >
              Ready · 1
            </Button>
            <Button
              variant="quiet"
              disabled={busy}
              onClick={() => decide('later', null)}
            >
              Later · 2
            </Button>
            <Button
              variant="quiet"
              disabled={busy}
              onClick={() => setDismissing(true)}
            >
              Not a fit · 3
            </Button>
          </div>
        ) : (
          <div className="triage__dismiss">
            <Select<QualificationGateReason>
              label="Dismissal reason"
              options={DISMISS_REASON_OPTIONS}
              value={dismissReason ?? DISMISS_REASON_OPTIONS[0]!.value}
              onChange={setDismissReason}
            />
            <div className="triage__actions">
              <Button
                variant="danger"
                disabled={busy}
                onClick={() =>
                  decide('dismiss', dismissReason ?? DISMISS_REASON_OPTIONS[0]!.value)
                }
              >
                Confirm dismiss
              </Button>
              <Button
                variant="quiet"
                onClick={() => {
                  setDismissing(false);
                  setDismissReason(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </article>
    </div>
  );
}
