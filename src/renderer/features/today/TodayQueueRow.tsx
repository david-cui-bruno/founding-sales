import type { TodayItem } from '../../../shared/contracts/todayContract';
import { Button } from '../../components/Button';
import { StatusPill } from '../../components/StatusPill';
import { TodayReason } from './TodayReason';

export type TodayQueueRowProps = {
  item: TodayItem;
  busy: boolean;
  /** Lane-local row above, or null when this row is already first. */
  pinComparedSalesCycleId: string | null;
  /** Lane-local row below, or null when this row is already last. */
  snoozeComparedSalesCycleId: string | null;
  onOpenLead(personId: string): void;
  onComplete(item: TodayItem): void;
  onSnooze(item: TodayItem, comparedSalesCycleId: string): void;
  onPin(item: TodayItem, comparedSalesCycleId: string): void;
};

const dueTime = (dueAt: string): string =>
  new Date(dueAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/**
 * One queue row: who, the matrix cell in separate bands, the primary
 * action with its due time, and the lane explanation. Pin and snooze are
 * lane-local pairwise commands; the row exposes no cross-lane movement.
 */
export function TodayQueueRow({
  item,
  busy,
  pinComparedSalesCycleId,
  snoozeComparedSalesCycleId,
  onOpenLead,
  onComplete,
  onSnooze,
  onPin,
}: TodayQueueRowProps) {
  const priority = item.priorityContext;

  return (
    <li className="today-row">
      <div className="today-row__lead">
        <button
          type="button"
          className="today-row__person"
          onClick={() => onOpenLead(item.personId)}
        >
          {item.personName}
        </button>
        {item.contextLabel !== null && (
          <span className="today-row__context">{item.contextLabel}</span>
        )}
        <span className="today-row__stage">{item.stage}</span>
        {item.pinned && <StatusPill>Pinned</StatusPill>}
      </div>
      {priority !== null && (
        <dl className="today-row__bands">
          <div className="today-row__band">
            <dt>Priority</dt>
            <dd>{priority.priority}</dd>
          </div>
          <div className="today-row__band">
            <dt>Fit</dt>
            <dd>{`${priority.fitBand} · ${priority.fitPoints}`}</dd>
          </div>
          <div className="today-row__band">
            <dt>Timing</dt>
            <dd>{`${priority.timingBand} · ${priority.timingValue}`}</dd>
          </div>
          <div className="today-row__band">
            <dt>Reach</dt>
            <dd>{priority.reachability}</dd>
          </div>
          <div className="today-row__band">
            <dt>Confidence</dt>
            <dd>{priority.dataConfidence}</dd>
          </div>
        </dl>
      )}
      <div className="today-row__action">
        <span className="today-row__action-label">{item.action.label}</span>
        <span className="today-row__action-channel">{item.action.channel}</span>
        <span className="today-row__action-due">Due {dueTime(item.action.dueAt)}</span>
        {item.action.overdue && <StatusPill tone="danger">Overdue</StatusPill>}
      </div>
      <TodayReason item={item} />
      <div className="today-row__commands">
        <Button
          variant="primary"
          disabled={busy}
          onClick={() => onComplete(item)}
        >
          Done
        </Button>
        <Button
          variant="quiet"
          disabled={busy || snoozeComparedSalesCycleId === null}
          onClick={() => {
            if (snoozeComparedSalesCycleId !== null) {
              onSnooze(item, snoozeComparedSalesCycleId);
            }
          }}
        >
          Snooze
        </Button>
        <Button
          variant="quiet"
          disabled={busy || pinComparedSalesCycleId === null}
          onClick={() => {
            if (pinComparedSalesCycleId !== null) {
              onPin(item, pinComparedSalesCycleId);
            }
          }}
        >
          Pin
        </Button>
      </div>
    </li>
  );
}
