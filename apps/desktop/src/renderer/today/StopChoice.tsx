import type { JSX } from 'react';
import { DO_NOT_CALL_CHOICES, DO_NOT_CALL_CHOICE_KEYS, type DoNotCallChoiceKey } from '../outcomeForm.ts';
import { Select } from '../ui/select.tsx';

/**
 * The four-way "what did they ask Callie to stop?" for a "Do not call" (migration 0037,
 * David's P1): calls to this person (the default), all contact with this person, calls to
 * anyone at this firm, all contact with this firm. One control, used by the outcome form and
 * by the after-call suggestions, so the two never offer different stops.
 */
export function StopChoice({
  value,
  disabled,
  testId,
  onChange,
}: {
  readonly value: DoNotCallChoiceKey;
  readonly disabled: boolean;
  readonly testId: string;
  onChange(next: DoNotCallChoiceKey): void;
}): JSX.Element {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-muted-foreground">What did they ask Callie to stop?</span>
      <Select
        data-testid={testId}
        disabled={disabled}
        value={value}
        onChange={event => {
          onChange(event.target.value as DoNotCallChoiceKey);
        }}
      >
        {DO_NOT_CALL_CHOICE_KEYS.map(key => (
          <option key={key} value={key}>
            {DO_NOT_CALL_CHOICES[key].label}
          </option>
        ))}
      </Select>
    </label>
  );
}
