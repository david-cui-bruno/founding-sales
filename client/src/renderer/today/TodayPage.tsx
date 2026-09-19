import { useCallback, useEffect, useState } from 'react';
import { todayViewSchema, type TodayCard, type TodayView } from '../../../../src/shared/contracts/v1Contract';
import type { ReadResult } from '../../shared/clientContract';
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
 * as-of stamp, the posture warning and the stale banner. `TodayPage` owns the reads (on mount and every
 * 60 seconds through `window.callie.get`) and keeps the last view it received when a read fails, marked
 * stale; `TodayList` is the pure rendering of one view, which is what the node-side test renders.
 *
 * Copy number puts the number alone on the clipboard; the Phone.app handoff is slice S2. Nothing here
 * dials, decides a dial or sends: dialAllowed and its hold come from the worker at request time.
 */

export type TodayApi = { get(request: { view: '/v1/today' }): Promise<ReadResult<unknown>> };

export type TodayListProps = {
  view: TodayView;
  fetchedAt: string;
  freshness: Freshness;
  /** The sentence of the failed read that left this view standing, if any. */
  unavailableSentence?: string | null;
  onCopyNumber?: (card: TodayCard) => void;
};

function CardView({ card, onCopyNumber }: { card: TodayCard; onCopyNumber?: (card: TodayCard) => void }) {
  return (
    <li className="today-card" data-firm-id={card.firmId} data-dial-allowed={String(card.dialAllowed)}>
      <h3>{card.name}</h3>
      <p className="today-card-place">{placeLabel(card)}{card.website ? ` · ${card.website}` : ''}</p>
      <p className="today-card-phone">
        <span>{phoneLabel(card)}</span>
        {card.phone ? (
          <button type="button" onClick={() => onCopyNumber?.(card)} aria-label={`Copy number for ${card.name}`}>Copy number</button>
        ) : null}
      </p>
      <p className="today-card-clock">
        {card.localTime ? `${card.localTime} local, ${card.openNow ? 'open' : 'closed'} now` : 'Local time unknown'}
      </p>
      <p className="today-card-dial" data-hold-reason={card.holdReason ?? ''}>{dialSentence(card)}</p>
      <p className="today-card-step">{nextStepSentence(card)}</p>
      {card.lastOutcome ? (
        <p className="today-card-outcome">Last outcome: {card.lastOutcome.outcome} on {card.lastOutcome.at.slice(0, 10)}{card.lastOutcome.note ? ` — ${card.lastOutcome.note}` : ''}</p>
      ) : null}
      {card.offer ? <p className="today-card-offer">{card.offer}</p> : null}
    </li>
  );
}

/** One view, rendered. Pure over its props. */
export function TodayList({ view, fetchedAt, freshness: fresh, unavailableSentence = null, onCopyNumber }: TodayListProps) {
  const warning = postureWarning(view);
  const stale = staleSentence(fresh, unavailableSentence);
  return (
    <section className="today" aria-labelledby="today-heading">
      <h1 id="today-heading">Today</h1>
      <p className="today-as-of">as of <time dateTime={fetchedAt}>{fetchedAt}</time></p>
      {stale ? <p role="status" className="today-stale" data-stale-reason={fresh.reason ?? ''}>{stale}</p> : null}
      {warning ? <p role="alert" className="today-posture-warning">{warning}</p> : null}
      {view.list === null ? (
        <p className="today-empty" data-empty-reason={view.reason}>{EMPTY_SENTENCES[view.reason]}</p>
      ) : (
        <>
          <p className="today-counts">{countsLine(view.list)}</p>
          <p className="today-built">Built at <time dateTime={view.list.header.builtAt}>{view.list.header.builtAt}</time></p>
          {laneSections(view.list).map(section => (
            <section key={section.lane} className="today-lane" data-lane={section.lane} aria-labelledby={`today-lane-${section.lane}`}>
              <h2 id={`today-lane-${section.lane}`}>{section.title} ({section.cards.length})</h2>
              {section.cards.length === 0 ? (
                <p className="today-lane-empty">Nothing in this lane.</p>
              ) : (
                <ul>{section.cards.map(card => <CardView key={card.firmId} card={card} onCopyNumber={onCopyNumber} />)}</ul>
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
  now?: () => number;
  refreshMs?: number;
  copy?: (text: string) => Promise<void>;
};

type Held = { view: TodayView; fetchedAt: string };

/** The page: reads on mount and every minute, keeps the last view across a failed read, refreshes the stale banner as time passes. */
export function TodayPage({ api, now = Date.now, refreshMs = TODAY_REFRESH_MS, copy = text => navigator.clipboard.writeText(text) }: TodayPageProps) {
  const [held, setHeld] = useState<Held | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [clock, setClock] = useState(now());

  const read = useCallback(async () => {
    const result = await api.get({ view: '/v1/today' });
    if (result.outcome === 'ok') {
      const parsed = todayViewSchema.safeParse(result.view);
      if (parsed.success) { setHeld({ view: parsed.data, fetchedAt: result.fetchedAt }); setFailure(null); }
      else setFailure("The worker's answer did not match the Today contract.");
    } else {
      setFailure(result.sentence);
    }
    setClock(now());
  }, [api, now]);

  useEffect(() => {
    void read();
    const refresh = setInterval(() => { void read(); }, refreshMs);
    const ticker = setInterval(() => setClock(now()), 15_000);
    return () => { clearInterval(refresh); clearInterval(ticker); };
  }, [read, refreshMs, now]);

  if (!held) {
    return (
      <section className="today" aria-labelledby="today-heading">
        <h1 id="today-heading">Today</h1>
        {failure ? <p role="status" className="today-stale">{failure}</p> : <p>Reading the list…</p>}
      </section>
    );
  }
  const fresh = freshness({ fetchedAt: held.fetchedAt, now: clock, unavailable: failure !== null });
  return (
    <TodayList view={held.view} fetchedAt={held.fetchedAt} freshness={fresh} unavailableSentence={failure}
      onCopyNumber={card => { if (card.phone) void copy(card.phone.number); }} />
  );
}
