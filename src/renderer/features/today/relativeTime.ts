/**
 * Display-only relative due-time formatting for the Today queue: "due 9:38 AM"
 * for later today, "due 2h ago" once overdue, "due Mon" inside a week, and a
 * short date beyond that. Pure and injectable so tests pin `now`.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const sameLocalDay = (left: Date, right: Date): boolean =>
  left.getFullYear() === right.getFullYear()
  && left.getMonth() === right.getMonth()
  && left.getDate() === right.getDate();

export const formatDueTimestamp = (dueAtIso: string, now: Date = new Date()): string => {
  const due = new Date(dueAtIso);
  if (Number.isNaN(due.getTime())) {
    return 'due date unknown';
  }
  const diffMs = due.getTime() - now.getTime();
  if (diffMs < -45_000) {
    const overdueMs = -diffMs;
    if (overdueMs < HOUR_MS) {
      return `due ${Math.max(1, Math.round(overdueMs / MINUTE_MS))}m ago`;
    }
    if (overdueMs < DAY_MS) {
      return `due ${Math.round(overdueMs / HOUR_MS)}h ago`;
    }
    return `due ${Math.round(overdueMs / DAY_MS)}d ago`;
  }
  if (diffMs <= 45_000) {
    return 'due now';
  }
  if (sameLocalDay(due, now)) {
    return `due ${due.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  if (diffMs < 6 * DAY_MS) {
    return `due ${due.toLocaleDateString([], { weekday: 'short' })}`;
  }
  return `due ${due.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
};
