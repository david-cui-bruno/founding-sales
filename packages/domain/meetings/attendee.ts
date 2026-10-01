/**
 * A meeting attendee's address: one normalization for every place that reads or
 * suppresses it (Cal.com slice M1, review fold 2, finding 3 (i)).
 *
 * The webhook parser (`meetings/calcom.ts`), the reconciliation parser
 * (`meetings/reconcile.ts`), the deletion's tombstones (`retention/deletion.ts`) and the
 * reconciliation's tombstone check all spell an address the way the suppression
 * canonicalizer does before it validates (`src/rules/suppressionCanonicalization.ts`,
 * `canonicalizeEmail`): NFKC, trimmed, lower-cased. For an address that canonicalizer
 * accepts, the stored attendee *is* its canonical handle. For one it refuses — a
 * non-ASCII local part such as `josé@law.example` — the same spelling is the tombstone's
 * key (`deletionTombstoneKeyOf`), written as a `deletion_tombstone` handle suppression by
 * the deletion and read back the same way by the reconciliation. So every address a
 * meeting may hold is either a canonical handle or a fallback key, and none is skipped.
 */

const SHAPE = /^[^@\s]+@[^@\s]+$/u;

/** The spelling an attendee address is stored and suppressed under, or null. */
export function attendeeAddressOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFKC').trim().toLowerCase();
  return normalized.length > 0 && normalized.length <= 320 && SHAPE.test(normalized) ? normalized : null;
}

/**
 * The key a deletion tombstones a meeting attendee under, and the key the
 * reconciliation looks up. The canonical handle for an address the suppression
 * canonicalizer accepts (the two are the same string), the normalized address for one
 * it refuses.
 */
export function deletionTombstoneKeyOf(address: string): string | null {
  return attendeeAddressOf(address);
}
