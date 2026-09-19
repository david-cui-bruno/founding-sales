import { useCallback, useEffect, useState } from 'react';
import { todayViewSchema, type TodayCard, type TodayView, type V1Command } from '../../../../src/shared/contracts/v1Contract';
import type { CommandResult, DialRequest, DialResult, ReadResult, ViewSource } from '../../shared/clientContract';
import { AddFirmForm, OutcomeForm } from './OutcomeForm';
import { addFirmCommand, firmRoute, logCallOutcomeCommand, withCard, type AddFirmDraft, type OutcomeDraft } from './outcomeModel';
import {
  countsLine,
  dialSentence,
  EMPTY_SENTENCES,
  freshness,
  laneSections,
  nextStepSentence,
  phoneLabel,
  placeLabel,
  postureWarning,
  staleSentence,
  TODAY_REFRESH_MS,
  type Freshness,
} from './todayModel';

/**
 * The Today page (FSS target design section 3; slice S1): the four lanes as call cards, the counts row, the
 * as-of stamp, the posture warning and the stale banner. `TodayPage` owns the reads (on mount, on Refresh and
 * every 60 seconds through `window.callie.get`); the main process serves the last good file when the worker
 * does not answer, and the page shows that view as stale. `TodayList` is the pure rendering of one view,
 * which is what the node-side test renders.
 *
 * Copy number puts the number alone on the clipboard. Slice S2 adds the Call button beside it, which hands the
 * number to Phone.app through the main process and then opens the outcome form inline, and the add-a-firm form on
 * the header. Nothing here dials, decides a dial or sends: `dialAllowed` and its hold come from the worker at
 * request time, the main process checks the card again before it touches the OS, and handing a number to Phone.app
 * is not a call — David presses the button, and only the outcome form says what happened.
 */

export type TodayApi = {
  get(request: { view: '/v1/today' }): Promise<ReadResult<unknown>>;
  command(command: V1Command): Promise<CommandResult>;
  dial(request: DialRequest): Promise<DialResult>;
};

/** What a card's controls can do. Every one of them is optional, so the pure list renders without any of them. */
export type CardControls = {
  onCopyNumber?: (card: TodayCard) => void;
  onCall?: (card: TodayCard) => void;
  onOpenFirm?: (firmId: string) => void;
  /** The firm whose outcome form is open, if any. */
  openFor?: string | null;
  /** The sentence of the handoff that opened the form. */
  notice?: string | null;
  recording?: boolean;
  failure?: string | null;
  onRecord?: (card: TodayCard, draft: OutcomeDraft) => void;
  onCancelOutcome?: () => void;
  /** The list this card came from is stale, so no card on it can be dialed. */
  stale?: boolean;
};

export type TodayListProps = {
  view: TodayView;
  fetchedAt: string;
  freshness: Freshness;
  /** The sentence of the failed read that left this view standing, if any. */
  unavailableSentence?: string | null;
  onCopyNumber?: (card: TodayCard) => void;
  onRefresh?: () => void;
  controls?: CardControls;
  /** The add-a-firm form on the header, when the page wires one. */
  addFirm?: { adding?: boolean; failure?: string | null; onAdd: (draft: AddFirmDraft) => void };
};

function CardView({ card, controls }: { card: TodayCard; controls: CardControls }) {
  const open = controls.openFor === card.firmId;
  return (
    <li className="today-card" data-firm-id={card.firmId} data-dial-allowed={String(card.dialAllowed)}>
      <h3>{card.name}</h3>
      <p className="today-card__place">{placeLabel(card)}{card.website ? ` · ${card.website}` : ''}</p>
      <p className="today-card__phone">
        <span>{phoneLabel(card)}</span>
        {card.phone ? (
          <>
            {/* The worker's verdict is what enables the Call button; the main process checks it again before the OS. */}
            <button type="button" className="today-card__call" disabled={!card.dialAllowed || controls.stale === true}
              onClick={() => controls.onCall?.(card)} aria-label={`Call ${card.name}`}>Call</button>
            <button type="button" onClick={() => controls.onCopyNumber?.(card)} aria-label={`Copy number for ${card.name}`}>Copy number</button>
          </>
        ) : null}
        <button type="button" className="today-card__open-firm" data-firm-route={firmRoute(card.firmId)}
          onClick={() => controls.onOpenFirm?.(card.firmId)} aria-label={`Open ${card.name}`}>Open firm</button>
      </p>
      <p className="today-card__clock">
        {card.localTime ? `${card.localTime} local, ${card.openNow ? 'open' : 'closed'} now` : 'Local time unknown'}
      </p>
      <p className="today-card__dial" data-hold-reason={card.holdReason ?? ''}>{dialSentence(card)}</p>
      <p className="today-card__step">{nextStepSentence(card)}</p>
      {card.lastOutcome ? (
        <p className="today-card__outcome">Last outcome: {card.lastOutcome.outcome} on {card.lastOutcome.at.slice(0, 10)}{card.lastOutcome.note ? ` — ${card.lastOutcome.note}` : ''}</p>
      ) : null}
      {card.pendingCallback ? (
        <p className="today-card__callback">Callback promised for {card.pendingCallback.dueOn}</p>
      ) : null}
      {card.offer ? <p className="today-card__offer">{card.offer}</p> : null}
      {open ? (
        <OutcomeForm firmId={card.firmId} firmName={card.name} notice={controls.notice ?? null}
          recording={controls.recording ?? false} failure={controls.failure ?? null}
          onRecord={(draft) => controls.onRecord?.(card, draft)} onCancel={() => controls.onCancelOutcome?.()} />
      ) : null}
    </li>
  );
}

