/**
 * Read-only while something is under way (wave 1).
 *
 * Two things make the column read-only for a moment: a view's command in flight — a
 * second press of Save, Snooze or Confirm would otherwise send a second command while
 * the first was on the wire — and the launch update being put in place. Both set `inert`
 * on the same element, so each holds it under its own reason and the element is inert
 * while any reason holds it; one finishing never releases the other.
 *
 * `busyFor`, the per-view bookkeeping this file also held, went with the hand-rolled
 * views in 1.0.13: `app/useViewState.ts` counts a view's commands and calls this.
 */

const reasons = new WeakMap<HTMLElement, Set<string>>();

export function holdInert(element: HTMLElement, reason: string, on: boolean): void {
  const held = reasons.get(element) ?? new Set<string>();
  if (on) held.add(reason);
  else held.delete(reason);
  reasons.set(element, held);
  element.inert = held.size > 0;
  if (held.size > 0) element.setAttribute('aria-busy', 'true');
  else element.removeAttribute('aria-busy');
}
