import { ChevronDown, ChevronRight, ExternalLink, Phone } from 'lucide-react';
import { useState, type JSX } from 'react';
import type { CallBriefDto, CallSessionDto } from '@fss/contracts';
import { failedTriesLine, judgmentChips, shortDate, sourceHost } from '../researchView.ts';
import { cn } from '../lib/utils.ts';
import { Button } from '../ui/button.tsx';
import { Block, Chip, Label, Provenance } from '../v2/parts.tsx';
import { callTimer } from '../calling/callText.ts';
import { ChangeOutcome } from '../calling/ChangeOutcome.tsx';

/**
 * The 30-second brief, in the v2 layout (slice S2; plan §4 "Brief").
 *
 * Drawn from what research already recorded (`CallBriefDto`, lane R) and the firm's call
 * history, and **only from that**: a section with nothing behind it says so in one grey
 * line rather than being filled in. The labels are the plan's:
 *
 *   * **Why this firm** — the firm's own words, quoted, each with its source and the date
 *     it was read (verified);
 *   * **Who to ask for** — the person research found, or "not known yet";
 *   * **What we know** — the four judgments as verified, hypothesis or unknown. A "yes" or
 *     "no" rests on recorded facts; "—" is unknown, and says so;
 *   * **Suggested opening** and **Two questions** — a model's words, labelled
 *     "Hypothesis · AI suggestion", never presented as something the firm said;
 *   * **Previous interactions** — the firm's placed calls, newest first, with the summary
 *     when there is one, and a logged call's outcome with "Change" (S3X lane X2,
 *     `calling/ChangeOutcome.tsx`);
 *   * **Deeper research** — what changed and every source, expanded in place so reading it
 *     never loses the selected firm.
 */

const JUDGMENT_NAMES: Readonly<Record<string, string>> = Object.freeze({
  Fit: 'Fit for Callie',
  Problem: 'Evidence of the problem',
  Timing: 'Timing',
  Reach: 'Reachable by phone',
});

function SourceLink({ url, retrievedAt }: { readonly url: string; readonly retrievedAt: string }): JSX.Element {
  return (
    <a
      data-testid="brief-source"
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
    >
      {sourceHost(url)} · read {shortDate(retrievedAt)}
    </a>
  );
}

function Missing({ children, testId }: { readonly children: string; readonly testId?: string }): JSX.Element {
  return (
    <p data-testid={testId} className="text-sm text-muted-foreground">
      {children}
    </p>
  );
}

