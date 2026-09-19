import { useCallback, useEffect, useState } from 'react';
import type { WeekView } from '../../../../src/shared/contracts/v1Contract';

/**
 * The Week page (slice S5): the last seven Eastern days as the worker counted them from the permanent records —
 * calls by outcome, emails accepted, replies, callbacks promised and kept, firms researched, research spend and
 * the holds the attempt log still holds.
 *
 * It reads and nothing else. There is no control on this page, because there is no decision to make here: it is
 * the account of a week that already happened. Two things are said plainly rather than rounded off. The research
 * counters keep three days, so the older days of the week have none: the spend names how many days it actually
 * covers instead of summing the rest in as zero. The hold counts come from a log that keeps thirty days, so they
 * are what the log still holds rather than a total for all time.
 */
const REFRESH_MS = 60_000;

type Reading = { view: WeekView; fetchedAt: string };

const outcomeLabel = (outcome: string): string => outcome.replace(/_/g, ' ');

export function WeekPage() {
  const [reading, setReading] = useState<Reading | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const read = useCallback(async () => {
    try {
      const result = await window.callie.get({ view: '/v1/week' });
      if (result.outcome !== 'ok') { setProblem(result.sentence); return; }
      setReading({ view: result.view, fetchedAt: result.fetchedAt });
      setProblem(null);
    } catch {
      setProblem('The client could not read the week.');
    }
  }, []);

  useEffect(() => {
    void read();
    const timer = window.setInterval(() => { void read(); }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [read]);

  const view = reading?.view ?? null;
  return (
    <section className="page page--week">
      <header className="page__header">
        <h1>Week</h1>
        <p className="page__stamp">
          {reading === null ? 'Not read yet.' : <>read at <time dateTime={reading.fetchedAt}>{reading.fetchedAt}</time></>}
        </p>
        <div className="page__controls"><button type="button" onClick={() => { void read(); }}>Refresh</button></div>
      </header>
      {problem && <p role="alert" className="error">{problem}</p>}
      {view && (
        <>
          <p className="week__range">{view.from} to {view.to}, Eastern days.</p>
          <ul className="week__totals" aria-label="Totals">
            <li className="week__total" data-total="calls">Calls: <strong>{view.calls.total}</strong></li>
            <li className="week__total" data-total="emails">Emails sent: <strong>{view.emailsSent}</strong></li>
            <li className="week__total" data-total="replies">Replies: <strong>{view.replies}</strong></li>
            <li className="week__total" data-total="callbacks">Callbacks: <strong>{view.callbacks.promised}</strong> promised, <strong>{view.callbacks.kept}</strong> kept</li>
            <li className="week__total" data-total="researched">Firms researched: <strong>{view.firmsResearched}</strong></li>
            <li className="week__total" data-total="spend">
              Research spend: <strong>{view.spend.spent === null ? 'not counted' : `${view.spend.spent} over ${view.spend.daysCounted} days`}</strong>
              {view.spend.daysMissing === 0 ? ''
                : ` · ${view.spend.daysMissing} of the 7 days are past it, because the daily counter keeps ${view.spend.counterKeepsDays} days`}
            </li>
          </ul>
          <h2>Calls by outcome</h2>
          {view.calls.byOutcome.length === 0
            ? <p className="page__tick">No call was logged in these seven days.</p>
            : (
              <ul className="week__outcomes" aria-label="Calls by outcome">
                {view.calls.byOutcome.map((entry) => (
                  <li key={entry.outcome} data-outcome={entry.outcome}>{outcomeLabel(entry.outcome)}: <strong>{entry.count}</strong></li>
                ))}
              </ul>
            )}
          <h2>Holds</h2>
          {view.holds.length === 0
            ? <p className="page__tick">Nothing was held in these seven days, as far as the attempt log still reaches.</p>
            : (
              <ul className="week__holds" aria-label="Holds">
                {view.holds.map((hold) => (
                  <li key={hold.code} data-hold={hold.code}>{hold.reason.replace(/_/g, ' ')} ({hold.code}): <strong>{hold.count}</strong></li>
                ))}
              </ul>
            )}
          <p className="page__tick">Holds come from the attempt log, which keeps thirty days. Everything else here is permanent.</p>
          <h2>By day</h2>
          <table className="week__days">
            <caption>The seven Eastern days, oldest first.</caption>
            <thead>
              <tr><th scope="col">Day</th><th scope="col">Calls</th><th scope="col">Emails</th><th scope="col">Replies</th><th scope="col">Promised</th><th scope="col">Kept</th><th scope="col">Researched</th></tr>
            </thead>
            <tbody>
              {view.days.map((day) => (
                <tr key={day.date} data-day={day.date}>
                  <th scope="row">{day.date}</th>
                  <td>{day.calls}</td><td>{day.emailsSent}</td><td>{day.replies}</td>
                  <td>{day.callbacksPromised}</td><td>{day.callbacksKept}</td><td>{day.firmsResearched}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
