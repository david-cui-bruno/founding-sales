import type { TodayItem } from '../../../shared/contracts/todayContract';
import { StatusPill } from '../../components/StatusPill';

export type TodayReasonProps = {
  item: TodayItem;
};

const triggerExpiry = (expiresAt: string | null): string =>
  expiresAt === null
    ? ''
    : ` (until ${new Date(expiresAt).toLocaleString()})`;

/**
 * Explains why a row is in its lane: the domain-provided reason, active
 * triggers with their expirations, Verify First, and any consent
 * requirement. Copy comes from the strict snapshot only.
 */
export function TodayReason({ item }: TodayReasonProps) {
  return (
    <div className="today-reason">
      <p className="today-reason__text">{item.reason}</p>
      {item.activeTriggers.length > 0 && (
        <ul className="today-reason__triggers">
          {item.activeTriggers.map((trigger) => (
            <li key={trigger.label} className="today-reason__trigger">
              {trigger.label}
              {triggerExpiry(trigger.expiresAt)}
            </li>
          ))}
        </ul>
      )}
      <div className="today-reason__flags">
        {item.verifyFirst && <StatusPill tone="urgent">Verify first</StatusPill>}
        {item.consentRequirement !== null && (
          <span className="today-reason__consent">{item.consentRequirement}</span>
        )}
      </div>
    </div>
  );
}
