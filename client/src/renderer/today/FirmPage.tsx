import { useCallback, useEffect, useState } from 'react';
import { v1FirmViewSchema, type V1FirmView } from '../../../../src/shared/contracts/v1Contract';
import type { ReadResult } from '../../shared/clientContract';
import { firmRoute } from './outcomeModel';

/**
 * The Firm view (FSS target design section 3, `GET /v1/firms`; slice S2). Everything the worker holds about one firm
 * that David may read: its routes with the verification word and whether each is retired or suppressed, where it
 * stands in the sequence, every call logged against it with the dial verdict of that instant, the callbacks still
 * open, the suppression record if there is one, the evidence line and the holds that stop a dial now.
 *
 * Reading is never a dial. This page has no Call button and no form: the dial and the outcome belong to the card.
 */

export type FirmApi = { get(request: { view: '/v1/firms'; firmId: string }): Promise<ReadResult<unknown>> };

export type FirmPageProps = {
  api: FirmApi;
  firmId: string;
  onBack: () => void;
  onStatusChanged?: () => Promise<void>;
};

const STATUS_SENTENCES: Readonly<Record<V1FirmView['status'], string>> = Object.freeze({
  new: 'New: in the pool, never listed.',
  listed: 'Listed: offered on a morning list.',
  in_sequence: 'In sequence.',
  resting: 'Resting: it will be offered again when the rest is over.',
  done: 'Done: the sequence is finished.',
  suppressed: 'Suppressed: never called again.',
});

export function FirmPage({ api, firmId, onBack, onStatusChanged }: FirmPageProps) {
  const [view, setView] = useState<V1FirmView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const read = useCallback(async () => {
    try {
      const result = await api.get({ view: '/v1/firms', firmId });
      if (result.outcome === 'ok') {
        const parsed = v1FirmViewSchema.safeParse(result.view);
        if (parsed.success) { setView(parsed.data); setFailure(null); }
        else setFailure("The worker's answer did not match the Firm contract.");
      } else {
        setFailure(result.sentence);
        if (result.outcome === 'unauthenticated' && result.cleared) await onStatusChanged?.();
      }
    } catch {
      setFailure('The client could not read this firm.');
    }
  }, [api, firmId, onStatusChanged]);

  useEffect(() => { void read(); }, [read]);

  return (
    <section className="page page--firm" aria-labelledby="firm-heading" data-firm-id={firmId} data-firm-route={firmRoute(firmId)}>
      <header className="page__header">
        <h1 id="firm-heading">{view?.name ?? 'Firm'}</h1>
        <div className="page__controls">
          <button type="button" className="firm__back" onClick={onBack}>Back to Today</button>
          <button type="button" onClick={() => { void read(); }}>Refresh</button>
        </div>
      </header>
      {failure ? <p role="alert" className="error firm__failure">{failure}</p> : null}
      {view === null ? <p className="page__stamp">Reading the firm.</p> : (
        <>
          <p className="firm__place">{[view.city, view.state].filter((part): part is string => part !== null).join(', ') || 'Location unknown'}
            {view.website ? ` · ${view.website}` : ''}{view.timeZone ? ` · ${view.timeZone}` : ''}</p>
          <p className="firm__status" data-status={view.status}>{STATUS_SENTENCES[view.status]}</p>
          <p className="firm__dial" data-hold-reason={view.holdReason ?? ''}>
            {view.dialAllowed ? `Dial allowed${view.localTime ? ` (${view.localTime} local)` : ''}` : `Held: ${view.holdReason ?? 'unknown'}`}
          </p>
          {view.suppression ? (
            <p role="alert" className="firm__suppression">Suppressed on {view.suppression.at.slice(0, 10)} ({view.suppression.source}): {view.suppression.reason}. There is no undo.</p>
          ) : null}

          <h2>Routes</h2>
          {view.routes.length === 0 ? <p className="firm__empty">No route.</p> : (
            <ul className="firm__routes">
              {view.routes.map((route) => (
                <li key={route.routeId} data-route-id={route.routeId} data-retired={String(route.retired)}>
                  {route.value} ({route.channel}, {route.verification}){route.retired ? ' · retired' : ''}{route.suppressed ? ' · suppressed' : ''}
                </li>
              ))}
            </ul>
          )}

          <h2>Sequence</h2>
          {view.sequence === null ? <p className="firm__empty">Not in the sequence yet.</p> : (
            <p className="firm__sequence" data-source={view.sequence.source} data-state={view.sequence.state}>
              {view.sequence.state}, step {view.sequence.stepIndex === null ? '—' : view.sequence.stepIndex + 1} of {view.sequence.stepCount}
              {view.sequence.nextDueAt ? `, due ${view.sequence.nextDueAt.slice(0, 10)}` : ''}
              {view.sequence.restingUntil ? `, resting until ${view.sequence.restingUntil.slice(0, 10)}` : ''}
              {`, entry ${view.sequence.entries}`}{view.sequence.lastAdvance ? ` (${view.sequence.lastAdvance})` : ''}
            </p>
          )}

          <h2>Calls</h2>
          {view.calls.length === 0 ? <p className="firm__empty">No call logged.</p> : (
            <ul className="firm__calls">
              {view.calls.map((call) => (
                <li key={call.at} data-outcome={call.outcome}>
                  {call.at.slice(0, 10)} — {call.outcome}{call.dialAllowed ? '' : ` (logged from a held card${call.holdCode ? `: ${call.holdCode}` : ''})`}
                  {call.note ? ` — ${call.note}` : ''}{call.callbackOn ? ` — callback ${call.callbackOn}` : ''}
                  {call.neverCallReason ? ` — never call: ${call.neverCallReason}` : ''}
                </li>
              ))}
            </ul>
          )}

          <h2>Callbacks</h2>
          {view.callbacks.length === 0 ? <p className="firm__empty">No callback promised.</p> : (
            <ul className="firm__callbacks">{view.callbacks.map((callback) => <li key={callback.dueOn}>{callback.dueOn}</li>)}</ul>
          )}

          <h2>Evidence</h2>
          <p className="firm__evidence">
            {view.evidence.enteredBy === 'hand' ? 'Entered by hand; no research evidence yet.'
              : `${view.evidence.sources} source${view.evidence.sources === 1 ? '' : 's'}${view.evidence.researchedAt ? `, last researched ${view.evidence.researchedAt.slice(0, 10)}` : ''}.`}
          </p>

          <h2>Holds</h2>
          {view.holds.length === 0 ? <p className="firm__empty">Nothing is holding this firm.</p> : (
            <ul className="firm__holds">{view.holds.map((hold) => <li key={hold.code} data-hold-code={hold.code}>{hold.reason} ({hold.code})</li>)}</ul>
          )}
        </>
      )}
    </section>
  );
}
