import { useState, type JSX } from 'react';
import { inWords } from '../dates.ts';
import type { MergeResolution, MergeView } from '../firmWorkspaceContract.ts';
import { mergeSubmittable } from '../firmWorkspaceView.ts';
import { Button } from '../ui/button.tsx';
import { Row, RowMain, Rows, Section } from '../ui/layout.tsx';

/**
 * Resolving a merge (specification 7.2, Appendix G 37).
 *
 * "conflicts are shown for resolution... Research may suggest duplicates but never
 * performs a destructive merge automatically." `mergeFirms` refuses with
 * `merge_conflicts` and the list of fields the two records disagree about; this is the
 * screen that list becomes.
 *
 * Two rules, both of them about what the screen refuses to let a person do.
 *
 * **Only the two recorded values are offered.** A free-text box for the "correct" name
 * would let somebody resolve a merge by inventing a third value that neither record ever
 * held, which is a canonical value with no provenance at all. If the right answer is a
 * third thing, it is an edit before or after the merge, and it is audited as what it is.
 *
 * **Nothing is preselected.** The API returns source and target in a fixed order and a
 * default would be resolved by whichever way round the person happened to start the
 * merge. Every field is an explicit choice, and the button stays disabled until every one
 * of them has been made.
 */

export function FirmMerge({
  merge,
  actionsEnabled,
  onResolve,
}: {
  readonly merge: MergeView;
  readonly actionsEnabled: boolean;
  onResolve(resolution: MergeResolution): void;
}): JSX.Element {
  const [chosen, setChosen] = useState<Readonly<Record<string, string>>>({});
  const group = `merge-${merge.sourceFirmId}`;
  return (
    <div data-testid="merge-panel" className="mt-5">
      <p data-testid="merge-summary" className="text-sm">
        <span data-testid="merge-source">{merge.sourceName}</span>
        <span>{' will be merged into '}</span>
        <span data-testid="merge-target">{merge.targetName}</span>
      </p>

      {merge.conflicts.length === 0 ? (
        <p data-testid="merge-no-conflicts" className="mt-3 text-sm text-muted-foreground">
          Nothing conflicts. This merge is ready.
        </p>
      ) : (
        <Section title="What they disagree about" count={merge.conflicts.length}>
          <Rows data-testid="merge-conflicts">
            {merge.conflicts.map(conflict => (
              <Row key={conflict.field} data-testid="merge-conflict" data-field={conflict.field} className="items-start py-2">
                <RowMain
                  line={<span data-testid="merge-field">{inWords(conflict.field)}</span>}
                  detail={
                    <span className="mt-1 flex flex-col gap-1">
                      {(['source', 'target'] as const).map(side =>
                        conflict[side] === null ? (
                          // One side has nothing. It is shown, so the person can see that
                          // the choice is "keep this value" rather than "choose between
                          // two", and it is not offered: a merge cannot resolve to absent.
                          <span key={side} data-testid={`merge-${side}-empty`} className="text-muted-foreground">
                            {`${side}: —`}
                          </span>
                        ) : (
                          <label key={side} data-testid={`merge-choice-${side}`} className="flex items-center gap-1.5">
                            <input
                              type="radio"
                              name={`${group}-${conflict.field}`}
                              value={conflict[side]}
                              disabled={!actionsEnabled}
                              checked={chosen[conflict.field] === conflict[side]}
                              onChange={() => {
                                const value = conflict[side];
                                if (value === null) return;
                                setChosen(current => ({ ...current, [conflict.field]: value }));
                              }}
                            />
                            <span data-testid={`merge-value-${side}`} className="text-foreground">
                              {conflict[side]}
                            </span>
                          </label>
                        ),
                      )}
                    </span>
                  }
                />
              </Row>
            ))}
          </Rows>
        </Section>
      )}

      <div className="mt-5">
        <Button
          data-testid="merge-submit"
          disabled={!mergeSubmittable(merge, chosen, actionsEnabled)}
          onClick={() => {
            onResolve({ sourceFirmId: merge.sourceFirmId, targetFirmId: merge.targetFirmId, resolutions: { ...chosen } });
          }}
        >
          Merge these records
        </Button>
      </div>
    </div>
  );
}
