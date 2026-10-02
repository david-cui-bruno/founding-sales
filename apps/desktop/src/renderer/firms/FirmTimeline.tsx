import type { FirmTimeline as TimelineDto, FirmTimelineEvent } from '@fss/contracts';
import { useEffect, useSyncExternalStore, type JSX } from 'react';
import type { Generation } from '../app/generation.ts';
import { OUTCOME_LABELS } from '../outcomeForm.ts';
import { Button } from '../ui/button.tsx';
import { Group } from '../v2/parts.tsx';
import { crmVersion, currentCrmMemory, notifyCrm, subscribeCrm, type TimelineCache } from './crmMemory.ts';

/**
 * The firm's activity, newest first (S4F): calls and their outcome, e-mails sent and
 * received, stage moves, stops and lifts, and outcome corrections. One quiet list: a time, a
 * kind and a line, with no message body, note or address (the API sends codes and a cut
 * subject, never more).
 *
 * The first page arrives with the firm; "Show more" asks for the next. Everything loaded is
 * kept above the route, by firm, and drawn from there through a subscription, so:
 *
 *  * leaving and returning shows the pages again, and a refreshed first page is MERGED with
 *    them by event (deduplicated, newest first) rather than replacing or displacing any;
 *  * "Show more" asks for the page older than the OLDEST row on screen, never a cursor stored
 *    with some earlier page, so a newer event arriving between visits cannot leave a gap;
 *  * a page that lands while another instance is mounted (or none) is drawn by whichever is,
 *    a page for a firm David has since left is cached under that firm, and an answer in
 *    flight when the session ended is dropped (rules K1 and K7).
 */

export interface TimelinePorts {
  more(firmId: string, before: string): Promise<{ readonly timeline: TimelineDto | null }>;
}

export function registryTimelinePorts(): TimelinePorts | null {
  const api = globalThis.callieApi;
  if (api === undefined) return null;
  return { more: async (firmId, before) => await api.read('crm.firmTimeline', { firmId, before }) };
}

const KIND_WORDS: Readonly<Record<FirmTimelineEvent['kind'], string>> = {
  call: 'Call',
  outcome_corrected: 'Correction',
  email_sent: 'E-mail sent',
  email_received: 'E-mail received',
  stage_change: 'Stage',
  stop_recorded: 'Stop',
  stop_lifted: 'Stop lifted',
};

const CHANNEL_WORDS: Readonly<Record<string, string>> = { phone: 'Calls', email: 'E-mail', all: 'All contact' };
const SCOPE_WORDS: Readonly<Record<string, string>> = { firm: 'the firm', handle: 'one contact' };

/** An outcome in words; one this build has no word for is "an outcome", never its code. */
const outcomeWord = (code: string | null): string => (code === null ? 'an outcome' : ((OUTCOME_LABELS as Readonly<Record<string, string>>)[code] ?? 'an outcome'));

/** The one line for an event. Pure, so a test holds it to the codes the API sends. */
export function timelineSummary(event: FirmTimelineEvent, stageName: (key: string) => string): string {
  switch (event.kind) {
    case 'call':
      return outcomeWord(event.code);
    case 'outcome_corrected':
      return `${outcomeWord(event.detail)} to ${outcomeWord(event.code)}`;
    case 'email_sent':
    case 'email_received':
      return event.detail === null || event.detail === '' ? '(no subject)' : event.detail;
    case 'stage_change':
      return `${event.detail === null ? 'Opened at' : `${stageName(event.detail)} to`} ${event.code === null ? 'a stage' : stageName(event.code)}`;
    case 'stop_recorded':
    case 'stop_lifted':
      return `${CHANNEL_WORDS[event.code ?? ''] ?? 'Contact'} stopped for ${SCOPE_WORDS[event.detail ?? ''] ?? 'the firm'}`;
  }
}

const WHEN = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const whenOf = (instant: string): string => {
  const at = new Date(instant);
  return Number.isFinite(at.getTime()) ? WHEN.format(at) : instant;
};

/** Newest first, as the server orders: by the cursor's instant, then kind, then id. */
function newestFirst(a: FirmTimelineEvent, b: FirmTimelineEvent): number {
  const [aAt = '', aKind = '', ...aId] = a.cursor.split('|');
  const [bAt = '', bKind = '', ...bId] = b.cursor.split('|');
  if (aAt !== bAt) return aAt < bAt ? 1 : -1;
  if (aKind !== bKind) return aKind < bKind ? 1 : -1;
  const x = aId.join('|');
  const y = bId.join('|');
  return x === y ? 0 : x < y ? 1 : -1;
}

