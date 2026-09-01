import { ChevronDown } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';

export type SelectOption<Value extends string> = {
  value: Value;
  label: string;
};

export type SelectProps<Value extends string> = {
  /** Accessible name for the combobox trigger. */
  label: string;
  options: readonly SelectOption<Value>[];
  value: Value;
  onChange(value: Value): void;
  disabled?: boolean;
};

/**
 * Dependency-free styled listbox replacing native <select>: a button trigger
 * showing the current value and a popover listbox with full keyboard support
 * (arrows/Home/End/Escape/Enter/typeahead) following the ARIA combobox
 * pattern.
 */
export function Select<Value extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
}: SelectProps<Value>) {
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const typeahead = useRef({ query: '', lastAt: 0 });

  const selectedIndex = useMemo(
    () => options.findIndex((option) => option.value === value),
    [options, value],
  );
  const selected = selectedIndex === -1 ? undefined : options[selectedIndex];

  const openListbox = useCallback(() => {
    setActiveIndex(selectedIndex === -1 ? 0 : selectedIndex);
    setOpen(true);
  }, [selectedIndex]);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) {
      triggerRef.current?.focus();
    }
  }, []);

  const commit = useCallback(
    (index: number) => {
      const option = options[index];
      if (option !== undefined) {
        onChange(option.value);
      }
      close(true);
    },
    [close, onChange, options],
  );

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (
        rootRef.current !== null &&
        event.target instanceof Node &&
        !rootRef.current.contains(event.target)
      ) {
        close(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, close]);

  const moveActive = (delta: number) => {
    setActiveIndex((current) => {
      const next = Math.min(Math.max(current + delta, 0), options.length - 1);
      return next;
    });
  };

  const applyTypeahead = (key: string) => {
    const now = Date.now();
    const state = typeahead.current;
    state.query = now - state.lastAt > 700 ? key : state.query + key;
    state.lastAt = now;
    const query = state.query.toLowerCase();
    const start = open ? activeIndex : Math.max(selectedIndex, 0);
    const ordered = [
      ...options.slice(start + (query.length === 1 ? 1 : 0)),
      ...options.slice(0, start + (query.length === 1 ? 1 : 0)),
    ];
    const match = ordered.find((option) =>
      option.label.toLowerCase().startsWith(query),
    );
    if (match !== undefined) {
      const index = options.indexOf(match);
      if (open) {
        setActiveIndex(index);
      } else {
        onChange(match.value);
      }
    }
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
      case 'Enter':
      case ' ':
        if (!open) {
          event.preventDefault();
          openListbox();
          return;
        }
        break;
      default:
        break;
    }

    if (!open) {
      if (event.key.length === 1 && /\S/.test(event.key)) {
        event.preventDefault();
        applyTypeahead(event.key);
      }
      return;
    }

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveActive(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveActive(-1);
        break;
      case 'Home':
        event.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        event.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        commit(activeIndex);
        break;
      case 'Escape':
        event.preventDefault();
        close(true);
        break;
      case 'Tab':
        close(false);
        break;
      default:
        if (event.key.length === 1 && /\S/.test(event.key)) {
          event.preventDefault();
          applyTypeahead(event.key);
        }
        break;
    }
  };

  return (
    <div className="select" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="select__trigger"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={
          open ? `${listboxId}-option-${activeIndex}` : undefined
        }
        disabled={disabled}
        onClick={() => (open ? close(true) : openListbox())}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="select__value">{selected?.label ?? ''}</span>
        <ChevronDown className="select__chevron" size={14} aria-hidden="true" />
      </button>
      {open && (
        <ul className="select__listbox" role="listbox" id={listboxId} aria-label={label}>
          {options.map((option, index) => (
            <li
              key={option.value}
              id={`${listboxId}-option-${index}`}
              role="option"
              className="select__option"
              aria-selected={option.value === value}
              data-active={index === activeIndex ? 'true' : undefined}
              onPointerMove={() => setActiveIndex(index)}
              onClick={() => commit(index)}
            >
              {option.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
