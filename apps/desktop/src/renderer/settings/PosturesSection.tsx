import { useState, type JSX } from 'react';
import { POSTURES_HEADING, POSTURE_CONFIRMATION, POSTURE_HINT, allowStatesIssues, type PosturesSectionView } from '../postureView.ts';
import type { AllowStatesInput } from '../settingsContract.ts';
import { Button } from '../ui/button.tsx';
import { Field, Row, RowActions, RowMain, Rows, Unread } from '../ui/layout.tsx';
import { useKept } from '../replies/kept.ts';
import { FormNotice } from './FormNotice.tsx';
import { Section } from './Group.tsx';
import { Textarea } from '../ui/textarea.tsx';

/**
 * The states you call (9.2 step 6, 10.1; lane g84, audit item G04; wave 2, S4.2 and D5).
 *
 * Second on the page, because a call to a state that is not on this list is refused.
 *
 * Until 1.0.13 this was a form per state: a day it took effect, a review date, and the
 * four statements ticked one at a time. A posture has no expiry and no review date now,
 * and `POST /postures/allow` takes several states with one confirmation — so this is a
 * list to tick, the four statements once, and a button. The statements are the release's
 * own words, read from the API; the server copies them and the citations for each state
 * it records, because the software records a posture and does not author its sources.
 */
