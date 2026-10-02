import { useQuery } from '@tanstack/react-query';
import type { JSX } from 'react';
import { RECAP_SMALL_SAMPLE_BELOW } from '@fss/contracts';
import { Block, Label } from '../v2/parts.tsx';

/**
 * Today › Overview: the daily recap and the per-type acceptance (slice 3a, lane C; David's
 * decisions 8 and 9). Both are reads. Neither writes, scores, or stores anything, and each
 * hides itself when its read did not answer rather than draw an error.
 *
 *   * the recap covers the day's analysed calls; an objection is "in k of n calls" with the
 *     words they used, recurring from two calls; one coaching observation, or none; below
 *     five calls it says "Small sample: n calls";
 *   * the acceptance read shows, per kind of suggestion, how many were accepted as they were,
 *     edited, declined or bypassed, "insufficient" until five were decided, every figure with
 *     the period it covers.
 */

const api = (): NonNullable<typeof globalThis.callieApi> | undefined => globalThis.callieApi;

const OBJECTION_WORDS: Readonly<Record<string, string>> = Object.freeze({
  no_need: 'They don’t need it',
  has_solution: 'They already have something',
  timing: 'Not now',
  price: 'Price',
  too_small: 'Too small for software',
  not_decision_maker: 'Not the decision maker',
  brush_off: 'A bare no',
  other: 'Something else',
});

const TYPE_WORDS: Readonly<Record<string, string>> = Object.freeze({
  callback: 'Callback',
  follow_up: 'E-mail follow-up',
  buying_signal: 'Open a deal (buying signal)',
  park: 'Pause calling',
  task: 'Promises',
  stop: 'Stop',
});

export function acceptanceWord(type: string): string {
  if (type.startsWith('outcome:')) return `Outcome: ${type.slice('outcome:'.length).replace(/_/gu, ' ')}`;
  return TYPE_WORDS[type] ?? type.replace(/_/gu, ' ');
}

export function Recap(): JSX.Element | null {
  const recap = useQuery({
    queryKey: ['calling.recap'],
    queryFn: async () => (await api()?.read('calling.recap', {}))?.recap ?? null,
    enabled: api() !== undefined,
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const acceptance = useQuery({
    queryKey: ['calling.acceptance'],
    queryFn: async () => (await api()?.read('calling.acceptance', {}))?.acceptance ?? null,
    enabled: api() !== undefined,
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const data = recap.data ?? null;
  const accept = acceptance.data ?? null;
  if (data === null && accept === null) return null;

  return (
    <div className="flex flex-col gap-8">
      {data === null ? null : (
        <Block data-testid="recap" className="py-0">
          <Label>Today’s calls</Label>
          <p data-testid="recap-count" className="text-sm">
            {data.callsAnalysed === 0 ? 'No analysed calls today.' : `${String(data.callsAnalysed)} ${data.callsAnalysed === 1 ? 'call' : 'calls'} analysed today`}
          </p>
          {data.smallSample ? (
            <p data-testid="recap-small" className="text-xs text-muted-foreground">
              Small sample: {data.callsAnalysed} {data.callsAnalysed === 1 ? 'call' : 'calls'}. A pattern needs at least {RECAP_SMALL_SAMPLE_BELOW}.
            </p>
          ) : null}
          {data.objections.length === 0 ? null : (
            <ul data-testid="recap-objections" className="mt-2 flex flex-col">
              {data.objections.map(objection => (
                <li key={objection.category} data-testid="recap-objection" data-recurring={objection.recurring} className="flex flex-col gap-0.5 border-b border-border py-2 last:border-b-0">
                  <p className="text-sm">
                    <span className={objection.recurring ? 'font-medium' : ''}>{OBJECTION_WORDS[objection.category] ?? objection.category}</span>{' '}
                    <span data-testid="recap-objection-count" className="text-xs text-muted-foreground">
                      in {objection.calls} of {data.callsAnalysed} calls{objection.recurring ? ' · recurring' : ''}
                    </span>
                  </p>
                  <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                    {objection.quotes.map(quote => (
                      <li key={`${quote.callSessionId}:${quote.quote}`}>“{quote.quote}”</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
          {data.coaching === null ? null : (
            <p data-testid="recap-coaching" className="mt-2 text-sm">
              <span className="text-xs text-muted-foreground">One thing to try: </span>
              {data.coaching.observation}
            </p>
          )}
        </Block>
      )}

      {accept === null ? null : (
        <Block data-testid="acceptance" className="py-0">
          <Label>How suggestions were used</Label>
          <p className="mb-1 text-xs text-muted-foreground">All time, since suggestions began. Read-only.</p>
          {accept.types.length === 0 ? (
            <p data-testid="acceptance-empty" className="text-sm text-muted-foreground">
              Nothing decided yet.
            </p>
          ) : (
            <ul className="flex flex-col border-t border-border">
              {accept.types.map(type => {
                const decided = type.unchanged + type.edited + type.declined;
                return (
                  <li key={type.type} data-testid="acceptance-type" data-insufficient={type.insufficient} className="flex items-baseline gap-3 border-b border-border py-1.5 text-sm last:border-b-0">
                    <span className="min-w-0 flex-1">{acceptanceWord(type.type)}</span>
                    {type.insufficient ? (
                      <span data-testid="acceptance-insufficient" className="text-xs text-muted-foreground">
                        insufficient: {decided} of {accept.minimumDecided} decided
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground tabular">
                        {Math.round((type.acceptedUnchangedShare ?? 0) * 100)}% as proposed · {type.unchanged} unchanged · {type.edited} edited · {type.declined} declined
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Block>
      )}
    </div>
  );
}
