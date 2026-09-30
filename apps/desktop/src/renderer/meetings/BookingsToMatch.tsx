import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { reasonSentence, type FirmIdentityDto, type MeetingMatched, type UnmatchedMeetingDto } from '@fss/contracts';
import { shortDayTime } from '../dates.ts';
import { Button } from '../ui/button.tsx';
import { Input } from '../ui/input.tsx';
import { Row, RowActions, RowMain, Rows, Section } from '../ui/layout.tsx';
import { MEETING_STATE_WORDS } from './meetingText.ts';

/**
 * "Bookings to match", on the Pipeline screen (slice M1): the Cal.com bookings Callie
 * could not attach to a firm by itself, each with a firm picker and Match. Two clicks:
 * the firm, then Match.
 *
 * The picker is the board's own firm search — the firms the pipeline read already
 * carried (`firmsOf`), filtered by name the way the board's search box filters — so it
 * reads nothing more and offers only firms this person can see. A refusal is shown as
 * its sentence (`reasonSentence`), never its code. Renders nothing when there is nothing
 * to match.
 */

export interface BookingsToMatchPorts {
  unmatched(): Promise<{ readonly meetings: readonly UnmatchedMeetingDto[] | null }>;
  match(input: { readonly meetingId: string; readonly firmId: string }): Promise<{
    readonly matched: MeetingMatched | null;
    readonly reason: string | null;
  }>;
}

export function registryBookingPorts(): BookingsToMatchPorts | null {
  const api = globalThis.callieApi;
  if (api === undefined) return null;
  return {
    unmatched: async () => await api.read('meetings.unmatched', {}),
    match: async input => await api.command('meetings.match', input),
  };
}

const PICKER_LIMIT = 5;

/** The firms whose name has the text in it, as the board's search box matches. */
export function firmMatches(firms: readonly FirmIdentityDto[], text: string): readonly FirmIdentityDto[] {
  const needle = text.trim().toLowerCase();
  if (needle.length === 0) return [];
  return firms.filter(firm => firm.name.toLowerCase().includes(needle)).slice(0, PICKER_LIMIT);
}

function Booking({
  meeting,
  firms,
  actionsEnabled,
  onMatch,
}: {
  readonly meeting: UnmatchedMeetingDto;
  readonly firms: readonly FirmIdentityDto[];
  readonly actionsEnabled: boolean;
  onMatch(firmId: string): Promise<string | null>;
}): JSX.Element {
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<FirmIdentityDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const options = picked === null ? firmMatches(firms, search) : [];
  return (
    <Row data-testid="booking-to-match" data-meeting-id={meeting.meetingId}>
      <RowMain
        line={
          <span>
            {meeting.attendeeEmail ?? 'Someone'} · {shortDayTime(meeting.startsAt)}
          </span>
        }
        detail={
          <span className="flex flex-col gap-1">
            <span>
              {MEETING_STATE_WORDS[meeting.state]}
              {meeting.reason === 'firm_ambiguous' ? ' · more than one firm could be theirs' : ''}
            </span>
            {picked === null ? (
              <>
                <Input
                  data-testid="booking-firm-search"
                  type="search"
                  aria-label="Find the firm"
                  placeholder="Find the firm"
                  autoComplete="off"
                  value={search}
                  disabled={!actionsEnabled || busy}
                  onChange={event => {
                    setSearch(event.target.value);
                  }}
                  className="h-7 w-56 text-xs"
                />
                {options.map(firm => (
                  <Button
                    key={firm.id}
                    variant="link"
                    size="sm"
                    data-testid="booking-firm-option"
                    className="h-auto justify-start px-0 text-xs"
                    onClick={() => {
                      setPicked(firm);
                      setProblem(null);
                    }}
                  >
                    {firm.name}
                  </Button>
                ))}
              </>
            ) : (
              <span data-testid="booking-picked-firm">
                {picked.name}{' '}
                <Button
                  variant="quiet"
                  size="sm"
                  data-testid="booking-change-firm"
                  disabled={busy}
                  onClick={() => {
                    setPicked(null);
                  }}
                >
                  Change
                </Button>
              </span>
            )}
            {problem === null ? null : (
              <span data-testid="booking-match-problem" className="text-muted-foreground">
                {problem}
              </span>
            )}
          </span>
        }
      />
      <RowActions>
        <Button
          size="sm"
          data-testid="booking-match"
          disabled={!actionsEnabled || busy || picked === null}
          onClick={() => {
            if (picked === null) return;
            setBusy(true);
            setProblem(null);
            void onMatch(picked.id).then(refusal => {
              setBusy(false);
              if (refusal !== null) setProblem(refusal);
            });
          }}
        >
          Match
        </Button>
      </RowActions>
    </Row>
  );
}

export function BookingsToMatch({
  firms,
  actionsEnabled,
  onMatched,
  ports = registryBookingPorts(),
}: {
  readonly firms: readonly FirmIdentityDto[];
  readonly actionsEnabled: boolean;
  /** After a match: the board is read again, since the firm has moved to Demo booked. */
  onMatched?(): void;
  readonly ports?: BookingsToMatchPorts | null;
}): JSX.Element | null {
  const [meetings, setMeetings] = useState<readonly UnmatchedMeetingDto[] | null | undefined>(undefined);
  const portsRef = useRef(ports);
  portsRef.current = ports;
  const mounted = useRef(true);

  const load = useCallback(async (): Promise<void> => {
    try {
      const answer = await portsRef.current?.unmatched();
      if (mounted.current && answer !== undefined) setMeetings(answer.meetings);
    } catch {
      if (mounted.current) setMeetings(null);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  // An unreadable list is not worth a banner on the board: the bookings are still there
  // on the next read, and the board is what this screen is for.
  if (ports === null || meetings === undefined || meetings === null || meetings.length === 0) return null;

  const match = async (meetingId: string, firmId: string): Promise<string | null> => {
    let answer: Awaited<ReturnType<BookingsToMatchPorts['match']>>;
    try {
      answer = await ports.match({ meetingId, firmId });
    } catch {
      return 'Callie could not reach the server. Try again in a minute.';
    }
    if (answer.matched === null) return reasonSentence(answer.reason ?? 'refused');
    await load();
    onMatched?.();
    return null;
  };

  return (
    <Section data-testid="bookings-to-match" title="Bookings to match" count={meetings.length}>
      <Rows>
        {meetings.map(meeting => (
          <Booking
            key={meeting.meetingId}
            meeting={meeting}
            firms={firms}
            actionsEnabled={actionsEnabled}
            onMatch={async firmId => await match(meeting.meetingId, firmId)}
          />
        ))}
      </Rows>
    </Section>
  );
}
