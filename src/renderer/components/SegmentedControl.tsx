import { useRef, type KeyboardEvent } from 'react';

export type SegmentedControlOption<Value extends string> = {
  value: Value;
  label: string;
};

export type SegmentedControlProps<Value extends string> = {
  /** Accessible name for the radiogroup. */
  label: string;
  options: readonly SegmentedControlOption<Value>[];
  value: Value;
  onChange(value: Value): void;
};

/**
 * Radiogroup segmented control: the selected option gets the accent-soft
 * fill and accent text; arrow keys move and select per the radio pattern.
 */
export function SegmentedControl<Value extends string>({
  label,
  options,
  value,
  onChange,
}: SegmentedControlProps<Value>) {
  const rootRef = useRef<HTMLDivElement>(null);

  const moveSelection = (delta: number) => {
    const index = options.findIndex((option) => option.value === value);
    const next =
      options[(index + delta + options.length) % options.length];
    if (next !== undefined) {
      onChange(next.value);
      const buttons =
        rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
      buttons?.[(index + delta + options.length) % options.length]?.focus();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        moveSelection(1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        moveSelection(-1);
        break;
      default:
        break;
    }
  };

  return (
    <div
      ref={rootRef}
      className="segmented-control"
      role="radiogroup"
      aria-label={label}
    >
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            className="segmented-control__option"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={onKeyDown}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
