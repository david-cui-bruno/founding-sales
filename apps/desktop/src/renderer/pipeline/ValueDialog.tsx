import { useState, type JSX } from 'react';
import { useBaseGuard, useKeptText } from '../firms/crmMemory.ts';
import { Button } from '../ui/button.tsx';
import { Input } from '../ui/input.tsx';
import { Select } from '../ui/select.tsx';
import { parseMonthlyDollars, VALUE_PROBLEMS } from './cardText.ts';
import type { ValueChange } from '../firmWorkspaceContract.ts';

/**
 * "Set value…": an amount per month and whether it is an estimate or agreed (slice K).
 *
 * The amount is checked here only so a command that cannot succeed is not sent; the API's
 * bounds are the authority. Nothing is sent until the person presses Save.
 */
export function ValueDialog({
  opportunityId,
  firmName,
  initial,
  busy,
  onSave,
  onCancel,
}: {
  readonly opportunityId: string;
  readonly firmName: string;
  readonly initial: { readonly monthlyCents: number; readonly kind: 'estimated' | 'agreed' } | null;
  readonly busy: boolean;
  onSave(change: ValueChange): void;
  onCancel(): void;
}): JSX.Element {
  // Kept above the card, so closing the dialog (a second click, Escape) or leaving the
  // Pipeline never discards what was typed (criteria 2 and 7). The value the edit started
  // from is kept with it: if the server's value moves meanwhile the draft is dropped (K2).
  const serverText = initial === null ? '' : String(initial.monthlyCents / 100);
  const serverKind = initial?.kind ?? 'estimated';
  const guard = useBaseGuard(`value:${opportunityId}`, `${serverText}|${serverKind}`);
  const [text, setTextKept] = useKeptText(`value:${opportunityId}:text`, serverText);
  const [kindText, setKindText] = useKeptText(`value:${opportunityId}:kind`, serverKind);
  const kind: 'estimated' | 'agreed' = kindText === 'agreed' ? 'agreed' : 'estimated';
  const setText = (next: string): void => {
    guard.begin();
    setTextKept(next);
  };
  const setKind = (next: 'estimated' | 'agreed'): void => {
    guard.begin();
    setKindText(next);
  };
  const [touched, setTouched] = useState(false);
  const parsed = parseMonthlyDollars(text);
  // Nothing to send while neither field differs from what the server has (K2).
  const changed = text !== serverText || kind !== serverKind;
  const problem = touched && !parsed.ok ? VALUE_PROBLEMS[parsed.problem] : null;

  return (
    <div role="dialog" aria-label={`Set value for ${firmName}`} data-testid="value-dialog" className="mt-1 flex flex-col gap-2 border-t border-border pt-2 text-xs">
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">Amount per month ($)</span>
        <Input
          data-testid="value-amount"
          inputMode="decimal"
          autoComplete="off"
          value={text}
          aria-invalid={problem !== null}
          onChange={event => {
            setText(event.target.value);
            setTouched(true);
          }}
          className="h-7 text-xs"
        />
      </label>
      {problem === null ? null : (
        <p data-testid="value-problem" role="alert" className="text-destructive">
          {problem}
        </p>
      )}
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">Kind</span>
        <Select
          data-testid="value-kind"
          value={kind}
          onChange={event => {
            setKind(event.target.value === 'agreed' ? 'agreed' : 'estimated');
          }}
          className="h-7 text-xs"
        >
          <option value="estimated">Estimated</option>
          <option value="agreed">Agreed</option>
        </Select>
      </label>
      {guard.changedElsewhere ? (
        <p data-testid="value-changed-elsewhere" role="status" className="text-muted-foreground">
          Changed elsewhere. Your earlier edit was dropped; this is the current value.
        </p>
      ) : null}
      <div className="flex justify-end gap-1">
        <Button size="sm" variant="quiet" data-testid="value-cancel" onClick={onCancel}>
          Close
        </Button>
        <Button
          size="sm"
          data-testid="value-save"
          disabled={!parsed.ok || busy || !changed}
          onClick={() => {
            setTouched(true);
            if (parsed.ok) onSave({ opportunityId, monthlyCents: parsed.monthlyCents, kind });
          }}
        >
          Save
        </Button>
      </div>
    </div>
  );
}
