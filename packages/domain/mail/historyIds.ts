/**
 * Gmail history ids, read and compared without losing a digit.
 *
 * Google types every history id as `{"type": "string", "format": "uint64"}` in the
 * Gmail discovery document (`History.id`, `ListHistoryResponse.historyId`,
 * `Profile.historyId`, `WatchResponse.historyId`): a decimal string of up to twenty
 * digits. JavaScript's `Number` is exact only to 2^53 - 1, so `Number('9007199254740993')`
 * is `9007199254740992` and two different ids compare equal. Every comparison of two
 * history ids in this lane goes through `compareHistoryIds`, which is `BigInt`, and
 * nothing converts one to a `Number` (lane g76, audit item C08).
 *
 * `mailboxes.history_id` is `text` with `CHECK (history_id ~ '^[0-9]{1,20}$')`
 * (migration 0009), so the database stores exactly what Gmail sent. `HISTORY_ID_PATTERN`
 * is the same pattern, and `historyIdOf` refuses anything the column would refuse, so a
 * malformed id fails at the adapter with a named error instead of at the compare-and-set.
 */

export const HISTORY_ID_PATTERN = /^[0-9]{1,20}$/;

/**
 * A history id from a JSON value, or null.
 *
 * Google sends a string. A JSON number is accepted only while it is a safe integer,
 * because a larger one was already rounded by `JSON.parse` before this function saw
 * it, and a rounded cursor is a cursor that points somewhere Gmail never was.
 */
export function historyIdOf(value: unknown): string | null {
  if (typeof value === 'string') return HISTORY_ID_PATTERN.test(value) ? value : null;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

/** Negative, zero or positive as `left` is earlier than, the same as or later than `right`. */
export function compareHistoryIds(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The later of two history ids, and `left` when they are the same id. */
export function laterHistoryId(left: string, right: string): string {
  return compareHistoryIds(right, left) > 0 ? right : left;
}
