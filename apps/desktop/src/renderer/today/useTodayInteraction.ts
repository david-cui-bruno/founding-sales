import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CallControl } from '../calling/useCall.ts';
import { useHasDrafts } from '../app/drafts.tsx';
import type { BasicsField } from './BasicsEditor.tsx';
import type { ApplyCommand } from './AfterCallAnalysis.tsx';
import { callIdentity, currentCallOf, outcomeDraftPrefix, type LogTarget, type ResolvedCall } from './OutcomeForm.tsx';
import { outcomeCommandKey, useTodayKept } from './keptCommands.ts';
import { nextToCall, stepFrom } from './queueView.ts';
import type { Today } from './useToday.ts';

/** What Today keeps while the person is elsewhere: the shell owns it. */
export interface TodayMemory {
  readonly done: ReadonlySet<string>;
  markDone(firmId: string): void;
  readonly queueScroll: { current: number };
  readonly firmScroll: { current: Map<string, number> };
  /**
   * Which of the firm's two forms was open, and for which firm (slice 3a, C0). The text in
   * them was always kept; now leaving Today and coming back also finds the form open, so
   * the draft is on screen rather than behind a button.
   */
  readonly panels: { current: OpenPanels };
  /**
   * The call placed in this sitting for each firm, by session (slice 3a, C). The analysis of a
   * call that ended while David moved on is watched through this, by session, so it is found
   * when it completes and never depends on which firm is open.
   */
  readonly sessions: { current: Map<string, { readonly callSessionId: string; readonly endedAt: number }> };
  /** An Apply's command id by call session: it outlives the panel so a lost answer is retried under it. */
  readonly applyCommands: Map<string, ApplyCommand>;
}

export interface OpenPanels {
  readonly firmId: string | null;
  readonly editing: BasicsField | null;
  readonly outcomeOpen: boolean;
  /** What the open outcome form records: set by every opening, null when it is closed. */
  readonly logTarget?: LogTarget | null;
}

export function useTodayMemory(): TodayMemory {
  const [done, setDone] = useState<ReadonlySet<string>>(() => new Set());
  const queueScroll = useRef(0);
  const firmScroll = useRef(new Map<string, number>());
  const panels = useRef<OpenPanels>({ firmId: null, editing: null, outcomeOpen: false });
  const sessions = useRef(new Map<string, { readonly callSessionId: string; readonly endedAt: number }>());
  const applyCommands = useRef(new Map<string, ApplyCommand>());
  const markDone = useCallback((firmId: string): void => {
    setDone(current => (current.has(firmId) ? current : new Set([...current, firmId])));
  }, []);
  return useMemo(() => ({ done, markDone, queueScroll, firmScroll, panels, sessions, applyCommands: applyCommands.current }), [done, markDone]);
}

/**
 * Owns the ordering of firm navigation, live-call focus and call-bound form openings.
 * Data reads, analyses and durable commands stay in their existing modules; the view
 * receives semantic actions instead of coordinating their synchronization effects.
 */
