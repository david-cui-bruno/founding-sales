import { useModalDialog } from '../useModalDialog';
import { Search, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent, MouseEvent } from 'react';

import { navigationItems } from '../navigationItems';
import type { AppRoute } from '../routes';
import { useCommandPalette } from './useCommandPalette';
import './commandPalette.css';

export type CommandPaletteProps = {
  navigate(route: AppRoute): void;
};

type Command = {
  id: string;
  label: string;
  icon: LucideIcon;
  run(): void;
};

/**
 * Case-insensitive substring or in-order subsequence match, so "pipe" and
 * "gtp" both find "Go to Pipeline" without a fuzzy-matching dependency.
 */
const matchesQuery = (label: string, query: string): boolean => {
  const haystack = label.toLowerCase();
  const needle = query.trim().toLowerCase();
  if (needle.length === 0 || haystack.includes(needle)) return true;

  let position = 0;
  for (const character of needle) {
    position = haystack.indexOf(character, position);
    if (position === -1) return false;
    position += 1;
  }
  return true;
};

/**
 * Cmd+K command palette. Offers one "Go to" command per enabled navigation
 * destination, filtered as the founder types and fully drivable from the
 * keyboard. Theme and density stay in Settings; their state lives inside that
 * component, so the palette does not duplicate it.
 */
export function CommandPalette({ navigate }: CommandPaletteProps) {
  const palette = useCommandPalette(() => { modal.requestDismiss('command'); });
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const modal = useModalDialog({ open: palette.open, dialogRef, canDismiss: () => true, onDismiss: palette.closePalette, initialFocus: () => inputRef.current });
  const inputRef = useRef<HTMLInputElement>(null);

  const commands = useMemo<Command[]>(
    () => navigationItems
      .filter((item) => item.enabled)
      .map((item) => ({
        id: `go-${item.route}`,
        label: `Go to ${item.label}`,
        icon: item.icon,
        run: () => navigate(item.route),
      })),
    [navigate],
  );

  const visible = useMemo(
    () => commands.filter((command) => matchesQuery(command.label, query)),
    [commands, query],
  );

  useEffect(() => {
    if (palette.open) {
      setQuery('');
      setSelectedIndex(0);
      inputRef.current?.focus();
    }
  }, [palette.open]);

  if (!palette.open) return null;

  const runCommand = (command: Command) => {
    if (modal.requestDismiss('command')) command.run();
  };

  const onQueryChange = (event: ChangeEvent<HTMLInputElement>) => {
    setQuery(event.target.value);
    setSelectedIndex(0);
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (visible.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setSelectedIndex(
        (index) => (index + step + visible.length) % visible.length,
      );
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const command = visible[selectedIndex];
      if (command) runCommand(command);
    }
  };

  const onBackdropMouseDown = (event: MouseEvent<HTMLDialogElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const outside = event.clientX < bounds.left || event.clientX >= bounds.right ||
      event.clientY < bounds.top || event.clientY >= bounds.bottom;
    if (event.target === event.currentTarget && outside) {
      modal.requestDismiss('backdrop');
    }
  };

  return (
    <dialog
      ref={dialogRef}
      onCancel={modal.onCancel}
      onKeyDown={modal.onKeyDown}
      aria-label="Command palette"
      className="command-palette command-palette__backdrop"
      data-testid="command-palette-backdrop"
      onMouseDown={onBackdropMouseDown}
    >
        <div className="command-palette__input-row">
          <Search
            className="command-palette__search-icon"
            aria-hidden="true"
            size={16}
          />
          <input
            ref={inputRef}
            className="command-palette__input"
            type="text"
            role="combobox"
            aria-label="Command palette"
            aria-expanded="true"
            aria-controls="command-palette-listbox"
            aria-autocomplete="list"
            aria-activedescendant={
              visible[selectedIndex]
                ? `command-option-${visible[selectedIndex].id}`
                : undefined
            }
            placeholder="Type a command…"
            value={query}
            onChange={onQueryChange}
            onKeyDown={onInputKeyDown}
          />
        </div>
        {visible.length > 0 ? (
          <ul
            id="command-palette-listbox"
            className="command-palette__list"
            role="listbox"
            aria-label="Commands"
          >
            {visible.map((command, index) => {
              const Icon = command.icon;
              return (
                <li
                  key={command.id}
                  id={`command-option-${command.id}`}
                  className={
                    index === selectedIndex
                      ? 'command-palette__option command-palette__option--selected'
                      : 'command-palette__option'
                  }
                  role="option"
                  aria-selected={index === selectedIndex}
                  onMouseEnter={() => setSelectedIndex(index)}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    runCommand(command);
                  }}
                >
                  <Icon
                    className="command-palette__icon"
                    aria-hidden="true"
                    size={16}
                  />
                  <span>{command.label}</span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="command-palette__empty">No matching commands</p>
        )}
    </dialog>
  );
}
