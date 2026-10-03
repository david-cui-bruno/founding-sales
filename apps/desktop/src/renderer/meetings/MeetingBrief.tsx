import { useEffect, useState, type JSX } from 'react';
import type { MeetingBriefItem, MeetingBriefResponse, MeetingBriefSection, MeetingBriefSectionKey } from '@fss/contracts';
import { shortDay } from '../dates.ts';
import { OUTCOME_LABELS } from '../outcomeForm.ts';
import { OBJECTION_WORDS } from '../today/Recap.tsx';
import { Button } from '../ui/button.tsx';
import { useBriefMemory } from './briefMemory.ts';

/**
 * The meeting brief, opened inline under a Meetings row (lane M2): what Callie already knows,
 * gathered for this meeting — why the demo, the firm, the previous conversations, the
 * objections and the open commitments. Quiet and short: three lines a section, "Show more"
 * for the rest; every line says where it came from and when, and prepared research says it
 * is not verified by Callie.
 *
 * Kept state (`briefMemory.ts`): the brief read last is shown while a newer read is under
 * way; an answer from an older read, or one naming another meeting, is dropped (K7).
 */

export type BriefReader = (meetingId: string) => Promise<{ readonly brief: MeetingBriefResponse | null; readonly reason: string | null }>;

const SECTION_TITLES: Readonly<Record<MeetingBriefSectionKey, string>> = Object.freeze({
  whyThisDemo: 'Why this demo',
  firm: 'Firm',
  conversations: 'Previous conversations',
  objections: 'Objections',
  commitments: 'Open commitments',
});

const SECTION_ORDER: readonly MeetingBriefSectionKey[] = ['whyThisDemo', 'firm', 'conversations', 'objections', 'commitments'];
const SHOWN = 3;

/** A calendar day is shown as that day wherever the Mac is; an instant in the Mac's zone. */
function dayOf(at: string | null): string | null {
  if (at === null) return null;
  return shortDay(/^\d{4}-\d{2}-\d{2}$/u.test(at) ? `${at}T12:00:00Z` : at);
}

function hostOf(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).hostname.replace(/^www\./u, '');
  } catch {
    return null;
  }
}

/** Where a line came from, in words. */
function originOf(entry: MeetingBriefItem): string {
  switch (entry.source) {
    case 'booking_notes':
    case 'booking_answer':
      return 'Booking form';
    case 'call_signal':
    case 'call_objection':
    case 'call_commitment':
      return 'Quoted from a call';
    case 'call_next_step':
      return 'Call summary';
    case 'prepared_brief':
      return 'Prepared research · not verified by Callie';
    case 'research_fact': {
      const host = hostOf(entry.sourceUrl);
      return host === null ? 'Quoted from research' : `Quoted from ${host}`;
    }
    case 'call':
      return entry.provenance === 'inferred' ? 'Call · summary' : 'Call';
    case 'email_thread':
      return 'E-mail thread';
  }
}

function labelOf(entry: MeetingBriefItem): string | null {
  // Prepared research says so in its origin line; its label would say it twice.
  if (entry.source === 'prepared_brief') return null;
  if (entry.label === null) return entry.source === 'call' ? 'Call' : null;
  if (entry.source === 'call') return (OUTCOME_LABELS as Readonly<Record<string, string>>)[entry.label] ?? entry.label;
  if (entry.source === 'call_objection') return OBJECTION_WORDS[entry.label] ?? entry.label;
  return entry.label;
}

function Section({ name, section }: { readonly name: MeetingBriefSectionKey; readonly section: MeetingBriefSection }): JSX.Element {
  const [all, setAll] = useState(false);
  const shown = all ? section.items : section.items.slice(0, SHOWN);
  const hidden = section.items.length - shown.length;
  return (
    <section data-testid={`brief-section-${name}`} className="flex flex-col gap-0.5">
      <h4 className="text-xs font-medium text-muted-foreground">{SECTION_TITLES[name]}</h4>
      {section.items.length === 0 ? (
        <p className="text-xs text-faint">{name === 'whyThisDemo' ? 'Unknown' : 'Nothing yet'}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {shown.map((entry, index) => {
            const label = labelOf(entry);
            const day = dayOf(entry.at);
            return (
              <li key={`${entry.source}:${String(index)}`} data-testid="brief-item" className="text-sm">
                <p>
                  {label === null ? null : <span className="font-medium">{/[?:.!]$/u.test(label) ? `${label} ` : `${label}: `}</span>}
                  <span>{entry.provenance === 'observed' && entry.source !== 'call' && entry.source !== 'email_thread' ? `“${entry.text}”` : entry.text}</span>
                </p>
                <p className="text-xs text-faint">{day === null ? originOf(entry) : `${originOf(entry)} · ${day}`}</p>
              </li>
            );
          })}
        </ul>
      )}
      {hidden > 0 || (all && section.omitted > 0) ? (
        <div className="flex items-center gap-2">
          {hidden > 0 ? (
            <Button
              size="sm"
              variant="quiet"
              data-testid="brief-show-more"
              onClick={() => {
                setAll(true);
              }}
            >
              Show more ({hidden})
            </Button>
          ) : null}
          {all && section.omitted > 0 ? <span className="text-xs text-faint">{section.omitted} more not shown</span> : null}
        </div>
      ) : null}
    </section>
  );
}

/** The open brief of one meeting: reads it on mount, keeps it per meeting and session. */
export function MeetingBrief({ meetingId, read }: { readonly meetingId: string; readonly read: BriefReader }): JSX.Element {
  const { memory, touch } = useBriefMemory();
  useEffect(() => {
    const generation = (memory.generation.get(meetingId) ?? 0) + 1;
    memory.generation.set(meetingId, generation);
    void read(meetingId).then(
      answer => {
        // A newer read for this meeting began since: its answer is the one that counts (K7).
        if (memory.generation.get(meetingId) !== generation) return;
        if (answer.brief !== null && answer.brief.meetingId !== meetingId) return;
        if (answer.brief === null) memory.unavailable.add(meetingId);
        else {
          memory.unavailable.delete(meetingId);
          memory.briefs.set(meetingId, answer.brief);
        }
        touch();
      },
      () => {
        if (memory.generation.get(meetingId) !== generation) return;
        memory.unavailable.add(meetingId);
        touch();
      },
    );
    // `memory` is the session's: a new session remounts the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingId]);

  const brief = memory.briefs.get(meetingId);
  if (brief === undefined) {
    return memory.unavailable.has(meetingId) ? (
      <p data-testid="meeting-brief-unavailable" className="mt-1 text-xs text-muted-foreground">
        Callie could not read this meeting’s brief just now.
      </p>
    ) : (
      <p data-testid="meeting-brief-loading" className="mt-1 text-xs text-faint">
        Reading the brief…
      </p>
    );
  }
  return (
    <div data-testid="meeting-brief" className="mt-1.5 flex flex-col gap-2 border-l-2 border-border pl-3">
      {brief.meeting.title === null && brief.meeting.attendeeName === null ? null : (
        <p className="text-xs text-muted-foreground">
          {[brief.meeting.title, brief.meeting.attendeeName === null ? null : `with ${brief.meeting.attendeeName}`].filter(part => part !== null).join(' ')}
        </p>
      )}
      {SECTION_ORDER.map(name => (
        <Section key={name} name={name} section={brief.sections[name]} />
      ))}
    </div>
  );
}