/** The first page and everything cached, merged: one row per event, newest first. */
export function mergedRows(first: readonly FirmTimelineEvent[], cache: TimelineCache | undefined): FirmTimelineEvent[] {
  const byKey = new Map<string, FirmTimelineEvent>();
  // Fresh rows win over cached ones for the same event.
  for (const event of [...(cache?.events ?? []), ...first]) byKey.set(event.key, event);
  return [...byKey.values()].sort(newestFirst);
}

export function FirmTimeline({
  firmId,
  timeline,
  ports = registryTimelinePorts(),
  guard,
  stageName,
}: {
  readonly firmId: string;
  /** The page that came with the firm. */
  readonly timeline: TimelineDto;
  readonly ports?: TimelinePorts | null;
  readonly guard: Generation;
  stageName(key: string): string;
}): JSX.Element {
  // Drawn from the shared memory: any change to it, from any instance, redraws this one.
  useSyncExternalStore(subscribeCrm, crmVersion);
  const cache = currentCrmMemory().timeline[firmId];
  const events = mergedRows(timeline.events, cache);
  const oldest = events[events.length - 1];
  // More exist unless the oldest page loaded ended the list, or the first page itself did and
  // nothing older was ever loaded.
  const more = cache?.exhausted === true ? false : cache?.loadedMore === true ? true : timeline.nextBefore !== null;
  const status = cache?.status ?? 'idle';

  // Every row ever shown is kept, so a refreshed first page that no longer reaches as far
  // back as the last one cannot lose the rows it displaced.
  useEffect(() => {
    const memory = currentCrmMemory();
    const held = memory.timeline[firmId] ?? { events: [], loadedMore: false, exhausted: false, status: 'idle' as const };
    held.events = mergedRows(timeline.events, held);
    memory.timeline[firmId] = held;
  }, [firmId, timeline]);

  const loadMore = (): void => {
    if (ports === null || !more || oldest === undefined || status === 'loading') return;
    // The answer is for THIS firm, this session and this memory: any of the three having moved
    // on drops it (K1), and it is cached under its own firm, never the one on screen (K7).
    const started = guard.now();
    const owner = currentCrmMemory();
    const entry = owner.timeline[firmId] ?? { events: [], loadedMore: false, exhausted: false, status: 'idle' as const };
    entry.status = 'loading';
    owner.timeline[firmId] = entry;
    notifyCrm();
    const settle = (change: (cache: TimelineCache) => void): void => {
      if (!guard.fresh(started) || currentCrmMemory() !== owner) return;
      const held = owner.timeline[firmId];
      if (held === undefined) return;
      change(held);
      notifyCrm();
    };
    void ports.more(firmId, oldest.cursor).then(
      answer =>
        settle(held => {
          if (answer.timeline === null) {
            held.status = 'failed';
            return;
          }
          held.events = mergedRows(answer.timeline.events, held);
          held.loadedMore = true;
          held.exhausted = answer.timeline.nextBefore === null;
          held.status = 'idle';
        }),
      () => {
        settle(held => {
          held.status = 'failed';
        });
      },
    );
  };

  return (
    <Group data-testid="firm-timeline" title="Activity">
      {events.length === 0 ? (
        <p data-testid="timeline-empty" className="py-1 text-sm text-muted-foreground">
          Nothing has happened at this firm yet.
        </p>
      ) : (
        <ol className="flex flex-col border-t border-border">
          {events.map(event => (
            <li
              key={event.key}
              data-testid="timeline-row"
              data-key={event.key}
              className="flex items-baseline gap-3 border-b border-border py-1 text-sm last:border-b-0"
            >
              <span data-testid="timeline-at" className="w-28 shrink-0 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                {whenOf(event.at)}
              </span>
              <span data-testid="timeline-kind" className="w-28 shrink-0 text-xs text-muted-foreground">
                {KIND_WORDS[event.kind]}
              </span>
              <span data-testid="timeline-summary" className="min-w-0 flex-1 truncate" title={timelineSummary(event, stageName)}>
                {timelineSummary(event, stageName)}
              </span>
            </li>
          ))}
        </ol>
      )}
      {!more && status !== 'failed' ? null : (
        <div className="mt-1 flex items-center gap-2">
          {!more ? null : (
            <Button variant="quiet" size="sm" data-testid="timeline-more" className="-ml-2" disabled={status === 'loading'} onClick={loadMore}>
              {status === 'loading' ? 'Loading…' : 'Show more'}
            </Button>
          )}
          {status === 'failed' ? (
            <span data-testid="timeline-problem" role="status" className="text-xs text-muted-foreground">
              Callie could not load more just now. Try again.
            </span>
          ) : null}
        </div>
      )}
    </Group>
  );
}
