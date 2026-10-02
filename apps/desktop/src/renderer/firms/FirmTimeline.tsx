import type { FirmTimeline as TimelineDto, FirmTimelineEvent } from '@fss/contracts';
import { useReducer, useRef, useState, type JSX } from 'react';
import type { Generation } from '../app/generation.ts';
import { shortDayTime } from '../dates.ts';
import { OUTCOME_LABELS } from '../outcomeForm.ts';
import { Button } from '../ui/button.tsx';
import { Group } from '../v2/parts.tsx';
import { currentCrmMemory } from './crmMemory.ts';

/**
 * The firm's activity, newest first (S4F): calls and their outcome, e-mails sent and
 * received, stage moves, stops and lifts, and outcome corrections. One quiet list: a time, a
 * kind and a line, with no message body, note or address (the API sends codes and a cut
 * subject, never more).
 *
 * The first page arrives with the firm; "Show more" asks for the next. Pages already loaded
 * are kept above the route and keyed by firm, so leaving and returning shows them again, a
 * page that arrives for a firm David has since left is cached under that firm, and an answer
 * that was in flight when the session ended is dropped (rules K1 and K7).
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

const outcomeWord = (code: string | null): string =>
  code === null ? 'unknown' : ((OUTCOME_LABELS as Readonly<Record<string, string>>)[code] ?? code.replaceAll('_', ' '));

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
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const [state, setState] = useState<'idle' | 'loading' | 'failed'>('idle');
  const mounted = useRef(true);
  mounted.current = true;
  const memory = currentCrmMemory();
  const extra = memory.timeline[firmId];
  const seen = new Set<string>();
  const events = [...timeline.events, ...(extra?.events ?? [])].filter(event => {
    if (seen.has(event.key)) return false;
    seen.add(event.key);
    return true;
  });
  const cursor = extra === undefined ? timeline.nextBefore : extra.nextBefore;

  const more = (): void => {
    if (ports === null || cursor === null || state === 'loading') return;
    // The answer is for THIS firm, this session and this memory: any of the three having
    // moved on drops it (K1), and it is cached under its own firm, never the one on screen (K7).
    const started = guard.now();
    const owner = currentCrmMemory();
    setState('loading');
    void ports.more(firmId, cursor).then(
      answer => {
        if (!guard.fresh(started) || currentCrmMemory() !== owner) return;
        if (answer.timeline === null) {
          if (mounted.current) setState('failed');
          return;
        }
        const have = owner.timeline[firmId]?.events ?? [];
        owner.timeline[firmId] = { events: [...have, ...answer.timeline.events], nextBefore: answer.timeline.nextBefore };
        if (mounted.current) {
          setState('idle');
          redraw();
        }
      },
      () => {
        if (guard.fresh(started) && mounted.current) setState('failed');
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
              <span data-testid="timeline-at" className="w-32 shrink-0 text-xs text-muted-foreground tabular-nums">
                {shortDayTime(event.at)}
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
      {cursor === null && state !== 'failed' ? null : (
        <div className="mt-1 flex items-center gap-2">
          {cursor === null ? null : (
            <Button variant="quiet" size="sm" data-testid="timeline-more" className="-ml-2" disabled={state === 'loading'} onClick={more}>
              {state === 'loading' ? 'Loading…' : 'Show more'}
            </Button>
          )}
          {state === 'failed' ? (
            <span data-testid="timeline-problem" role="status" className="text-xs text-muted-foreground">
              Callie could not load more just now. Try again.
            </span>
          ) : null}
        </div>
      )}
    </Group>
  );
}