/** One view, rendered. Pure over its props. */
export function TodayList({ view, fetchedAt, freshness: fresh, unavailableSentence = null, onCopyNumber, onRefresh, controls, addFirm }: TodayListProps) {
  // A dial from a stale list is refused by the main process; the button says so before David presses it.
  const cardControls: CardControls = { ...(controls ?? {}), onCopyNumber: controls?.onCopyNumber ?? onCopyNumber, stale: fresh.stale };
  const warning = postureWarning(view);
  const stale = staleSentence(fresh, unavailableSentence);
  return (
    <section className="page page--today" aria-labelledby="today-heading">
      <header className="page__header">
        <h1 id="today-heading">Today</h1>
        <p className="page__stamp today-as-of">as of <time dateTime={fetchedAt}>{fetchedAt}</time></p>
        {onRefresh ? <div className="page__controls"><button type="button" onClick={onRefresh}>Refresh</button></div> : null}
        {addFirm ? <AddFirmForm adding={addFirm.adding ?? false} failure={addFirm.failure ?? null} onAdd={addFirm.onAdd} /> : null}
      </header>
      {stale ? <p role="status" className="notice today-stale" data-stale-reason={fresh.reason ?? ''}>{stale}</p> : null}
      {warning ? <p role="alert" className="error today-posture-warning">{warning}</p> : null}
      {view.list === null ? (
        <p className="today-empty" data-empty-reason={view.reason}>{EMPTY_SENTENCES[view.reason]}</p>
      ) : (
        <>
          <p className="today-counts">{countsLine(view.list)}</p>
          <p className="page__tick today-built">Built at <time dateTime={view.list.header.builtAt}>{view.list.header.builtAt}</time></p>
          {laneSections(view.list).map(section => (
            <section key={section.lane} className="today-lane" data-lane={section.lane} aria-labelledby={`today-lane-${section.lane}`}>
              <h2 id={`today-lane-${section.lane}`}>{section.title} ({section.cards.length})</h2>
              {section.cards.length === 0 ? (
                <p className="today-lane__empty">Nothing in this lane.</p>
              ) : (
                <ul className="today-cards">{section.cards.map(card => <CardView key={card.firmId} card={card} controls={cardControls} />)}</ul>
              )}
            </section>
          ))}
        </>
      )}
    </section>
  );
}

export type TodayPageProps = {
  api: TodayApi;
  onStatusChanged?: () => Promise<void>;
  onOpenFirm?: (firmId: string) => void;
  now?: () => number;
  refreshMs?: number;
  copy?: (text: string) => Promise<void>;
  /** Minted per record attempt and reused on a retry, so a lost answer never records a call twice. */
  newCommandId?: () => string;
  observedAt?: () => string;
};

/** The one record attempt in flight, with the command id it keeps across retries. */
type Attempt = { firmId: string; commandId: string };

type Held = { view: TodayView; fetchedAt: string; source: ViewSource };

