/**
 * The two ways this app writes a date on screen (1.0.13).
 *
 * Until 1.0.13 half the views printed an ISO instant — `2026-09-25T14:00:00.000Z` — in
 * the middle of an English sentence, which is a machine's spelling of a date in a place
 * a person reads. These are the two a person reads, in the Mac's own locale, and each
 * falls back to the string it was given rather than to "Invalid Date".
 */

/** "25 Sep 2026". */
export function shortDay(instant: string | null): string {
  if (instant === null || instant === '') return '—';
  const at = new Date(instant);
  if (!Number.isFinite(at.getTime())) return instant;
  try {
    return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(at);
  } catch {
    return instant;
  }
}

/** "25 Sep 2026, 14:00". */
export function shortDayTime(instant: string | null): string {
  if (instant === null || instant === '') return '—';
  const at = new Date(instant);
  if (!Number.isFinite(at.getTime())) return instant;
  try {
    return new Intl.DateTimeFormat(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(at);
  } catch {
    return instant;
  }
}

/**
 * A stable code as words: `firm_zone_unknown` becomes "firm zone unknown".
 *
 * For the places where the server's vocabulary is the only name a thing has — a hold's
 * reason, the kinds of action it blocks. A sentence per code would be a second list to
 * keep correct, and a code with underscores on screen is a bug report for a person who
 * cannot file one; this is the middle.
 */
export function inWords(code: string): string {
  return code.replaceAll('_', ' ');
}
