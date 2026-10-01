import { ArrowRight, Check, Mic, MicOff, Phone, PhoneOff, RotateCw } from 'lucide-react';
import { useEffect, useState, type JSX } from 'react';
import { cn } from '../../renderer/lib/utils.ts';
import { Button } from '../../renderer/ui/button.tsx';
import { Select } from '../../renderer/ui/select.tsx';
import { Textarea } from '../../renderer/ui/textarea.tsx';
import { ANNOUNCEMENT, ineligibility, type Firm } from '../fixtures.ts';
import { Chip, dense, Kbd, StepChip, type Progress } from '../parts.tsx';
import type { CallPhase } from '../state.ts';
import { duration } from './Brief.tsx';

/**
 * The persistent call area. It is always on screen on Today, whatever is selected, so a
 * call in progress is never scrolled away. Starting a call is this button and only this
 * button: no shortcut reaches it.
 */

export interface Steps {
  readonly recording: Progress;
  readonly transcription: Progress;
  readonly analysis: Progress;
}

function PhaseChip({ phase }: { readonly phase: CallPhase }): JSX.Element {
  if (phase === 'dialling') return <Chip tone="info">Ringing…</Chip>;
  if (phase === 'connected')
    return (
      <Chip tone="ok" icon={<span className="size-1.5 animate-pulse rounded-full bg-ok" />}>
        Connected
      </Chip>
    );
  if (phase === 'ended') return <Chip>Ended</Chip>;
  return <Chip tone="outline">Ready</Chip>;
}

function Timer({ startedAt }: { readonly startedAt: number }): JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span data-testid="call-timer" className="font-mono text-[28px] leading-none font-medium tracking-tight tabular">
      {duration(Math.max(0, Math.floor((now - startedAt) / 1000)))}
    </span>
  );
}