export function PosturesSection({
  section,
  adding,
  revoking,
  onAllow,
  onRevoke,
  onRetry,
}: {
  readonly section: PosturesSectionView;
  /** This section's own Add is on the wire. Nothing else on the page waits for it. */
  readonly adding: boolean;
  /** Whether this row's own Take off the list is on the wire (P1-4). */
  revoking(postureId: string): boolean;
  onAllow(input: AllowStatesInput): void;
  onRevoke(postureId: string): void;
  onRetry(): void;
}): JSX.Element {
  // What was ticked, confirmed and typed is the person's: kept above the route (S4R).
  const [chosenText, setChosenText] = useKept('settings:postures:chosen', '');
  const chosen = chosenText === '' ? [] : chosenText.split(',');
  const setChosen = (next: (current: readonly string[]) => readonly string[]): void => {
    setChosenText(next(chosen).join(','));
  };
  const [confirmedText, setConfirmedText] = useKept('settings:postures:confirmed', '');
  const confirmed = confirmedText === 'yes';
  const setConfirmed = (next: boolean): void => {
    setConfirmedText(next ? 'yes' : '');
  };
  const [note, setNote] = useKept('settings:postures:note', '');
  const [shown, setShown] = useState(false);

  /*
   * A refused add comes back as it was sent. An accepted one empties the form, and that is
   * done by the command's own success answer (`useAdmin`, K6), not by comparing the list
   * here: a form mounted after the answer has nothing to compare with, and a consumed
   * confirmation must never be left to authorise the next state chosen.
   */
  const offered = new Set(section.stateOptions.map(option => option.value));
  const selected = chosen.filter(state => offered.has(state));

  const issues = allowStatesIssues({ states: selected, confirmed, note });
  const issueFor = (field: 'states' | 'confirmed' | 'note'): readonly { readonly testId: string; readonly text: string }[] =>
    shown ? issues.filter(issue => issue.field === field).map(issue => ({ testId: `posture-issue-${field}`, text: issue.text })) : [];

  return (
    <Section data-testid="postures" title={POSTURES_HEADING} count={section.rows.length}>
      <p data-testid="postures-summary" className="py-1 text-sm">
        {section.summary}
      </p>
      {section.unread === null ? null : (
        <Unread line={section.unread} testId="postures-unread" retryTestId="postures-retry" onRetry={onRetry} />
      )}

      {section.rows.length === 0 ? null : (
        <Rows data-testid="posture-rows">
          {section.rows.map(row => (
            <Row key={row.id} data-testid="posture-row" data-state={row.state}>
              <RowMain line={<span data-testid="posture-line">{row.line}</span>} />
              {row.canRevoke ? (
                <RowActions>
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid={`posture-revoke-${row.id}`}
                    disabled={revoking(row.id)}
                    {...(revoking(row.id) ? { 'aria-busy': true } : {})}
                    onClick={() => {
                      onRevoke(row.id);
                    }}
                  >
                    Take off the list
                  </Button>
                </RowActions>
              ) : null}
            </Row>
          ))}
        </Rows>
      )}

      <div data-testid="posture-form" className="mt-4 flex flex-col gap-3">
        <Field label="Add states" issues={issueFor('states')}>
          <div
            data-testid="posture-states"
            className="flex max-h-44 flex-wrap gap-x-4 gap-y-1 overflow-y-auto rounded-md border border-border p-2"
          >
            {section.stateOptions.map(option => (
              <label key={option.value} className="flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  data-testid={`posture-state-${option.value}`}
                  disabled={!section.editable || adding}
                  checked={selected.includes(option.value)}
                  onChange={event => {
                    setChosen(current =>
                      event.target.checked ? [...current, option.value] : current.filter(state => state !== option.value),
                    );
                  }}
                />
                {option.label}
              </label>
            ))}
          </div>
        </Field>

        {/* The rule quoted for each state chosen, verbatim, or a line saying the release
            has none. It is read before the box below is ticked, which is the whole point. */}
        {selected.length === 0 ? null : (
          <div data-testid="posture-rule" className="flex flex-col gap-2 text-xs">
            {selected.map(state => {
              const rule = section.rules[state] ?? null;
              if (rule === null) {
                return (
                  <p key={state} data-testid="posture-rule-none" className="text-muted-foreground">
                    {`${state}: this release quotes no rule. Add it only after you, or counsel, have checked it.`}
                  </p>
                );
              }
              return (
                <div key={state} className="flex flex-col gap-1">
                  <p data-testid="posture-rule-summary">{`${state}: ${rule.summary}`}</p>
                  {rule.citations.map(citation => (
                    <blockquote key={citation.url} className="border-l-2 border-border pl-2 text-muted-foreground">
                      <span className="block">{`${citation.title} — ${citation.url}`}</span>
                      {citation.quote}
                    </blockquote>
                  ))}
                </div>
              );
            })}
          </div>
        )}

        <div data-testid="posture-statements" className="flex flex-col gap-1 text-xs text-muted-foreground">
          {section.statements.map(statement => (
            <p key={statement.key} data-testid={`posture-statement-${statement.key}`}>
              {statement.text}
            </p>
          ))}
        </div>

        <Field label="Confirmation" issues={issueFor('confirmed')}>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              data-testid="posture-confirmed"
              className="mt-1"
              disabled={!section.editable || adding}
              checked={confirmed}
              onChange={event => {
                setConfirmed(event.target.checked);
              }}
            />
            <span>{POSTURE_CONFIRMATION}</span>
          </label>
        </Field>

        <Field label="Note (optional)" htmlFor="posture-note" issues={issueFor('note')}>
          <Textarea
            id="posture-note"
            data-testid="posture-note"
            rows={2}
            maxLength={1000}
            placeholder="Where you read it, or your registration number"
            disabled={!section.editable || adding}
            value={note}
            onChange={event => {
              setNote(event.target.value);
            }}
          />
        </Field>

        <div className="flex items-center gap-2">
          <Button
            data-testid="posture-record"
            disabled={!section.editable || adding}
            {...(adding ? { 'aria-busy': true } : {})}
            onClick={() => {
              setShown(true);
              if (issues.length > 0 || !confirmed) return;
              onAllow({ states: [...selected], confirmed: true, note });
            }}
          >
            Add these states
          </Button>
          <p className="text-xs text-muted-foreground">{POSTURE_HINT}</p>
        </div>
        <FormNotice forms={['postures', 'posture']} />
        {section.notEditableBecause === null ? null : (
          <p data-testid="posture-inert" className="text-xs text-muted-foreground">
            {section.notEditableBecause}
          </p>
        )}
      </div>
    </Section>
  );
}
