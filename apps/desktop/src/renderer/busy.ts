/**
 * Read-only while something is under way (wave 1).
 *
 * Two things make the column read-only for a moment: a view's command in flight — a
 * second press of Save, Snooze or Confirm used to send a second command while the first
 * was on the wire — and the launch update being put in place. Both set `inert` on the
 * same element, so each holds it under its own reason and the element is inert while
 * any reason holds it; one finishing never releases the other.
 *
 * The rule is about the *column*, not about whichever node a view happens to draw into.
 * Since 1.0.12 a hand-rolled view is mounted inside a container the React shell gives it,
 * so `busyFor` climbs to the column it is in; a view mounted on its own — a unit test —
 * holds the element it was given, as before.
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

export interface Busy {
  /** The command's answer; the view is read-only until it arrives. */
  run<T>(next: Promise<T>): Promise<T>;
  /** The view was mounted again or left: nothing it started holds the column any more. */
  reset(): void;
}

let views = 0;

/** The column a view is drawn in, or the view's own element when it is not in one. */
function columnOf(element: HTMLElement | null): HTMLElement | null {
  if (element === null) return null;
  const column = element.closest('[data-region="column"]');
  return column instanceof HTMLElement ? column : element;
}

/** One view's in-flight commands, holding its column read-only while any is pending. */
export function busyFor(target: () => HTMLElement | null): Busy {
  views += 1;
  const reason = `command-${String(views)}`;
  let pending = 0;
  let epoch = 0;
  let held: HTMLElement | null = null;

  const settle = (): void => {
    if (held === null) return;
    holdInert(held, reason, pending > 0);
    if (pending === 0) held = null;
  };

  return {
    async run(next) {
      const mine = epoch;
      pending += 1;
      held = held ?? columnOf(target());
      settle();
      try {
        return await next;
      } finally {
        if (mine === epoch) {
          pending -= 1;
          settle();
        }
      }
    },
    reset() {
      epoch += 1;
      pending = 0;
      settle();
    },
  };
}
