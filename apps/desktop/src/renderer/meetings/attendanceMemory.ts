import { useCallback, useEffect, useReducer } from 'react';
import type { MeetingAttendanceChoice, MeetingAttendanceSet } from '@fss/contracts';
import { useSessionEpoch } from '../app/drafts.tsx';

/**
 * What the firm page's attendance controls keep beyond the row that drew them (lane M1;
 * kept-state rules K1, K3, K6, K7), on the pattern of `calling/correctionMemory.ts`: a
 * module-level store keyed by the drafts provider's epoch, which `App` replaces on every
 * sign-out, workspace change and new session, so the next person never inherits a command, an
 * answer or a note (K1).
 *
 * By meeting id:
 *   * `commands` — the Attended / No-show / Undo sent with no definite answer yet. Retry resends
 *     exactly it, under its id, so the server answers it from its receipt (K3).
 *   * `inFlight` — the meetings whose command is on the wire now.
 *   * `notes` — the sentence the last answer earned, shown beside that meeting and no other.
 *   * `answered` — a success answer and the success clock it moved to, shown over any read that
 *     began before it (K6: the answer clears the pending command; K7: an older read never puts
 *     the old state back). A read clears only the answers it began after (review M1R,
 *     finding 5): one that began earlier and lands in the same turn as the answer leaves it.
 *
 * `clock` counts this session's successful answers; a read notes it when it begins.
 *
 * By firm id, `successes` counts the answers that changed a meeting there: a read that began
 * under an older count is stale and is dropped, and the row reads again (K7).
 */

/** A command sent and not yet definitely answered: its id and exactly what it asked. */
export interface AttendanceCommand {
  readonly id: string;
  readonly firmId: string;
  readonly attendance: MeetingAttendanceChoice;
}

export interface AttendanceNote {
  readonly text: string;
  readonly alert: boolean;
}

/** A success answer, and the success clock it moved to. */
export interface AttendanceAnswer {
  readonly set: MeetingAttendanceSet;
  readonly at: number;
}

export interface AttendanceMemory {
  readonly commands: Map<string, AttendanceCommand>;
  readonly inFlight: Set<string>;
  readonly notes: Map<string, AttendanceNote>;
  readonly answered: Map<string, AttendanceAnswer>;
  readonly successes: Map<string, number>;
  readonly clock: { now: number };
}

const fresh = (): AttendanceMemory => ({
  commands: new Map(),
  inFlight: new Set(),
  notes: new Map(),
  answered: new Map(),
  successes: new Map(),
  clock: { now: 0 },
});

let current: { epoch: object | null; memory: AttendanceMemory } = { epoch: null, memory: fresh() };
const listeners = new Set<() => void>();

/** The memory for this session: a new drafts epoch starts clean (K1). */
export function attendanceMemoryFor(epoch: object | null): AttendanceMemory {
  if (current.epoch !== epoch) current = { epoch, memory: fresh() };
  return current.memory;
}

/** Redraw every row reading the memory: an answer arrived, perhaps after its sender left. */
export function announceAttendance(): void {
  for (const listener of [...listeners]) listener();
}

/** Tests: forget everything, as a sign-out does. */
export function resetAttendanceMemory(): void {
  current = { epoch: null, memory: fresh() };
}

/** The memory of whoever is signed in now, and `touch()`, which redraws every reader. */
export function useAttendanceMemory(): { readonly memory: AttendanceMemory; touch(): void } {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const listener = (): void => {
      bump();
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  const touch = useCallback((): void => {
    bump();
    announceAttendance();
  }, []);
  return { memory: attendanceMemoryFor(useSessionEpoch()), touch };
}