export function TodayBrief({
  brief,
  calls,
  researching,
  enabled,
  onResearchAgain,
  timeZone = null,
  onCorrected,
}: {
  readonly brief: CallBriefDto | null;
  /** The firm's placed calls, newest first, or null while they are being read. */
  readonly calls: readonly CallSessionDto[] | null;
  readonly researching: boolean;
  readonly enabled: boolean;
  onResearchAgain(): void;
  /** The firm's zone, for a corrected callback's day and time. */
  readonly timeZone?: string | null;
  /** S3X: an outcome was corrected or a stop lifted; absent means no "Change" is offered. */
  onCorrected?(): void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const again = (
    <Button
      variant="ghost"
      data-testid="research-again"
      className="h-6 rounded-md px-2 text-xs text-muted-foreground"
      disabled={!enabled || researching}
      {...(researching ? { 'aria-busy': true } : {})}
      onClick={onResearchAgain}
    >
      {researching ? 'Researching…' : 'Research again'}
    </Button>
  );
  const failed = brief === null ? null : failedTriesLine(brief.failedTries);
  const previous = (calls ?? []).slice(0, 3);

  return (
    <div data-testid="today-brief" className="flex flex-col">
      {failed === null ? null : (
        <p data-testid="brief-failed" className="mb-3 rounded-md bg-warn-soft px-2.5 py-1.5 text-xs text-warn-ink">
          {failed}
        </p>
      )}

      <Block>
        <Label actions={again}>Why this firm</Label>
        {brief === null ? (
          <Missing testId="brief-absent">Not researched yet. Nothing here is known beyond the firm’s name and what you add.</Missing>
        ) : brief.whyFit.length === 0 ? (
          <Missing>Research found nothing on the firm’s own pages that says why.</Missing>
        ) : (
          <ul data-testid="brief-why-fit" className="flex flex-col gap-2">
            {brief.whyFit.map(entry => (
              <li key={`${entry.sourceReference}:${entry.quote}`} className="flex flex-col gap-0.5">
                <span data-testid="brief-quote" className="text-base">
                  “{entry.quote}”
                  {entry.attribution === null ? null : <span className="ml-1 text-xs text-muted-foreground">{entry.attribution}</span>}
                </span>
                <SourceLink url={entry.sourceReference} retrievedAt={entry.retrievedAt} />
              </li>
            ))}
          </ul>
        )}
      </Block>

      <Block>
        <Label>Who to ask for</Label>
        {brief?.likelyPerson == null ? (
          <Missing testId="brief-person-unknown">Not known yet. Ask who handles maintenance calls.</Missing>
        ) : (
          <p data-testid="brief-person" className="text-base font-medium">
            {brief.likelyPerson.name}
            {brief.likelyPerson.title === null ? null : (
              <span className="font-normal text-muted-foreground">, {brief.likelyPerson.title}</span>
            )}
          </p>
        )}
      </Block>

      {brief === null ? null : (
        <Block>
          <Label>What we know</Label>
          <dl data-testid="brief-judgments" className="flex flex-col">
            {judgmentChips(brief.judgments).map(chip => (
              <div
                key={chip.label}
                data-testid={`judgment-${chip.label.toLowerCase()}`}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3 border-b border-border py-1.5 last:border-b-0"
              >
                <dt className="text-sm text-muted-foreground">{JUDGMENT_NAMES[chip.label] ?? chip.label}</dt>
                <dd className="flex items-center gap-2 text-sm">
                  {chip.value === 'unknown' ? (
                    <Provenance kind="unknown" />
                  ) : (
                    <>
                      <span className={cn(chip.value === 'yes' ? 'text-foreground' : 'text-muted-foreground')}>{chip.value === 'yes' ? 'Yes' : 'No'}</span>
                      <Provenance kind="verified" source={`judged ${shortDate(brief.judgedAt)}`} />
                    </>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </Block>
      )}

      {brief?.opening == null ? null : (
        <Block>
          <Label actions={<Chip tone="info">Hypothesis · AI suggestion</Chip>}>Suggested opening</Label>
          <blockquote data-testid="brief-opening" className="border-l-2 border-strong pl-3 text-base">
            {brief.opening}
          </blockquote>
        </Block>
      )}

      {brief?.questions == null ? null : (
        <Block>
          <Label actions={<Chip tone="info">Hypothesis · AI suggestion</Chip>}>Two questions</Label>
          <ol data-testid="brief-questions" className="flex flex-col gap-1.5">
            {brief.questions.map((question, index) => (
              <li key={question} className="flex gap-2.5 text-base">
                <span className="w-4 shrink-0 text-sm text-faint tabular">{index + 1}.</span>
                {question}
              </li>
            ))}
          </ol>
        </Block>
      )}

      <Block>
        <Label>Previous interactions</Label>
        {calls === null ? (
          <Missing>Reading the firm’s calls…</Missing>
        ) : previous.length === 0 ? (
          <Missing testId="brief-no-calls">No calls placed from Callie yet. This would be the first.</Missing>
        ) : (
          <ul data-testid="brief-calls" className="flex flex-col gap-2">
            {previous.map(call => {
              const when = call.startedAt ?? call.endedAt;
              return (
                <li key={call.sessionId} className="flex gap-2.5">
                  <Phone className="mt-[3px] size-3.5 shrink-0 text-faint" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">
                      <span className="font-medium">{call.answeredAt === null ? 'Not answered' : 'Call'}</span>
                      {call.durationSeconds === null || call.answeredAt === null ? null : (
                        <span className="text-muted-foreground tabular"> · {callTimer(call.durationSeconds)}</span>
                      )}
                      {when === null ? null : <span className="text-faint"> · {shortDate(when)}</span>}
                    </p>
                    {call.summary === undefined ? null : <p className="text-sm text-muted-foreground">{call.summary.summary}</p>}
                    {call.callLogId === null || call.outcome == null || onCorrected === undefined ? null : (
                      <ChangeOutcome
                        key={call.callLogId}
                        callLogId={call.callLogId}
                        currentOutcome={call.outcome}
                        timeZone={timeZone}
                        enabled={enabled}
                        onChanged={onCorrected}
                      />
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Block>

      {brief === null || (brief.sources.length === 0 && brief.whatChanged.length === 0) ? null : (
        <Block>
          <button
            type="button"
            aria-expanded={open}
            data-testid="research-toggle"
            onClick={() => setOpen(!open)}
            className="-mx-1.5 flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            Deeper research
            <span className="text-faint">· {brief.sources.length} source{brief.sources.length === 1 ? '' : 's'}</span>
          </button>
          {open ? (
            <div data-testid="research" className="mt-2 flex flex-col gap-3 pl-5">
              {brief.whatChanged.length === 0 ? null : (
                <div>
                  <p className="text-sm font-medium">What changed</p>
                  <ul className="flex flex-col gap-1">
                    {brief.whatChanged.map(entry => (
                      <li key={`${entry.sourceReference}:${entry.quote}`} className="flex flex-col text-sm">
                        <span>“{entry.quote}”</span>
                        <SourceLink url={entry.sourceReference} retrievedAt={entry.retrievedAt} />
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <ol className="flex flex-col gap-1 border-t border-border pt-2">
                {brief.sources.map((source, index) => (
                  <li key={source.sourceReference} className="flex items-baseline gap-2 text-xs">
                    <span className="w-5 shrink-0 text-faint tabular">[{index + 1}]</span>
                    <a href={source.sourceReference} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-foreground hover:underline">
                      {source.sourceReference.replace(/^https?:\/\//u, '')}
                    </a>
                    <span className="shrink-0 text-faint">read {shortDate(source.retrievedAt)}</span>
                    <ExternalLink className="size-3 shrink-0 text-faint" aria-hidden />
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
        </Block>
      )}
    </div>
  );
}
