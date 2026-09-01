import { useCallback, useEffect, useRef, useState } from 'react';

export type CommandPaletteState = {
  open: boolean;
  openPalette(): void;
  closePalette(): void;
};

const isMacPlatform = (): boolean =>
  typeof navigator !== 'undefined' &&
  /mac|darwin/i.test(navigator.platform || navigator.userAgent || '');

/**
 * Owns the palette's open state: a window-level Cmd+K (Ctrl+K off macOS)
 * toggle, plus focus restoration to whatever element had focus before the
 * palette opened. Keeping this in a hook leaves the component purely
 * presentational and lets tests drive it through real keyboard events.
 */
export function useCommandPalette(): CommandPaletteState {
  const [open, setOpen] = useState(false);
  const restoreFocusTo = useRef<HTMLElement | null>(null);

  const openPalette = useCallback(() => {
    restoreFocusTo.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setOpen(true);
  }, []);

  const closePalette = useCallback(() => {
    setOpen(false);
    const previous = restoreFocusTo.current;
    restoreFocusTo.current = null;
    previous?.focus();
  }, []);

  useEffect(() => {
    const requiresMeta = isMacPlatform();

    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = requiresMeta ? event.metaKey : event.ctrlKey;
      if (!modifier || event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      if (open) {
        closePalette();
      } else {
        openPalette();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, openPalette, closePalette]);

  return { open, openPalette, closePalette };
}
