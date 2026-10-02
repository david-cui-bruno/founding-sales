import { useEffect, useReducer } from 'react';
import type { OperationInput } from '../../shared/operations.ts';
import { useSessionEpoch } from '../app/drafts.tsx';

/**
 * Today's commands that outlive the control that sent them (kept-state rules K3, K5, K6).
 *
 * The outcome form and a Needs review item are drawn inside the open firm, so they unmount
 * the moment David opens another firm or leaves Today. A command they sent is still on the
 * wire, and its answer must land somewhere he will find it: here, a module-level store with
 * the lifetime of the drafts (`app/drafts.tsx`). It is keyed by the drafts provider's epoch,
 * which `App` replaces on every sign-out, workspace change and new session, so the next
 * person never inherits a command or an answer (rule K1). `crmMemory.ts` is the precedent.
 */

/** A `today.recordOutcome` that was sent and has no definite answer yet: its id and exactly its body. */
export interface OutcomeCommand {
  readonly id: string;
  readonly body: Omit<OperationInput<'today.recordOutcome'>, 'commandId'>;
  /** The draft text it was built from, by key: a success forgets exactly these, if unchanged. */
  readonly drafts: Readonly<Record<string, string>>;
}

/** The editors of a Needs review item that send a firm stop. */
export type StopEditor = 'stop' | 'stopCalls';

/** The stop a Needs review item last sent, and whether David has touched its editors since. */
export interface PendingStop {
  readonly commandId: number;
  readonly editor: StopEditor;
  /** David opened, closed or switched an editor after sending: a late success leaves it alone. */
  touched: boolean;
}

export interface TodayKept {
  /** By `outcomeCommandKey`: the firm and the call the form records. */
  readonly outcomes: Map<string, OutcomeCommand>;
  /** By review item (`itemKey`): the stop on the wire. */
  readonly stops: Map<string, PendingStop>;
  /** By review item: the sentence its last command answered, shown beside the item. */
  readonly notes: Map<string, string>;
  /**
   * The outcome form on screen for each key, as its opener's "submitted": a success closes the
   * form for the call it recorded, whichever mount of it is showing, and no other.
   */
  readonly openForms: Map<string, () => void>;
}

const fresh = (): TodayKept => ({ outcomes: new Map(), stops: new Map(), notes: new Map(), openForms: new Map() });

let current: { epoch: object | null; kept: TodayKept } = { epoch: null, kept: fresh() };
const listeners = new Set<() => void>();

/** The store for this session: a new drafts epoch starts clean. */
export function todayKeptFor(epoch: object | null): TodayKept {
  if (current.epoch !== epoch) current = { epoch, kept: fresh() };
  return current.kept;
}

/** Redraw every control reading the store: an answer arrived, perhaps after its sender left. */
export function announceKept(): void {
  for (const listener of [...listeners]) listener();
}

let counter = 0;
export const nextStopCommandId = (): number => (counter += 1);

/** Tests: forget everything, as a sign-out does. */
export function resetTodayKept(): void {
  current = { epoch: null, kept: fresh() };
}

/** The store of whoever is signed in now, redrawn whenever anything in it changes. */
export function useTodayKept(): TodayKept {
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
  return todayKeptFor(useSessionEpoch());
}

/** The call an outcome form records, as a key: its session, or the call just placed. */
export function logTargetKey(target: { readonly kind: 'current' } | { readonly kind: 'session'; readonly callSessionId: string }): string {
  return target.kind === 'session' ? `session:${target.callSessionId}` : 'current';
}

export const outcomeCommandKey = (firmId: string, targetKey: string): string => `${firmId}:${targetKey}`;
