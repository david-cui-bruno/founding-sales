import { ArrowRight, Mic, MicOff, Phone, PhoneOff, RotateCw } from 'lucide-react';
import type { JSX } from 'react';
import { CALL_ANNOUNCEMENT } from '@fss/contracts';
import type { TodayCardBlocker } from '@fss/contracts';
import { useDraft } from '../app/drafts.tsx';
import { attemptLabel, callTimer } from '../calling/callText.ts';
import type { CallControl } from '../calling/useCall.ts';
import type { CallingStatus } from '../calling/useCallingStatus.ts';
import { DialPanel } from './Lanes.tsx';
import { cn } from '../lib/utils.ts';
import type { TodayState } from '../todayContract.ts';
import type { TodayScreenView } from '../todayView.ts';
import { Button } from '../ui/button.tsx';
import { Textarea } from '../ui/textarea.tsx';
import { Chip, dense, Kbd, StepChip } from '../v2/parts.tsx';
import type { CallProgress } from './callProgress.ts';
import { BLOCKER_FIXES, BLOCKER_SENTENCES } from './queueView.ts';
import type { TodayActions } from './useToday.ts';

/**
 * The persistent call area (slice S2; the prototype's right-hand panel, on real state).
 *
 * Always on screen on Today, whatever is selected, so a call in progress is never
 * scrolled away. Starting a call is a Call button and only a Call button: no shortcut
 * reaches it. The phases are `useCall`'s, hoisted above the route, so leaving Today
 * mid-call does not hang up and coming back finds the call where it was:
 *
 *   idle → the numbers with the server's advice, "Attempt N of 4", the announcement;
 *   ringing / connected → the announcement to READ ALOUD, prominent, the timer, mute,
 *     hang up, the voicemail script on attempts 1 and 4, and notes kept as you type;
 *   ended → what happens next, step by step, refreshing in place, and **Next firm**. There
 *     is no required form: notes and the outcome stay one press away, and the outcome
 *     form keeps every rule it had.
 *
 * With calling off (`tel`) or not yet known, the panel is the existing dial panel, which
 * hands the number to the phone app or waits — unchanged, because those rules are the
 * reason an untracked call cannot bypass the cadence and the budget.
 */

export interface CallPanelProps {
  readonly state: TodayState;
  readonly view: TodayScreenView;
  readonly actions: TodayActions;
  readonly call: CallControl;
  readonly status: CallingStatus;
  /** The firm on screen, or null. */
  readonly firmId: string | null;
  readonly blockers: readonly TodayCardBlocker[];
  /** The selected firm's latest call, as it stands now. */
  readonly progress: CallProgress | null;
  /** Whether there is a next firm to call. */
  readonly hasNext: boolean;
  onFix(blocker: TodayCardBlocker): void;
  onNext(): void;
  onOutcome(): void;
}

function PhaseChip({ call, firmId }: { readonly call: CallControl; readonly firmId: string | null }): JSX.Element {
  const state = call.state;
  const here = 'firmId' in state && state.firmId === firmId;
  if (!here) return <Chip tone="outline">Ready</Chip>;
  if (state.phase === 'starting') return <Chip tone="info">Starting…</Chip>;
  if (state.phase === 'ringing') return <Chip tone="info">Ringing…</Chip>;
  if (state.phase === 'connected')
    return (
      <Chip tone="ok" icon={<span className="size-1.5 animate-pulse rounded-full bg-ok" />}>
        Connected
      </Chip>
    );
  if (state.phase === 'refused') return <Chip tone="danger">Not placed</Chip>;
  return <Chip>Ended</Chip>;
}

/** What is said the moment somebody answers. Prominent while a call is live. */
export function ReadAloud({ live }: { readonly live: boolean }): JSX.Element {
  return (
    <div
      data-testid="call-announcement"
      className={cn('rounded-lg border p-3 transition-colors', live ? 'border-strong bg-background shadow-sm' : 'border-border bg-muted/50')}
    >
      <p className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Read aloud when they answer</p>
      <p data-testid="call-announcement-text" className={cn('text-base', live ? 'font-medium text-foreground' : 'text-muted-foreground')}>
        “{CALL_ANNOUNCEMENT}”
      </p>
    </div>
  );
}

