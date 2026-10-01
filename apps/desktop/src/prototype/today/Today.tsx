import { ArrowUpRight, CalendarClock, ChevronDown, ChevronRight, ListChecks, Pencil, Undo2 } from 'lucide-react';
import { useState, type JSX } from 'react';
import { cn } from '../../renderer/lib/utils.ts';
import { Button } from '../../renderer/ui/button.tsx';
import { ineligibility, type Firm } from '../fixtures.ts';
import { Block, Chip, dense, Kbd, Label, Skeleton } from '../parts.tsx';
import type { CallPhase, LoadState } from '../state.ts';
import { Contacts, FirmProperties, NextActions } from '../firm/FirmContext.tsx';
import { Brief, BriefSkeleton } from './Brief.tsx';
import { CallPanel, type Steps } from './CallPanel.tsx';
import { Queue } from './Queue.tsx';

/**
 * Today: three regions. The queue on the left, the selected firm in the middle and the
 * call on the right, all visible at once from 1280px. From 1920px the middle splits into
 * the brief and a context column (properties, contacts, next actions); below that the
 * properties fold into a Details row under the firm's name.
 */

export function FirmHeader({
  firm,
  onEdit,
  onOpen,
  compact = false,
}: {
  readonly firm: Firm;
  onEdit(): void;
  onOpen?(): void;
  readonly compact?: boolean;
}): JSX.Element {
  const blocked = ineligibility(firm);
  const meta = [
    firm.city === null ? null : `${firm.city}, ${firm.state ?? ''}`,
    firm.timeZone === null ? null : '9:40 am local',
    firm.doors === 'Unknown' ? null : firm.doors,
    firm.software === 'Unknown' ? null : firm.software,
    firm.phone,
  ].filter((part): part is string => part !== null);
  return (
    <header data-testid="firm-header" className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {firm.queue?.reason === 'callback' ? (
          <Chip icon={<CalendarClock />}>Callback due 10:30 am</Chip>
        ) : firm.queue?.reason === 'reply' ? (
          <Chip tone="info">Replied this morning</Chip>
        ) : blocked !== null ? (
          <Chip tone="warn">Not eligible · {blocked.title.toLowerCase()}</Chip>
        ) : (
          <Chip tone="outline">New prospect</Chip>
        )}
        {firm.queue?.attempt === undefined ? null : <Chip tone="outline">Attempt {firm.queue.attempt} of 4</Chip>}
      </div>
      <div className="flex items-start justify-between gap-4">
        <h1
          data-testid="firm-name"
          title={firm.name}
          className={cn('line-clamp-2 min-w-0 font-semibold tracking-tight text-balance', compact ? 'text-xl' : 'text-2xl')}
        >
          {firm.name}
        </h1>
        <div className="flex shrink-0 items-center gap-1 pt-0.5">
          <Button variant="ghost" className={cn(dense.md, 'text-muted-foreground')} onClick={onEdit}>
            <Pencil /> Edit <Kbd className="ml-0.5">E</Kbd>
          </Button>
          {onOpen === undefined ? null : (
            <Button variant="ghost" className={cn(dense.icon, 'text-muted-foreground')} aria-label="Open firm page" title="Open firm page" onClick={onOpen}>
              <ArrowUpRight />
            </Button>
          )}
        </div>
      </div>
      <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground">
        {meta.map((part, index) => (
          <span key={part} className={cn(index > 0 && "before:mr-1.5 before:text-faint before:content-['·']", part === firm.phone && 'font-mono text-[12.5px] tabular')}>
            {part}
          </span>
        ))}
        {firm.phone === null ? <span className="text-warn-ink before:mr-1.5 before:text-faint before:content-['·']">no phone</span> : null}
        {firm.city === null ? <span className="text-warn-ink before:mr-1.5 before:text-faint before:content-['·']">location unknown</span> : null}
      </p>
    </header>
  );
}