export function CallPanel({
  firm,
  phase,
  startedAt,
  endedSec,
  steps,
  onCall,
  onHangUp,
  onNext,
  onRetry,
  onFix,
}: {
  readonly firm: Firm;
  readonly phase: CallPhase;
  readonly startedAt: number;
  readonly endedSec: number;
  readonly steps: Steps;
  onCall(): void;
  onHangUp(): void;
  onNext(): void;
  onRetry(): void;
  onFix(): void;
}): JSX.Element {
  const [muted, setMuted] = useState(false);
  const [read, setRead] = useState(false);
  const blocked = ineligibility(firm);
  const callable = firm.contacts.filter(contact => contact.phone !== undefined);
  const primary = callable[0];
  const person = primary !== undefined && !['Main line', 'Front desk'].includes(primary.name);
  const firstName = person ? (primary.name.split(' ')[0] ?? 'office') : 'the office';
  const local = firm.timeZone === null ? null : '9:40 am';

  return (
    <section data-region="call" aria-label="Call" className="flex min-h-0 flex-col">
      <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
        <h2 className="text-sm font-semibold">Call</h2>
        <PhaseChip phase={blocked === null ? phase : 'idle'} />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {blocked !== null ? (
          <div data-testid="call-blocked" className="flex flex-col gap-3">
            <div className="rounded-lg border border-border bg-warn-soft/60 p-3">
              <p className="text-sm font-medium text-warn-ink">Not eligible: {blocked.title.toLowerCase()}</p>
              <p className="mt-1 text-sm text-foreground">{blocked.detail}</p>
            </div>
            <Button variant="outline" className={dense.md} onClick={onFix}>
              Add {blocked.field.toLowerCase()} <Kbd className="ml-1">E</Kbd>
            </Button>
          </div>
        ) : phase === 'idle' ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="call-who" className="text-xs font-medium text-muted-foreground">
                Who
              </label>
              <Select id="call-who" className="h-8 border-strong text-sm" defaultValue={primary?.name}>
                {callable.map(contact => (
                  <option key={contact.name} value={contact.name}>
                    {contact.name} · {contact.phone}
                  </option>
                ))}
              </Select>
            </div>
            <Button data-testid="call-start" className={cn(dense.lg, 'w-full gap-2')} onClick={onCall}>
              <Phone /> Call {firstName}
            </Button>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted-foreground">Local time</dt>
              <dd className="tabular">{local} · inside calling hours</dd>
              <dt className="text-muted-foreground">Attempt</dt>
              <dd className="tabular">
                {firm.queue?.attempt ?? 1} of 4{(firm.queue?.attempt ?? 1) > 1 ? ' · last 2 days ago' : ' · first call'}
              </dd>
              <dt className="text-muted-foreground">Voicemail</dt>
              <dd>Script shows if nobody answers</dd>
            </dl>
            <p className="text-xs text-faint">Calls start only from this button. No shortcut dials.</p>
          </div>
        ) : phase === 'dialling' ? (
          <div className="flex flex-col gap-4">
            <div>
              <p className="text-sm text-muted-foreground">Calling</p>
              <p className="text-lg font-semibold">{primary?.name}</p>
              <p className="font-mono text-sm text-muted-foreground tabular">{primary?.phone}</p>
            </div>
            <Announcement read={read} onRead={setRead} />
            <Button variant="outline" className={cn(dense.lg, 'w-full border-destructive/40 text-danger-ink hover:bg-danger-soft')} onClick={onHangUp}>
              <PhoneOff /> Cancel call
            </Button>
          </div>
        ) : phase === 'connected' ? (
          <div className="flex flex-col gap-4">
            <div className="flex items-end justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{primary?.name}</p>
                <p className="text-xs text-muted-foreground">Recording</p>
              </div>
              <Timer startedAt={startedAt} />
            </div>
            <Announcement read={read} onRead={setRead} />
            <div className="flex gap-2">
              <Button variant="outline" className={cn(dense.lg, 'flex-1')} aria-pressed={muted} onClick={() => setMuted(!muted)}>
                {muted ? <MicOff /> : <Mic />} {muted ? 'Unmute' : 'Mute'}
              </Button>
              <Button data-testid="call-hangup" className={cn(dense.lg, 'flex-1 bg-destructive text-destructive-foreground hover:bg-destructive/90')} onClick={onHangUp}>
                <PhoneOff /> Hang up
              </Button>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="call-notes" className="text-xs font-medium text-muted-foreground">
                Notes <span className="font-normal text-faint">· optional, saved as you type</span>
              </label>
              <Textarea id="call-notes" rows={4} className="resize-none border-strong text-sm" placeholder="Anything the recording won’t catch" />
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div>
              <p className="text-sm font-medium">Call with {primary?.name} ended</p>
              <p className="text-xs text-muted-foreground tabular">{duration(endedSec)} · recorded</p>
            </div>
            <div data-testid="post-call-steps" className="flex flex-col gap-2">
              <p className="text-xs font-medium text-muted-foreground">After the call</p>
              <div className="flex flex-wrap gap-1.5">
                <StepChip label="Recording" state={steps.recording} testId="step-recording" />
                <StepChip label="Transcription" state={steps.transcription} testId="step-transcription" />
                <StepChip label="Analysis" state={steps.analysis} testId="step-analysis" />
              </div>
              {steps.transcription === 'failed' ? (
                <div className="rounded-lg border border-border p-3">
                  <p className="text-sm font-medium text-danger-ink">Transcription failed</p>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    The recording is saved, but no transcript came back. Retry, or write the notes yourself.
                  </p>
                  <div className="mt-2 flex gap-2">
                    <Button variant="outline" className={dense.sm} onClick={onRetry}>
                      <RotateCw /> Retry
                    </Button>
                    <Button variant="ghost" className={dense.sm}>
                      Write notes
                    </Button>
                  </div>
                </div>
              ) : steps.analysis !== 'done' ? (
                <p className="text-xs text-muted-foreground">Notes and next steps arrive here on their own, usually within a minute. You can move on.</p>
              ) : (
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Check className="size-3 text-ok-ink" /> Summary and next steps saved to the firm.
                </p>
              )}
            </div>
            <Button data-testid="call-next" className={cn(dense.lg, 'w-full gap-2')} onClick={onNext}>
              Next firm <ArrowRight />
            </Button>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              <button type="button" className="rounded-sm text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                Add a note
              </button>
              <button type="button" className="rounded-sm text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                Set outcome manually
              </button>
              <button type="button" className="rounded-sm text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                Don’t call again
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function Announcement({ read, onRead }: { readonly read: boolean; onRead(read: boolean): void }): JSX.Element {
  return (
    <div data-testid="announcement" className={cn('rounded-lg border p-3 transition-colors', read ? 'border-border bg-muted/50' : 'border-strong bg-background shadow-sm')}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">Read aloud first</p>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" checked={read} onChange={event => onRead(event.target.checked)} className="size-3.5 accent-[var(--v2-accent)]" />
          Read
        </label>
      </div>
      <p className={cn('text-base', read ? 'text-muted-foreground' : 'font-medium text-foreground')}>“{ANNOUNCEMENT}”</p>
    </div>
  );
}
