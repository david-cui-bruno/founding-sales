import type { BoardCard, FirmPageResponse } from '@fss/contracts';
import type { JSX } from 'react';
import { inWords, shortDay } from '../dates.ts';
import { evidencePhrase } from '../pipeline/cardText.ts';
import { Chip } from '../v2/parts.tsx';

/**
 * Why a firm is in its stage (S4, acceptance item 2).
 *
 * Both halves come from reads that already exist: the firm page's `stageHistory` (who moved
 * it, from where, with what reason) and the board card's latest evidence (the kind of event
 * that caused an automatic move). Nothing here decides anything; it says what the API said.
 *
 * A move by a person (`user` or `admin`) is a manual override and says so, with the reason
 * they gave; it comes from the server, so it is still there after a refresh. A move by
 * Callie (`system`, `worker`) says what evidence it rested on when the board knows it.
 */

type Detail = Extract<FirmPageResponse, { visibility: 'assigned_or_admin' }>;
type StageEvent = Detail['stageHistory'][number];

export const isManualMove = (event: Pick<StageEvent, 'actorKind'>): boolean => event.actorKind === 'user' || event.actorKind === 'admin';

const ACTOR_WORDS: Readonly<Record<StageEvent['actorKind'], string>> = {
  user: 'You',
  admin: 'An administrator',
  system: 'Callie',
  worker: 'Callie',
};

/** The most recent move into the stage the opportunity is in. */
export function latestMove(history: readonly StageEvent[]): StageEvent | null {
  let latest: StageEvent | null = null;
  for (const event of history) {
    if (latest === null || Date.parse(event.occurredAt) >= Date.parse(latest.occurredAt)) latest = event;
  }
  return latest;
}

export function StageWhy({
  history,
  card,
  stageName = inWords,
}: {
  readonly history: readonly StageEvent[];
  readonly card: BoardCard | undefined;
  /** A stage key as the workspace names it. */
  stageName?(key: string): string;
}): JSX.Element {
  const latest = latestMove(history);
  if (latest === null) {
    return (
      <p data-testid="stage-why" className="py-1 text-sm text-muted-foreground">
        No move has been recorded for this opportunity yet.
      </p>
    );
  }
  const manual = isManualMove(latest);
  const evidence = !manual && card?.evidence != null ? evidencePhrase(card.evidence.kind, card.evidence.occurredAt) : null;
  return (
    <div data-testid="stage-why" className="flex flex-col gap-1 py-1 text-sm">
      <p className="flex flex-wrap items-center gap-1.5">
        <span data-testid="stage-why-line">
          {`${ACTOR_WORDS[latest.actorKind]} moved it to ${stageName(latest.toStageKey)} on ${shortDay(latest.occurredAt)}`}
          {evidence === null ? '' : ` · ${evidence}`}
          {latest.reason === null ? '' : ` · “${latest.reason}”`}
        </span>
        {manual ? (
          <Chip tone="outline" data-testid="stage-manual">
            Manual
          </Chip>
        ) : null}
      </p>
      {manual || card?.pinned === true ? (
        <p data-testid="stage-pinned-note" className="text-xs text-muted-foreground">
          A person placed this firm here, so automatic moves only go forward from it.
        </p>
      ) : null}
    </div>
  );
}

/** One line of the history: where it moved from and to, by whom, and why. */
export function StageEventRow({ event, stageName = inWords }: { readonly event: StageEvent; stageName?(key: string): string }): JSX.Element {
  return (
    <li data-testid="stage-event" className="flex items-center gap-3 border-b border-border py-1 text-xs last:border-b-0">
      <span data-testid="stage-event-move" className="flex-1">
        {`${event.fromStageKey === null ? 'opened' : stageName(event.fromStageKey)} → ${stageName(event.toStageKey)}`}
      </span>
      {isManualMove(event) ? (
        <span data-testid="stage-event-actor" className="text-muted-foreground">
          {event.actorKind === 'admin' ? 'by an administrator' : 'by you'}
        </span>
      ) : (
        <span data-testid="stage-event-actor" className="text-faint">
          automatic
        </span>
      )}
      {event.reason === null ? null : (
        <span data-testid="stage-event-reason" className="text-muted-foreground">
          {event.reason}
        </span>
      )}
      <span data-testid="stage-event-at" className="text-muted-foreground">
        {shortDay(event.occurredAt)}
      </span>
    </li>
  );
}
