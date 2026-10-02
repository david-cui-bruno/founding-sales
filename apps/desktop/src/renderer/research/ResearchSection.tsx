import { type JSX } from 'react';
import { useKeptText } from '../firms/crmMemory.ts';
import { Group } from '../v2/parts.tsx';
import type { ResearchState } from '../researchContract.ts';
import { Button } from '../ui/button.tsx';
import { Input } from '../ui/input.tsx';
import { Row, RowActions, RowMain, Rows } from '../ui/layout.tsx';
import { factLine, factSourceLine, shortDate, sourceHost, judgmentChips, researchNotice, runLine } from '../researchView.ts';

/**
 * The Firm page's Research section (lane R).
 *
 * The brief is on the Today card, where somebody is about to make a call. This is the
 * long form: the four judgments with the reason each rests on, every fact with its
 * quote and its source, what each run did and what it cost, the links a person added,
 * and the two controls.
 *
 * It reads `/research/firm` rather than the firm page's own contract. That contract is
 * a `z.strictObject` behind `pageVersion`, so adding a key to it is a wire break; a
 * section that reads its own route is not.
 */

export function ResearchSection({
  firmId,
  state,
  enabled,
  busy,
  onResearchNow,
  onAddLink,
}: {
  readonly firmId: string;
  readonly state: ResearchState | null;
  readonly enabled: boolean;
  /** Whether one named form's own command is on the wire (1.0.13, P1-4). */
  busy(form: string): boolean;
  onResearchNow(): void;
  onAddLink(url: string): void;
}): JSX.Element {
  // Kept above the route: a link half typed is still there after a visit to Today.
  const [url, setUrl] = useKeptText(`research-link:${firmId}`);
  const firm = state?.firm ?? null;
  const judgments = firm?.judgments ?? null;
  const running = busy(`research-run:${firmId}`);
  const linking = busy(`research-link:${firmId}`);

  return (
    <Group
      data-testid="research-panel"
      title="Research"
      actions={
        <Button
          variant="outline"
          size="sm"
          data-testid="research-now"
          disabled={!enabled || running}
          {...(running ? { 'aria-busy': true } : {})}
          onClick={onResearchNow}
        >
          Research now
        </Button>
      }
    >
      {state?.notice == null ? null : (
        <p data-testid="research-notice" className="py-1 text-sm text-muted-foreground">
          {researchNotice(state.notice)}
        </p>
      )}

      {firm === null ? null : <ResearchBasics facts={firm.facts} />}

      {judgments === null ? (
        <p data-testid="research-empty" className="py-1 text-sm text-muted-foreground">
          Callie has not read this firm’s site yet.
        </p>
      ) : (
        <ul data-testid="research-judgments" className="flex flex-col gap-1 py-1">
          {judgmentChips(judgments).map(chip => (
            <li key={chip.label} data-testid={`research-judgment-${chip.label.toLowerCase()}`} className="text-sm">
              <span className="text-muted-foreground">
                {chip.label} {chip.text}
              </span>{' '}
              <span data-testid="research-reason" className="text-xs text-muted-foreground">
                {reasonFor(judgments.reasons, chip.label)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {firm === null || firm.facts.length === 0 ? null : (
        <Rows data-testid="research-facts">
          {firm.facts.map(fact => (
            <Row key={fact.id} data-testid="research-fact">
              <RowMain
                line={factLine(fact)}
                detail={
                  <a
                    data-testid="research-fact-source"
                    href={fact.sourceReference}
                    target="_blank"
                    rel="noreferrer"
                    className="underline-offset-2 hover:underline"
                  >
                    {factSourceLine(fact)}
                  </a>
                }
              />
            </Row>
          ))}
        </Rows>
      )}

      {firm === null || firm.runs.length === 0 ? null : (
        <ul data-testid="research-runs" className="mt-3 flex flex-col gap-0.5">
          {firm.runs.map(run => (
            <li key={run.revision} data-testid="research-run" className="text-xs text-muted-foreground">
              {runLine(run)}
            </li>
          ))}
        </ul>
      )}

      {firm === null || firm.links.length === 0 ? null : (
        <ul data-testid="research-links" className="mt-3 flex flex-col gap-0.5">
          {firm.links.map(link => (
            <li key={link.id} className="text-xs">
              <a
                data-testid="research-link"
                href={link.url}
                target="_blank"
                rel="noreferrer"
                className="text-muted-foreground underline-offset-2 hover:underline"
              >
                {link.url}
              </a>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex items-center gap-2">
        <Input
          data-testid="research-link-input"
          value={url}
          placeholder="https://…"
          disabled={!enabled || linking}
          onChange={event => {
            setUrl(event.target.value);
          }}
        />
        <RowActions>
          <Button
            size="sm"
            data-testid="research-add-link"
            disabled={!enabled || linking || url.trim() === ''}
            {...(linking ? { 'aria-busy': true } : {})}
            onClick={() => {
              onAddLink(url.trim());
              setUrl('');
            }}
          >
            Add a link
          </Button>
        </RowActions>
      </div>
    </Group>
  );
}

/** The reason recorded for one judgment, by the label the chips use. */
function reasonFor(reasons: Readonly<Record<string, string>>, label: string): string {
  const key =
    label === 'Fit' ? 'fit' : label === 'Problem' ? 'problemEvidence' : label === 'Timing' ? 'timing' : 'reachability';
  return reasons[key] ?? '';
}

/**
 * Doors and software, as research found them (S4). Nothing structured stores either, so these
 * are the two research facts that speak to them, each labelled as research with its source,
 * and "unknown" when the run found nothing: the page never guesses a figure.
 */
const BASICS: readonly { readonly key: string; readonly label: string }[] = [
  { key: 'portfolio_size', label: 'Doors' },
  { key: 'software_evidence', label: 'Software' },
];

function ResearchBasics({ facts }: { readonly facts: readonly { readonly key: string; readonly quote: string | null; readonly sourceReference: string; readonly retrievedAt: string }[] }): JSX.Element {
  return (
    <dl data-testid="research-basics" className="mb-2 grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
      {BASICS.map(({ key, label }) => {
        const fact = facts.find(entry => entry.key === key);
        return (
          <div key={key} className="contents">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd data-testid={`research-basic-${key}`} className="min-w-0">
              {fact === undefined ? (
                <span className="text-faint">Unknown</span>
              ) : (
                <>
                  <span>{factLine(fact)}</span>{' '}
                  <span className="text-xs text-muted-foreground">
                    from research · {sourceHost(fact.sourceReference)} · {shortDate(fact.retrievedAt)}
                  </span>
                </>
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
