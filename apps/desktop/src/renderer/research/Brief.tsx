import type { JSX } from 'react';
import type { CallBriefDto } from '@fss/contracts';
import { Button } from '../ui/button.tsx';
import { failedTriesLine, judgmentChips, shortDate, sourceHost, NOT_RESEARCHED_LINE } from '../researchView.ts';

/**
 * The call brief, above the tasks on an expanded Today card (lane R).
 *
 * David's taste, in three decisions:
 *
 *   * **grey, and no colour but a dot.** The four judgments are small grey labels, not
 *     badges: `Fit · yes` reads and a green pill shouts. The only colour anywhere is
 *     the dot before a `yes`;
 *   * **the firm's own words are quoted and an AI interpretation is labelled.** The
 *     quotes carry their source host and the date they were read; the two questions
 *     and the opening sit under one grey "AI suggestion", which is the whole of what
 *     the design record asks the card to distinguish. A quote from a link somebody
 *     added carries its `attribution` — "per news.test" — because a page on another
 *     host is not the firm saying anything, and laying it out identically would present
 *     it as though it were;
 *   * **hover-revealed action.** "Research again" appears with the row, like every
 *     other action in this build, and a firm with no brief shows one grey line and the
 *     same action rather than an empty section.
 *
 * A source opens in the system browser through the seam that already exists:
 * `app.ts`'s `setWindowOpenHandler` hands an `https:` URL to `shell.openExternal` and
 * denies everything else. There is no new channel, because a channel that opened a URL
 * the renderer chose is exactly what that handler was narrowed to prevent in 1.0.12.
 */

function Source({ url, retrievedAt }: { readonly url: string; readonly retrievedAt: string }): JSX.Element {
  return (
    <a
      data-testid="brief-source"
      href={url}
      target="_blank"
      rel="noreferrer"
      className="text-xs text-muted-foreground underline-offset-2 hover:underline"
    >
      {sourceHost(url)} · {shortDate(retrievedAt)}
    </a>
  );
}

function Quotes({
  testId,
  label,
  quotes,
}: {
  readonly testId: string;
  readonly label: string;
  readonly quotes: CallBriefDto['whyFit'];
}): JSX.Element | null {
  if (quotes.length === 0) return null;
  return (
    <div data-testid={testId} className="mt-2 flex flex-col gap-1">
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
      {quotes.map(entry => (
        <p key={`${entry.sourceReference}:${entry.quote}`} className="flex flex-col gap-0.5 text-sm">
          <span data-testid="brief-quote">
            “{entry.quote}”
            {entry.attribution === null ? null : (
              <span data-testid="brief-attribution" className="ml-1 text-xs text-muted-foreground">
                {entry.attribution}
              </span>
            )}
          </span>
          <Source url={entry.sourceReference} retrievedAt={entry.retrievedAt} />
        </p>
      ))}
    </div>
  );
}

export function Brief({
  brief,
  onResearchAgain,
  researching,
  enabled,
}: {
  readonly brief: CallBriefDto | null;
  onResearchAgain(): void;
  /** Whether this card's own "Research again" is on the wire (P1-4). */
  readonly researching: boolean;
  readonly enabled: boolean;
}): JSX.Element {
  const again = (
    <Button
      variant="quiet"
      size="sm"
      data-testid="research-again"
      disabled={!enabled || researching}
      {...(researching ? { 'aria-busy': true } : {})}
      onClick={onResearchAgain}
    >
      Research again
    </Button>
  );

  if (brief === null) {
    return (
      <div data-testid="today-brief" className="group/brief mb-3 flex items-baseline justify-between gap-3">
        <p data-testid="brief-absent" className="text-sm text-muted-foreground">
          {NOT_RESEARCHED_LINE}
        </p>
        <span className="opacity-0 transition-opacity group-focus-within/brief:opacity-100 group-hover/brief:opacity-100">
          {again}
        </span>
      </div>
    );
  }

  const failed = failedTriesLine(brief.failedTries);

  return (
    <div data-testid="today-brief" className="group/brief mb-3 border-b border-border pb-3">
      {failed === null ? null : (
        // Above everything, because it is a statement about how old the rest of this is.
        <p data-testid="brief-failed" className="mb-1 text-xs text-muted-foreground">
          {failed}
        </p>
      )}
      <div className="flex items-baseline justify-between gap-3">
        <ul data-testid="brief-judgments" className="flex flex-wrap items-baseline gap-3">
          {judgmentChips(brief.judgments).map(chip => (
            <li key={chip.label} data-testid={`judgment-${chip.label.toLowerCase()}`} className="text-xs text-muted-foreground">
              {/* The only colour on the card: a dot for a yes. */}
              {chip.value === 'yes' ? <span aria-hidden className="mr-1 text-emerald-600">•</span> : null}
              {chip.label} {chip.text}
            </li>
          ))}
        </ul>
        <span className="shrink-0 opacity-0 transition-opacity group-focus-within/brief:opacity-100 group-hover/brief:opacity-100">
          {again}
        </span>
      </div>

      <Quotes testId="brief-why-fit" label="Why this firm" quotes={brief.whyFit} />
      <Quotes testId="brief-what-changed" label="What changed" quotes={brief.whatChanged} />

      {brief.likelyPerson === null ? null : (
        <p data-testid="brief-person" className="mt-2 text-sm">
          <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Likely person</span>{' '}
          {brief.likelyPerson.name}
          {brief.likelyPerson.title === null ? '' : `, ${brief.likelyPerson.title}`}
        </p>
      )}

      {brief.questions === null && brief.opening === null ? null : (
        <div data-testid="brief-generated" className="mt-2 flex flex-col gap-1">
          {/* The one label the design record asks for: these two lines are a model's
              words and not the firm's, and nothing else on this card is. */}
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">AI suggestion</p>
          {brief.questions === null ? null : (
            <ul data-testid="brief-questions" className="flex flex-col gap-0.5 text-sm">
              {brief.questions.map(question => (
                <li key={question}>{question}</li>
              ))}
            </ul>
          )}
          {brief.opening === null ? null : (
            <p data-testid="brief-opening" className="text-sm">
              {brief.opening}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
