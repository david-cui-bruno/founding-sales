import { useState, type JSX } from 'react';
import type { PreparedBriefDto } from '@fss/contracts';
import { shortDate } from '../researchView.ts';
import { Label } from '../v2/parts.tsx';

/**
 * A firm's prepared brief (lane PB, migration 0038), on the firm page and on the Today card.
 *
 * Text prepared outside Callie — the DFW research agent's call briefs — shown beside
 * Callie's own research and never mistaken for it: the label says "Prepared research ·
 * observed <date> · not verified by Callie". The text keeps its line breaks and folds
 * beyond about six lines behind "Show more". Each source is a link that opens in the
 * default browser through the seam that already exists (`app.ts`'s window-open handler
 * hands an `https:` URL to `shell.openExternal` and denies everything else); a source that
 * is not https is shown as its label and not linked.
 *
 * **Read-only** (scope reduction after review PBR). David asked for the briefs to be
 * accessible, not edited in Callie; a brief changes only when a corrected file is imported
 * (Firms → Import → "Import prepared briefs (JSON)…"). So there is no editor, no command and
 * nothing kept across views here: the one piece of state, "Show more", is this mount's.
 */

const COLLAPSE_LINES = 6;
const COLLAPSE_CHARACTERS = 600;

/** "2 Oct 2026" from `2026-10-02`, read at local noon so no zone moves it a day. */
export function observedDate(date: string): string {
  return shortDate(`${date}T12:00:00`) || date;
}

export function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

export function PreparedBrief({
  brief,
}: {
  /** The firm's prepared brief, or null; undefined when the read did not carry one (an older API). */
  readonly brief: PreparedBriefDto | null | undefined;
}): JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  if (brief == null) return null;

  const lines = brief.brief.split('\n');
  const long = lines.length > COLLAPSE_LINES || brief.brief.length > COLLAPSE_CHARACTERS;
  const folded = long && !expanded;

  return (
    <section data-testid="prepared-brief">
      <Label>Prepared brief</Label>
      <p data-testid="prepared-brief-provenance" className="mb-1.5 text-xs text-faint">
        Prepared research · observed {observedDate(brief.observedOn)} · not verified by Callie
      </p>
      <p data-testid="prepared-brief-text" className={folded ? 'line-clamp-6 text-sm whitespace-pre-line' : 'text-sm whitespace-pre-line'}>
        {brief.brief}
      </p>
      {long ? (
        <button
          type="button"
          data-testid="prepared-brief-more"
          aria-expanded={expanded}
          className="mt-0.5 text-xs text-muted-foreground hover:text-foreground hover:underline"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}

      {brief.sources.length === 0 ? null : (
        <ul data-testid="prepared-brief-sources" className="mt-2 flex flex-col gap-0.5">
          {brief.sources.map(source => (
            <li key={source.url} className="text-xs">
              {isHttpsUrl(source.url) ? (
                <a
                  data-testid="prepared-brief-source"
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  {source.label}
                  <span className="text-faint"> · {source.url.replace(/^https:\/\//u, '').split('/')[0]}</span>
                </a>
              ) : (
                <span data-testid="prepared-brief-source-unlinked" className="text-muted-foreground">
                  {source.label}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
