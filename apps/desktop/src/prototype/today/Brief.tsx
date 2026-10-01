import { ChevronDown, ChevronRight, ExternalLink, Phone, Mail, StickyNote } from 'lucide-react';
import { useState, type JSX } from 'react';
import { cn } from '../../renderer/lib/utils.ts';
import type { Activity, Firm } from '../fixtures.ts';
import { Block, Label, Provenance, Skeleton } from '../parts.tsx';

/**
 * The 30-second brief: why this firm, facts (verified, hypothesis, unknown — each labelled),
 * who to ask for, previous interactions, a suggested opening and two questions. Deeper
 * research and its sources expand in place, so reading it never loses the selected firm.
 */

export function ActivityIcon({ kind }: { readonly kind: Activity['kind'] }): JSX.Element {
  const Icon = kind === 'call' ? Phone : kind === 'email' ? Mail : StickyNote;
  return <Icon className="size-3.5 shrink-0 text-faint" aria-hidden />;
}

export function duration(seconds: number): string {
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`;
}

export function BriefSkeleton(): JSX.Element {
  return (
    <div data-testid="brief-loading" aria-label="Loading the brief" className="flex flex-col gap-6">
      {[0, 1, 2].map(index => (
        <div key={index} className="flex flex-col gap-2">
          <Skeleton className="h-2.5 w-24" />
          <Skeleton className="w-full" />
          <Skeleton className="w-5/6" />
          <Skeleton className="w-2/3" />
        </div>
      ))}
    </div>
  );
}

export function Brief({ firm, researchOpen: initiallyOpen = false }: { readonly firm: Firm; readonly researchOpen?: boolean }): JSX.Element {
  const [open, setOpen] = useState(initiallyOpen);
  const previous = firm.activity.slice(0, 3);
  return (
    <div data-testid="brief" className="flex flex-col">
      <Block>
        <Label>Why this firm</Label>
        <p className="text-base text-foreground">{firm.whyThisFirm}</p>
      </Block>

      <Block>
        <Label>Ask for</Label>
        <p className="text-base font-medium">{firm.askFor.who}</p>
        {firm.askFor.note === '' ? null : <p className="text-sm text-muted-foreground">{firm.askFor.note}</p>}
      </Block>

      <Block>
        <Label>What we know</Label>
        <dl className="flex flex-col">
          {firm.facts.map(fact => (
            <div key={fact.label} className="grid grid-cols-[120px_minmax(0,1fr)_auto] items-baseline gap-3 border-b border-border py-1.5 last:border-b-0">
              <dt className="text-sm text-muted-foreground">{fact.label}</dt>
              <dd className={cn('text-sm', fact.kind === 'unknown' && 'text-muted-foreground', fact.kind === 'hypothesis' && 'italic')}>{fact.value}</dd>
              <dd className="flex max-w-[220px] justify-end">
                <Provenance kind={fact.kind} {...(fact.source === undefined ? {} : { source: fact.source })} />
              </dd>
            </div>
          ))}
        </dl>
      </Block>

      {firm.opening === '' ? null : (
        <Block>
          <Label>Suggested opening</Label>
          <blockquote className="border-l-2 border-strong pl-3 text-base text-foreground">{firm.opening}</blockquote>
        </Block>
      )}

      {firm.questions[0] === '' ? null : (
        <Block>
          <Label>Two questions</Label>
          <ol className="flex flex-col gap-1.5">
            {firm.questions.map((question, index) => (
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
        {previous.length === 0 ? (
          <p className="text-sm text-muted-foreground">None yet. This would be the first contact.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {previous.map(item => (
              <li key={`${item.at}:${item.title}`} className="flex gap-2.5">
                <span className="mt-[3px]">
                  <ActivityIcon kind={item.kind} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm">
                    <span className="font-medium">{item.title}</span>
                    {item.durationSec === undefined ? null : <span className="text-muted-foreground tabular"> · {duration(item.durationSec)}</span>}
                    <span className="text-faint"> · {item.at}</span>
                  </p>
                  {item.detail === undefined ? null : <p className="text-sm text-muted-foreground">{item.detail}</p>}
                  {item.summary === undefined ? null : (
                    <ul className="mt-0.5 flex list-disc flex-col pl-4 text-sm text-muted-foreground marker:text-faint">
                      {item.summary.map(line => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Block>

      {firm.research.length === 0 ? null : (
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
            <span className="text-faint">
              · {firm.research.length} notes · {firm.sources.length} sources
            </span>
          </button>
          {open ? (
            <div data-testid="research" className="mt-2 flex flex-col gap-3 pl-5">
              {firm.research.map(note => (
                <div key={note.heading}>
                  <p className="text-sm font-medium">{note.heading}</p>
                  <p className="text-sm text-foreground">
                    {note.body}{' '}
                    {note.sources.map(index => (
                      <sup key={index} className="ml-0.5 text-2xs text-link">
                        [{index + 1}]
                      </sup>
                    ))}
                  </p>
                </div>
              ))}
              <ol className="flex flex-col gap-1 border-t border-border pt-2">
                {firm.sources.map((source, index) => (
                  <li key={source.url} className="flex items-baseline gap-2 text-xs">
                    <span className="w-5 shrink-0 text-faint tabular">[{index + 1}]</span>
                    <span className="min-w-0 flex-1 truncate">
                      <span className="text-foreground">{source.title}</span>{' '}
                      <span className="text-muted-foreground">{source.url.replace(/^https:\/\//u, '')}</span>
                    </span>
                    <span className="shrink-0 text-faint">observed {source.observed}</span>
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
