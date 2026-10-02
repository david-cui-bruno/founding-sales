import { useCallback, useEffect, useReducer } from 'react';
import type { OperationInput } from '../../shared/operations.ts';
import { useSessionEpoch } from '../app/drafts.tsx';

/**
 * What "Change outcome" (`ChangeOutcome.tsx`, S3X lane X2) keeps beyond the control that drew
 * it (kept-state rules K1, K3, K5, K6), on the pattern of Today's `keptCommands.ts` and
 * `crmMemory.ts`: a module-level store keyed by the drafts provider's epoch, which `App`
 * replaces on every sign-out, workspace change and new session, so the next person never
 * inherits a command, an answer or a pending lift (K1).
 *
 * By call log id: the correction sent with no definite answer yet (Retry resends exactly it,
 * under its id), its last answer, whether the review is open, and the stops David marked "Lift
 * stop…" whose own confirm is still to come. By stop event id: a lift with no definite answer
 * and why the last one did not happen. The control is drawn on Today and on the firm page; this
 * is where its command outlives either (K3).
 */

/** A correction that was sent and has no definite answer yet: its id, its body, and the drafts it was built from. */
export interface CorrectionCommand {
  readonly id: string;
  readonly body: Omit<OperationInput<'calling.correctOutcome'>, 'commandId'>;
  readonly drafts: Readonly<Record<string, string>>;
}

/** The last answer to a log's correction, shown in place (`role=status` or `alert`). */
export interface CorrectionNote {
  readonly text: string;
  readonly alert: boolean;
  /** Set by a refusal that means the review went stale: the preview is read again. */
  readonly reload?: number;
}

/** A stop David marked "Lift stop…": its own confirm opens after the correction saved. */
export interface LiftEntry {
  readonly eventId: string;
  readonly scope: 'firm' | 'handle';
  readonly channel: 'phone' | 'email' | 'all';
  readonly canonicalKey: string | null;
}

export interface CorrectionMemory {
  readonly corrections: Map<string, CorrectionCommand>;
  readonly notes: Map<string, CorrectionNote>;
  readonly open: Set<string>;
  readonly lifts: Map<string, readonly LiftEntry[]>;
  readonly liftCommands: Map<string, string>;
  readonly liftNotes: Map<string, string>;
  /** Keys (`<logId>` or `lift:<eventId>`) whose request is on the wire now. */
  readonly inFlight: Set<string>;
}

const fresh = (): CorrectionMemory => ({
  corrections: new Map(),
  notes: new Map(),
  open: new Set(),
  lifts: new Map(),
  liftCommands: new Map(),
  liftNotes: new Map(),
  inFlight: new Set(),
});

let current: { epoch: object | null; memory: CorrectionMemory } = { epoch: null, memory: fresh() };
const listeners = new Set<() => void>();

/** The memory for this session: a new drafts epoch starts clean. */
export function correctionMemoryFor(epoch: object | null): CorrectionMemory {
  if (current.epoch !== epoch) current = { epoch, memory: fresh() };
  return current.memory;
}

/** Redraw every control reading the memory: an answer arrived, perhaps after its sender left. */
export function announceCorrections(): void {
  for (const listener of [...listeners]) listener();
}

/** Tests: forget everything, as a sign-out does. */
export function resetCorrectionMemory(): void {
  current = { epoch: null, memory: fresh() };
}

/**
 * The memory of whoever is signed in now, and `touch()`, which redraws this control at once and
 * every other one reading the memory (a change made by a click lands even before the listener
 * of a control that has just mounted is subscribed).
 */
export function useCorrectionMemory(): { readonly memory: CorrectionMemory; touch(): void } {
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
    announceCorrections();
  }, []);
  return { memory: correctionMemoryFor(useSessionEpoch()), touch };
}
