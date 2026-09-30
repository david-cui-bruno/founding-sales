import { useState, type JSX } from 'react';
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
  const [text, setText] = useState(initial === null ? '' : String(initial.monthlyCents / 100));
  const [kind, setKind] = useState<'estimated' | 'agreed'>(initial?.kind ?? 'estimated');
  const [touched, setTouched] = useState(false);
  const parsed = parseMonthlyDollars(text);
  const problem = touched && !parsed.ok ? VALUE_PROBLEMS[parsed.problem] : null;

  return (
    <div role="dialog" aria-label={`Set value for ${firmName}`} data-testid="value-dialog" className="mt-2 flex flex-col gap-2 rounded-md border border-border bg-background p-2 text-xs shadow-sm">
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
      <div className="flex justify-end gap-1">
        <Button size="sm" variant="quiet" data-testid="value-cancel" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          data-testid="value-save"
          disabled={!parsed.ok || busy}
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
