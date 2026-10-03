import { useCallback, useEffect, useReducer } from 'react';
import type { MeetingBriefResponse } from '@fss/contracts';
import { useSessionEpoch } from '../app/drafts.tsx';

/**
 * What the Meetings rows' "Brief" disclosure keeps beyond the row that drew it (lane M2;
 * kept-state rules K1, K3, K7), on the pattern of `attendanceMemory.ts`: a module-level store
 * keyed by the drafts provider's epoch, which `App` replaces on every sign-out, workspace
 * change and new session, so the next person never sees a brief somebody else opened (K1).
 *
 * By meeting id:
 *   * `open` — the meetings whose brief is open; leaving the firm and coming back keeps it (K3);
 *   * `briefs` — the last brief read for the meeting, shown while a newer read is under way;
 *   * `unavailable` — the meetings whose last read did not answer;
 *   * `generation` — the number of the meeting's newest read: an answer from an older read,
 *     or one naming another meeting, is dropped (K7).
 */

export interface BriefMemory {
  readonly open: Set<string>;
  readonly briefs: Map<string, MeetingBriefResponse>;
  readonly unavailable: Set<string>;
  readonly generation: Map<string, number>;
}

const fresh = (): BriefMemory => ({ open: new Set(), briefs: new Map(), unavailable: new Set(), generation: new Map() });

let current: { epoch: object | null; memory: BriefMemory } = { epoch: null, memory: fresh() };
const listeners = new Set<() => void>();

/** The memory for this session: a new drafts epoch starts clean (K1). */
export function briefMemoryFor(epoch: object | null): BriefMemory {
  if (current.epoch !== epoch) current = { epoch, memory: fresh() };
  return current.memory;
}

/** Tests: forget everything, as a sign-out does. */
export function resetBriefMemory(): void {
  current = { epoch: null, memory: fresh() };
}

/** The memory of whoever is signed in now, and `touch()`, which redraws every reader. */
export function useBriefMemory(): { readonly memory: BriefMemory; touch(): void } {
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
    for (const listener of [...listeners]) listener();
  }, []);
  return { memory: briefMemoryFor(useSessionEpoch()), touch };
}