/** The page: reads on mount, on Refresh and every minute; keeps the last view across a failed read; refreshes the stale banner as time passes. */
export function TodayPage({ api, onStatusChanged, onOpenFirm, now = Date.now, refreshMs = TODAY_REFRESH_MS,
  copy = text => navigator.clipboard.writeText(text),
  newCommandId = () => crypto.randomUUID(), observedAt = () => new Date().toISOString() }: TodayPageProps) {
  const [held, setHeld] = useState<Held | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [clock, setClock] = useState(now());
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordFailure, setRecordFailure] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addFailure, setAddFailure] = useState<string | null>(null);

  const read = useCallback(async () => {
    try {
      const result = await api.get({ view: '/v1/today' });
      if (result.outcome === 'ok') {
        const parsed = todayViewSchema.safeParse(result.view);
        if (parsed.success) {
          setHeld({ view: parsed.data, fetchedAt: result.fetchedAt, source: result.source ?? 'worker' });
          setFailure(result.source === 'last_good' ? result.sentence ?? null : null);
        } else setFailure("The worker's answer did not match the Today contract.");
      } else {
        setFailure(result.sentence);
        if (result.outcome === 'unauthenticated' && result.cleared) await onStatusChanged?.();
      }
    } catch {
      setFailure('The client could not read Today.');
    }
    setClock(now());
  }, [api, now, onStatusChanged]);

  useEffect(() => {
    void read();
    const refresh = window.setInterval(() => { void read(); }, refreshMs);
    const ticker = window.setInterval(() => setClock(now()), 15_000);
    return () => { window.clearInterval(refresh); window.clearInterval(ticker); };
  }, [read, refreshMs, now]);

  /**
   * Call: the handoff, then the form. The form opens whatever the handoff said, because a refused handoff does not
   * mean no call happened — David may have dialed the copied number by hand — and the record is of what happened on
   * the line, not of what this Mac managed to open.
   */
  const call = async (card: TodayCard) => {
    setOpenFor(card.firmId);
    setRecordFailure(null);
    setAttempt({ firmId: card.firmId, commandId: newCommandId() });
    if (!card.phone) { setNotice('This card has no number.'); return; }
    try {
      const result = await api.dial({ firmId: card.firmId, number: card.phone.number });
      setNotice(result.outcome === 'handed_off' ? `Handed ${result.number} to Phone.app. Press the call button there.` : result.sentence);
    } catch {
      setNotice('The client could not hand the number to Phone.app.');
    }
  };

  const record = async (card: TodayCard, draft: OutcomeDraft) => {
    const built = logCallOutcomeCommand({ commandId: attempt?.firmId === card.firmId ? attempt.commandId : newCommandId(),
      firmId: card.firmId, observedAt: observedAt(), draft });
    if ('problem' in built) return;
    setRecording(true);
    try {
      const result = await api.command(built.command);
      if (result.outcome !== 'ok') { setRecordFailure(result.sentence); return; }
      if (result.receipt.outcome === 'refused') { setRecordFailure(`The worker refused it: ${result.receipt.reason ?? 'unknown'}.`); return; }
      const slice = result.receipt.slice;
      // The card the worker returned is the card, so the page updates from the answer instead of re-reading.
      if (slice && slice.kind === 'card') setHeld(current => current === null ? current : { ...current, view: withCard(current.view, slice.firmId, slice.card) });
      setOpenFor(null); setNotice(null); setAttempt(null); setRecordFailure(null);
      void read();
    } catch {
      setRecordFailure('The client could not record the outcome.');
    } finally {
      setRecording(false);
    }
  };

  const addFirm = async (draft: AddFirmDraft) => {
    const built = addFirmCommand({ commandId: newCommandId(), draft });
    if ('problem' in built) return;
    setAdding(true);
    try {
      const result = await api.command(built.command);
      if (result.outcome !== 'ok') setAddFailure(result.sentence);
      else if (result.receipt.outcome === 'refused') setAddFailure(`The worker refused it: ${result.receipt.reason ?? 'unknown'}.`);
      else { setAddFailure(null); void read(); }
    } catch {
      setAddFailure('The client could not add the firm.');
    } finally {
      setAdding(false);
    }
  };

  const controls: CardControls = {
    onCopyNumber: card => { if (card.phone) void copy(card.phone.number); },
    onCall: card => { void call(card); },
    ...(onOpenFirm ? { onOpenFirm } : {}),
    openFor, notice, recording, failure: recordFailure,
    onRecord: (card, draft) => { void record(card, draft); },
    onCancelOutcome: () => { setOpenFor(null); setNotice(null); setAttempt(null); setRecordFailure(null); },
  };

  if (!held) {
    return (
      <section className="page page--today" aria-labelledby="today-heading">
        <header className="page__header">
          <h1 id="today-heading">Today</h1>
          <div className="page__controls"><button type="button" onClick={() => { void read(); }}>Refresh</button></div>
        </header>
        {failure ? <p role="status" className="notice today-stale">{failure}</p> : <p className="page__stamp">Reading the list.</p>}
      </section>
    );
  }
  const fresh = freshness({ fetchedAt: held.fetchedAt, now: clock, source: held.source, unavailable: failure !== null });
  return (
    <TodayList view={held.view} fetchedAt={held.fetchedAt} freshness={fresh} unavailableSentence={failure}
      controls={controls} addFirm={{ adding, failure: addFailure, onAdd: draft => { void addFirm(draft); } }}
      onRefresh={() => { void read(); }} />
  );
}