export function useTodayInteraction({
  today, call, memory, reloadCallingStatus, refreshCallHistory,
}: {
  readonly today: Today;
  readonly call: CallControl;
  readonly memory: TodayMemory;
  reloadCallingStatus(): void;
  refreshCallHistory(): void;
}) {
  const state = today.state;
  const actions = today.actions;
  const cards = useMemo(() => state?.cards ?? [], [state]);
  const expanded = state?.expanded ?? null;
  const firmId = expanded?.firmId ?? null;
  // The two forms come back open when the person does, with the text they left in them.
  const [editing, setEditing] = useState<BasicsField | null>(() => memory.panels.current.editing);
  // The log target is a value every opening sets and every close clears: there is no separate
  // "open" flag and no session left over from an earlier opening.
  const [outcomeTarget, setOutcomeTarget] = useState<LogTarget | null>(() => memory.panels.current.logTarget ?? (memory.panels.current.outcomeOpen ? { kind: 'current' } : null));
  const outcomeOpen = outcomeTarget !== null;
  const openOutcome = (target: LogTarget): void => setOutcomeTarget(target);
  const closeOutcome = (): void => setOutcomeTarget(null);
  // X1F rule 1: "the call just placed" is resolved here, once, as the form opens: the firm's last
  // call as the main process holds it, with its session when Callie placed it. The form keys its
  // drafts and its command by that call, and the request it sends names it.
  const freshCall = state === null ? null : currentCallOf(state, firmId);
  const resolveCurrent = (): LogTarget => ({ kind: 'current', call: freshCall });
  const freshIdentity = freshCall === null ? null : callIdentity(freshCall);
  const kept = useTodayKept();
  const noneTyped = useHasDrafts(outcomeDraftPrefix(firmId ?? '', 'none'));
  const nonePending = firmId !== null && kept.outcomes.has(outcomeCommandKey(firmId, 'none'));
  const loaded = state !== null;
  // The form stays open after it recorded "the call just placed" (its feedback and a stale
  // agreement are drawn in it), resolved then to no call. It takes the next call placed only
  // while nothing is typed or waiting under "no call", and never the call it just recorded.
  // A form already resolved to a call keeps it: Record again is always that call's request.
  useEffect(() => {
    if (!loaded || outcomeTarget?.kind !== 'current') return;
    if (outcomeTarget.call === undefined) {
      setOutcomeTarget({ kind: 'current', call: freshCall });
      return;
    }
    if (outcomeTarget.call !== null) return;
    if (freshCall === null) {
      if (outcomeTarget.after !== undefined) setOutcomeTarget({ kind: 'current', call: null });
      return;
    }
    if (freshIdentity === outcomeTarget.after || noneTyped || nonePending) return;
    setOutcomeTarget({ kind: 'current', call: freshCall });
    // `freshCall` is read through its identity: a new object for the same call changes nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, outcomeTarget, freshIdentity, noneTyped, nonePending]);
  const [queueOpen, setQueueOpen] = useState(false);

  const live = call.state.phase === 'starting' || call.state.phase === 'ringing' || call.state.phase === 'connected';
  const callFirm = 'firmId' in call.state ? call.state.firmId : null;

  const select = useCallback(
    (next: string | null): void => {
      if (next === null || actions === null || next === firmId) return;
      // Never leave a live call by a keystroke or a click: the queue is locked while one is.
      if (live && callFirm !== next) return;
      actions.expand(next);
      setQueueOpen(false);
    },
    [actions, firmId, live, callFirm],
  );

  // A live call's firm stays the open firm (S2 review, finding 4). The guard in `select`
  // runs when a navigation starts; a read already on the wire when Call was pressed lands
  // afterwards and opens its firm. So when the open firm is not the call's, the call's is
  // opened again — once for each firm that displaced it — and the call panel keeps its
  // controls in the meantime.
  const recalled = useRef<string | null>(null);
  useEffect(() => {
    if (!live || callFirm === null || actions === null || firmId === callFirm) {
      recalled.current = null;
      return;
    }
    const key = `${callFirm}:${firmId ?? ''}`;
    if (recalled.current === key) return;
    recalled.current = key;
    actions.expand(callFirm);
  }, [live, callFirm, firmId, actions]);

  // The first firm of the queue, when nothing is selected: the morning starts on a card.
  const tried = useRef<string | null>(null);
  useEffect(() => {
    if (actions === null || expanded !== null || cards.length === 0) return;
    const first = stepFrom(cards, null, 1);
    if (first === null || tried.current === first) return;
    tried.current = first;
    actions.expand(first);
  }, [actions, expanded, cards]);

  // Moving to another firm: the edit and the outcome form close (their drafts stay), the
  // last firm's scroll is kept, and an ended call on the last firm is put away.
  const firmRegion = useRef<HTMLDivElement>(null);
  const shown = useRef<string | null>(null);
  useEffect(() => {
    const region = firmRegion.current;
    const before = shown.current;
    if (before === firmId) return;
    if (before !== null && region !== null) memory.firmScroll.current.set(before, region.scrollTop);
    shown.current = firmId;
    // Coming back to the firm that was open keeps its forms open; any other move closes them
    // (their drafts stay either way).
    const returning = before === null && memory.panels.current.firmId === firmId;
    if (!returning) {
      setEditing(null);
      closeOutcome();
    }
    if (region !== null) region.scrollTop = firmId === null ? 0 : (memory.firmScroll.current.get(firmId) ?? 0);
    if (call.state.phase === 'ended' || call.state.phase === 'refused') {
      if (callFirm !== firmId) call.dismiss();
    }
  }, [firmId, memory, call, callFirm]);

  // What is open, kept for the next visit. Not written while no firm is open, so a visit
  // that starts before the firm has been read does not forget the last one's forms.
  useEffect(() => {
    if (firmId !== null) memory.panels.current = { firmId, editing, outcomeOpen, logTarget: outcomeTarget };
  }, [firmId, editing, outcomeOpen, outcomeTarget, memory]);

  // A call that ended: read the card and the cadence again, read the history now (and
  // while its steps are on their way), and tick the firm off for this sitting.
  const endedSession = call.state.phase === 'ended' ? call.state.sessionId : null;
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (endedSession === null || seen.current === endedSession || callFirm === null) return;
    seen.current = endedSession;
    memory.sessions.current.set(callFirm, { callSessionId: endedSession, endedAt: Date.now() });
    memory.markDone(callFirm);
    actions?.expand(callFirm);
    reloadCallingStatus();
    refreshCallHistory();
  }, [endedSession, callFirm, actions, reloadCallingStatus, refreshCallHistory, memory]);

  const next = nextToCall(cards, firmId, new Set([...memory.done, ...(firmId === null ? [] : [firmId])]));
  const goNext = (): void => {
    call.dismiss();
    select(next);
  };

  const openCurrentOutcome = (): void => openOutcome(resolveCurrent());
  // A named session closes after recording; a current-call opening remains on no
  // call, remembering the identity it recorded so a stale read cannot bind it again.
  const outcomeSubmitted = (recorded: ResolvedCall | null): void => {
    if (outcomeTarget?.kind === 'session') closeOutcome();
    else setOutcomeTarget({ kind: 'current', call: null, ...(recorded === null ? {} : { after: callIdentity(recorded) }) });
  };
  return {
    live, callFirm, editing, outcomeTarget, outcomeOpen, queueOpen, firmRegion,
    select,
    openSessionOutcome: (callSessionId: string): void => openOutcome({ kind: 'session', callSessionId }),
    closeOutcome, openCurrentOutcome, outcomeSubmitted,
    toggleOutcome: (): void => { if (outcomeOpen) closeOutcome(); else openCurrentOutcome(); },
    editBasics: (field: BasicsField): void => setEditing(field),
    closeBasics: (): void => setEditing(null),
    toggleQueue: (): void => setQueueOpen(current => !current),
    closeQueue: (): void => setQueueOpen(false),
    walkQueue: (direction: 1 | -1): void => select(stepFrom(cards, firmId, direction)),
    hasNext: next !== null,
    goNext,
  };
}