function LatestCall({ firm, steps }: { readonly firm: Firm; readonly steps: Steps }): JSX.Element {
  const [moved, setMoved] = useState(true);
  return (
    <section data-testid="latest-call" className="mb-6 rounded-lg border border-border p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Just now · call with {firm.contacts[0]?.name ?? 'the office'}</h2>
        <span className="text-xs text-muted-foreground tabular">4:12</span>
      </div>
      {steps.transcription === 'failed' ? (
        <p data-testid="summary-failed" className="text-sm text-muted-foreground">
          No summary: the transcript didn’t come back. The recording is kept; retry from the call panel or write the notes yourself.
        </p>
      ) : steps.analysis !== 'done' ? (
        <div data-testid="summary-pending" className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">Analysis in progress. The summary and next steps will appear here; nothing needs filling in.</p>
          <Skeleton className="w-11/12" />
          <Skeleton className="w-4/5" />
          <Skeleton className="w-2/3" />
        </div>
      ) : (
        <div data-testid="summary-done" className="flex flex-col gap-3">
          <ul className="flex list-disc flex-col gap-0.5 pl-4 text-base marker:text-faint">
            <li>Marcus handles about 25 maintenance calls a week himself; nights go to an answering service that only takes messages.</li>
            <li>Dana wants Glen (the owner) to see how after-hours calls would be triaged.</li>
            <li>Portfolio: about 420 single-family homes, all on AppFolio (a fact, not a commitment).</li>
          </ul>
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">Saved automatically</p>
            <ul className="flex flex-col gap-1">
              <li className="flex items-start gap-2 text-sm">
                <CalendarClock className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <span className="flex-1">
                  Callback <span className="font-medium">Tue 7 Oct, 2:00 pm CT</span>{' '}
                  <span className="text-muted-foreground">— “Try us Tuesday at two, Glen’s in then.”</span>
                </span>
                <Button variant="ghost" className={cn(dense.sm, 'text-muted-foreground')}>
                  Edit
                </Button>
              </li>
              <li className="flex items-start gap-2 text-sm">
                <ArrowUpRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <span className={cn('flex-1', !moved && 'text-muted-foreground line-through')}>
                  Moved to <span className="font-medium">Interested</span> <span className="text-muted-foreground">— asked to see a demo with the owner</span>
                </span>
                <Button variant="ghost" className={cn(dense.sm, 'text-muted-foreground')} onClick={() => setMoved(!moved)}>
                  <Undo2 /> {moved ? 'Undo' : 'Redo'}
                </Button>
              </li>
            </ul>
          </div>
          <div data-testid="needs-review" className="rounded-md border border-warn/40 bg-warn-soft/50 px-3 py-2">
            <p className="flex items-center gap-1.5 text-xs font-medium text-warn-ink">
              <ListChecks className="size-3.5" /> Needs review
            </p>
            <p className="mt-0.5 text-sm">
              Send the one-page overview? Dana said “you could send something over” — unclear whether that’s permission to e-mail.
            </p>
            <div className="mt-2 flex gap-1.5">
              <Button variant="outline" className={cn(dense.sm, 'bg-background')}>
                Yes, permitted
              </Button>
              <Button variant="ghost" className={dense.sm}>
                No
              </Button>
              <span className="ml-auto self-center text-xs text-muted-foreground">Only this follow-up waits</span>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export function Today({
  firms,
  firm,
  queueState,
  briefState,
  phase,
  startedAt,
  endedSec,
  steps,
  done,
  editField,
  researchOpen,
  onSelect,
  onCall,
  onHangUp,
  onNext,
  onRetryStep,
  onRetryQueue,
  onEdit,
  onOpenFirm,
}: {
  readonly firms: readonly Firm[];
  readonly firm: Firm | undefined;
  readonly queueState: LoadState;
  readonly briefState: 'ready' | 'loading';
  readonly phase: CallPhase;
  readonly startedAt: number;
  readonly endedSec: number;
  readonly steps: Steps;
  readonly done: readonly string[];
  readonly editField: string | null;
  readonly researchOpen: boolean;
  onSelect(id: string): void;
  onCall(): void;
  onHangUp(): void;
  onNext(): void;
  onRetryStep(): void;
  onRetryQueue(): void;
  onEdit(): void;
  onOpenFirm(): void;
}): JSX.Element {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const showFirm = queueState === 'ready' && firm !== undefined;
  const blocked = firm === undefined ? null : ineligibility(firm);
  const details = detailsOpen || editField !== null || blocked !== null;
  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-[256px] shrink-0 flex-col border-r border-border bg-sidebar min-[1440px]:w-[280px] min-[1920px]:w-[320px]">
        <Queue firms={firms} selected={firm?.id ?? ''} state={queueState} done={done} onSelect={onSelect} onRetry={onRetryQueue} />
      </div>

      <div data-region="firm" className="min-w-0 flex-1 overflow-y-auto">
        {!showFirm ? (
          <div className="mx-auto max-w-[720px] px-8 pt-8">
            {queueState === 'loading' ? (
              <>
                <Skeleton className="mb-3 h-6 w-2/3" />
                <Skeleton className="mb-8 h-3 w-1/2" />
                <BriefSkeleton />
              </>
            ) : (
              <p className="pt-24 text-center text-sm text-muted-foreground">
                {queueState === 'error' ? 'The brief appears once the queue loads.' : 'Pick a firm from the queue, or add one.'}
              </p>
            )}
          </div>
        ) : (
          <div className="mx-auto flex max-w-[1240px] gap-10 px-8 pt-6 pb-16 min-[1920px]:px-10">
            <div className="min-w-0 max-w-[720px] flex-1">
              <FirmHeader firm={firm} onEdit={onEdit} onOpen={onOpenFirm} />
              <div className="mt-3 border-b border-border pb-3 min-[1920px]:hidden">
                <button
                  type="button"
                  aria-expanded={details}
                  onClick={() => setDetailsOpen(!details)}
                  className="-mx-1.5 flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  {details ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                  Details
                </button>
                {details ? (
                  <div className="mt-2 max-w-[460px]">
                    <FirmProperties firm={firm} editField={editField} explain={false} />
                  </div>
                ) : null}
              </div>
              <div className="mt-6">
                {phase === 'ended' && blocked === null ? <LatestCall firm={firm} steps={steps} /> : null}
                {briefState === 'loading' ? <BriefSkeleton /> : <Brief key={firm.id} firm={firm} researchOpen={researchOpen} />}
              </div>
            </div>
            <aside data-region="context" aria-label="Firm context" className="hidden w-[320px] shrink-0 flex-col min-[1920px]:flex">
              <Block>
                <Label>Properties</Label>
                <FirmProperties firm={firm} editField={editField} explain={false} />
              </Block>
              <Block>
                <Label>Next actions</Label>
                <NextActions firm={firm} />
              </Block>
              <Block>
                <Label>Contacts</Label>
                <Contacts firm={firm} />
              </Block>
            </aside>
          </div>
        )}
      </div>

      <div className="flex w-[300px] shrink-0 flex-col border-l border-border min-[1440px]:w-[320px] min-[1920px]:w-[360px]">
        {firm === undefined || queueState !== 'ready' ? (
          <section data-region="call" aria-label="Call" className="flex flex-col">
            <header className="flex h-11 items-center border-b border-border px-4">
              <h2 className="text-sm font-semibold">Call</h2>
            </header>
            <p className="p-4 text-sm text-muted-foreground">No firm selected.</p>
          </section>
        ) : (
          <CallPanel
            firm={firm}
            phase={phase}
            startedAt={startedAt}
            endedSec={endedSec}
            steps={steps}
            onCall={onCall}
            onHangUp={onHangUp}
            onNext={onNext}
            onRetry={onRetryStep}
            onFix={onEdit}
          />
        )}
      </div>
    </div>
  );
}
