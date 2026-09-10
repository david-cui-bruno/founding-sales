import { useOverlayLayers } from '../overlayLayers';
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
 * toggle. The shared modal lifecycle owns focus restoration. Keeping this in a hook leaves the component purely
 * presentational and lets tests drive it through real keyboard events.
 */
export function useCommandPalette(requestClose: () => void): CommandPaletteState {
  const [open, setOpen] = useState(false);
  const closeRequest = useRef(requestClose);
  closeRequest.current = requestClose;
  const layers = useOverlayLayers();
  const openPalette = useCallback(() => {
    if (!layers.hasModal()) setOpen(true);
  }, [layers]);
  const closePalette = useCallback(() => { setOpen(false); }, []);

  useEffect(() => {
    const requiresMeta = isMacPlatform();

    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = requiresMeta ? event.metaKey : event.ctrlKey;
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      if (!modifier || event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      if (open) {
        closeRequest.current();
      } else {
        openPalette();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, openPalette, closePalette]);

  return { open, openPalette, closePalette };
}