function LiveCall({ call, firmId }: { readonly call: CallControl; readonly firmId: string }): JSX.Element | null {
  const state = call.state;
  const [note, setNote] = useDraft(`today:outcome:${firmId}:note`);
  if (state.phase !== 'starting' && state.phase !== 'ringing' && state.phase !== 'connected') return null;
  return (
    <div data-testid="call-live" className="flex flex-col gap-4">
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p data-testid="call-status" className="text-sm font-medium">
            {state.phase === 'connected' ? 'Connected · recording' : state.phase === 'ringing' ? 'Ringing…' : 'Starting the call…'}
          </p>
          {state.phase !== 'starting' && state.attempt !== null ? (
            <p className="text-xs text-muted-foreground">Attempt {state.attempt} of 4</p>
          ) : null}
        </div>
        {state.phase === 'connected' ? (
          <span data-testid="call-timer" className="font-mono text-[28px] leading-none font-medium tracking-tight tabular">
            {callTimer(call.seconds)}
          </span>
        ) : null}
      </div>
      <ReadAloud live />
      <div className="flex gap-2">
        {state.phase === 'starting' ? null : (
          <Button
            variant="outline"
            data-testid="call-mute"
            className={cn(dense.lg, 'flex-1')}
            aria-pressed={call.muted}
            onClick={() => {
              call.toggleMute();
            }}
          >
            {call.muted ? <MicOff /> : <Mic />} {call.muted ? 'Unmute' : 'Mute'}
          </Button>
        )}
        <Button
          data-testid="call-hang-up"
          className={cn(dense.lg, 'flex-1 bg-destructive text-destructive-foreground hover:bg-destructive/90')}
          onClick={() => {
            call.hangUp();
          }}
        >
          <PhoneOff /> {state.phase === 'connected' ? 'Hang up' : 'Cancel call'}
        </Button>
      </div>
      {state.phase !== 'starting' && state.voicemailScript !== null ? (
        <div data-testid="call-voicemail" className="rounded-md bg-muted/60 p-2.5">
          <p className="text-xs font-medium text-muted-foreground">If you reach voicemail</p>
          <p data-testid="call-voicemail-text" className="text-sm">
            {state.voicemailScript}
          </p>
        </div>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="call-notes" className="text-xs font-medium text-muted-foreground">
          Notes <span className="font-normal text-faint">· optional, kept as you type</span>
        </label>
        <Textarea
          id="call-notes"
          data-testid="call-notes"
          rows={4}
          value={note}
          maxLength={2000}
          onChange={event => setNote(event.target.value)}
          className="resize-none border-strong text-sm"
          placeholder="Anything the recording won’t catch"
        />
      </div>
    </div>
  );
}

function AfterCall({
  progress,
  seconds,
  hasNext,
  onNext,
  onOutcome,
}: {
  readonly progress: CallProgress | null;
  readonly seconds: number | null;
  readonly hasNext: boolean;
  onNext(): void;
  onOutcome(): void;
}): JSX.Element {
  return (
    <div data-testid="call-ended" className="flex flex-col gap-4">
      <div>
        <p className="text-sm font-medium">Call ended</p>
        {seconds === null || seconds === 0 ? null : <p className="text-xs text-muted-foreground tabular">{callTimer(seconds)}</p>}
      </div>
      <div data-testid="post-call-steps" className="flex flex-col gap-2">
        <p className="text-xs font-medium text-muted-foreground">After the call</p>
        {progress === null ? (
          <p className="text-xs text-muted-foreground">Reading what the call left…</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5">
              <StepChip label="Recording" state={progress.recording.state} word={progress.recording.word} testId="step-recording" />
              <StepChip label="Transcript" state={progress.transcription.state} word={progress.transcription.word} testId="step-transcription" />
              <StepChip label="Summary" state={progress.analysis.state} word={progress.analysis.word} testId="step-analysis" />
            </div>
            {progress.sentence === null ? null : (
              <p data-testid="post-call-sentence" className="text-xs text-muted-foreground">
                {progress.sentence}
              </p>
            )}
          </>
        )}
      </div>
      <Button data-testid="call-next" className={cn(dense.lg, 'w-full gap-2')} disabled={!hasNext} onClick={onNext}>
        {hasNext ? (
          <>
            Next firm <ArrowRight />
          </>
        ) : (
          'No more firms to call'
        )}
      </Button>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        <button
          type="button"
          data-testid="call-set-outcome"
          onClick={onOutcome}
          className="rounded-sm text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Add a note or set the outcome
        </button>
      </div>
    </div>
  );
}

export function CallPanel(props: CallPanelProps): JSX.Element {
  const { state, view, actions, call, status, firmId, blockers, progress, hasNext } = props;
  const phase = call.state;
  const here = 'firmId' in phase && phase.firmId === firmId;
  const onCall = phase.phase === 'starting' || phase.phase === 'ringing' || phase.phase === 'connected';
  const live = here && onCall;
  // A live call's controls never depend on which firm is open (S2 review, finding 4): a
  // read that lands mid-call and opens another firm leaves Hang up and Mute where they
  // were, for the call's own firm, while Today brings that firm back.
  const liveElsewhere = !here && onCall && 'firmId' in phase ? phase.firmId : null;
  const ended = here && phase.phase === 'ended';
  const cadence = status.view?.cadence ?? null;
  const parked = cadence?.parked === true;

  let body: JSX.Element;
  if (liveElsewhere !== null) {
    body = <LiveCall call={call} firmId={liveElsewhere} />;
  } else if (firmId === null || state.expanded === null) {
    body = <p className="text-sm text-muted-foreground">No firm selected.</p>;
  } else if (live) {
    body = <LiveCall call={call} firmId={firmId} />;
  } else if (ended) {
    body = (
      <AfterCall
        progress={progress}
        seconds={phase.phase === 'ended' ? phase.seconds : null}
        hasNext={hasNext}
        onNext={props.onNext}
        onOutcome={props.onOutcome}
      />
    );
  } else if (blockers.length > 0) {
    body = (
      <div data-testid="call-blocked" className="flex flex-col gap-3">
        <div className="rounded-lg border border-border bg-warn-soft/60 p-3">
          <p className="text-sm font-medium text-warn-ink">Can’t call yet</p>
          <ul className="mt-1 flex flex-col gap-0.5 text-sm">
            {blockers.map(blocker => (
              <li key={blocker} data-testid={`call-blocker-${blocker}`}>
                {BLOCKER_SENTENCES[blocker]}
              </li>
            ))}
          </ul>
        </div>
        {blockers.map(blocker => (
          <Button key={blocker} variant="outline" data-testid={`call-fix-${blocker}`} className={dense.md} onClick={() => props.onFix(blocker)}>
            {BLOCKER_FIXES[blocker]} <Kbd className="ml-1">E</Kbd>
          </Button>
        ))}
      </div>
    );
  } else if (status.view?.provider !== 'twilio') {
    // Calling off, or not known yet: the dial panel as it always was.
    body = (
      <div className="flex flex-col gap-3">
        <DialPanel state={state} view={view} actions={actions} calling={{ status, call }} />
      </div>
    );
  } else {
    body = (
      <div data-testid="call-idle" className="flex flex-col gap-4">
        <ReadAloud live={false} />
        {view.dialRoutes.length === 0 ? (
          <p className="text-sm text-muted-foreground">This firm has no number Callie may dial.</p>
        ) : (
          view.dialRoutes.map(entry => (
            <div key={entry.route.routeId} data-testid="dial-route" className="flex flex-col gap-1.5">
              <Button
                data-testid="dial"
                className={cn(dense.lg, 'w-full gap-2')}
                disabled={!entry.enabled || parked || call.state.phase === 'starting'}
                onClick={() => {
                  call.place({ firmId, contactId: entry.route.contactId, routeId: entry.route.routeId });
                }}
              >
                <Phone /> Call <span className="font-mono tabular">{entry.route.e164}</span>
              </Button>
              {entry.reasons.length === 0 ? null : (
                <ul data-testid="dial-reasons" className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                  {entry.reasons.map(reason => (
                    <li key={reason} data-testid="dial-reason">
                      {reason}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))
        )}
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {view.dialRoutes[0]?.advice?.firmLocalTime == null ? null : (
            <>
              <dt className="text-muted-foreground">Their time</dt>
              <dd className="tabular">{view.dialRoutes[0].advice.firmLocalTime}</dd>
            </>
          )}
          {cadence === null ? null : (
            <>
              <dt className="text-muted-foreground">Attempt</dt>
              <dd data-testid="call-attempt">{attemptLabel(cadence)}</dd>
            </>
          )}
        </dl>
        {parked ? (
          <Button
            variant="outline"
            data-testid="call-resume"
            className={dense.md}
            disabled={status.resuming || !view.actionsEnabled}
            onClick={() => {
              void status.resume().then(() => {
                actions.expand(firmId);
              });
            }}
          >
            <RotateCw /> Resume calling
          </Button>
        ) : null}
        {phase.phase === 'refused' && here ? (
          <p data-testid="call-refused" role="alert" className="text-xs text-danger-ink">
            {phase.sentence}
          </p>
        ) : null}
        <p className="text-xs text-faint">Calls start only from a Call button. No shortcut dials.</p>
      </div>
    );
  }

  return (
    <section data-region="call" aria-label="Call" className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
        <h2 className="text-sm font-semibold">Call</h2>
        <PhaseChip call={call} firmId={firmId} />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">{body}</div>
    </section>
  );
}
