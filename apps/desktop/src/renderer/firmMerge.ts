import { button, element } from './firmDom.ts';
import type { MergeResolution, MergeView } from './firmWorkspaceContract.ts';
import { mergeSubmittable } from './firmWorkspaceView.ts';

/**
 * Resolving a merge (specification 7.2, Appendix G 37).
 *
 * "conflicts are shown for resolution... Research may suggest duplicates but never
 * performs a destructive merge automatically." `mergeFirms` refuses with
 * `merge_conflicts` and the list of fields the two records disagree about; this is
 * the screen that list becomes.
 *
 * Two rules, both of them about what the screen refuses to let a person do.
 *
 * **Only the two recorded values are offered.** A free-text box for the "correct"
 * name would let somebody resolve a merge by inventing a third value that neither
 * record ever held, which is a canonical value with no provenance at all. If the
 * right answer is a third thing, it is an `updateFirm` before or after the merge,
 * and it is audited as what it is.
 *
 * **Nothing is preselected.** The API returns source and target in a fixed order
 * and a default would be resolved by whichever way round the person happened to
 * start the merge. Every field is an explicit choice, and the button stays disabled
 * until every one of them has been made.
 */

export interface FirmMergeOptions {
  readonly merge: MergeView;
  readonly actionsEnabled: boolean;
  readonly onResolve: (resolution: MergeResolution) => void;
}

export function renderFirmMerge(root: HTMLElement, options: FirmMergeOptions): void {
  const panel = element('section', { className: 'merge', testId: 'merge-panel' });
  const summary = element('p', { testId: 'merge-summary' });
  summary.append(element('span', { testId: 'merge-source', text: options.merge.sourceName }));
  summary.append(element('span', { text: ' will be merged into ' }));
  summary.append(element('span', { testId: 'merge-target', text: options.merge.targetName }));
  panel.append(summary);

  const chosen: Record<string, string> = {};
  const submit = button('Merge these records', 'merge-submit', false);
  const refresh = (): void => {
    submit.disabled = !mergeSubmittable(options.merge, chosen, options.actionsEnabled);
  };

  if (options.merge.conflicts.length === 0) {
    panel.append(element('p', { testId: 'merge-no-conflicts', text: 'Nothing conflicts. This merge is ready.' }));
  }

  const list = element('ul', { testId: 'merge-conflicts' });
  const group = `merge-${options.merge.sourceFirmId}`;
  for (const conflict of options.merge.conflicts) {
    const item = element('li', { testId: 'merge-conflict' });
    item.dataset['field'] = conflict.field;
    item.append(element('span', { className: 'merge-field', testId: 'merge-field', text: conflict.field }));

    for (const [side, value] of [
      ['source', conflict.source],
      ['target', conflict.target],
    ] as const) {
      if (value === null) {
        // One side has nothing. It is shown, so the person can see that the choice
        // is "keep this value" rather than "choose between two", and it is not
        // offered: a merge cannot resolve a field to absent.
        item.append(element('span', { testId: `merge-${side}-empty`, text: `${side}: —` }));
        continue;
      }
      const label = element('label', { testId: `merge-choice-${side}` });
      const radio = element('input');
      radio.type = 'radio';
      radio.name = `${group}-${conflict.field}`;
      radio.value = value;
      radio.disabled = !options.actionsEnabled;
      radio.addEventListener('change', () => {
        chosen[conflict.field] = value;
        refresh();
      });
      label.append(radio, element('span', { testId: `merge-value-${side}`, text: value }));
      item.append(label);
    }
    list.append(item);
  }
  panel.append(list);

  submit.addEventListener('click', () => {
    options.onResolve({
      sourceFirmId: options.merge.sourceFirmId,
      targetFirmId: options.merge.targetFirmId,
      resolutions: { ...chosen },
    });
  });
  refresh();
  panel.append(submit);
  root.append(panel);
}
