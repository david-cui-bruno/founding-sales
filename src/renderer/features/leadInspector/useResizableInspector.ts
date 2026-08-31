import { useCallback, useEffect, useRef, useState } from 'react';

export const INSPECTOR_WIDTH_KEY = 'callie.inspector.width';
export const INSPECTOR_MIN_WIDTH = 380;
export const INSPECTOR_MAX_WIDTH = 640;
const KEYBOARD_STEP = 20;
const DEFAULT_WIDTH = 420;

const clampWidth = (value: number): number =>
  Math.min(INSPECTOR_MAX_WIDTH, Math.max(INSPECTOR_MIN_WIDTH, Math.round(value)));

const readPersistedWidth = (): number => {
  const raw = window.localStorage.getItem(INSPECTOR_WIDTH_KEY);
  if (raw === null) {
    return DEFAULT_WIDTH;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? clampWidth(parsed) : DEFAULT_WIDTH;
};

export type ResizableInspector = {
  width: number;
  minWidth: number;
  maxWidth: number;
  /** Keyboard resize on the separator. Left widens the right-docked panel. */
  onSeparatorKeyDown(event: { key: string; preventDefault(): void }): void;
  /** Pointer drag resize from the separator. */
  onSeparatorPointerDown(event: {
    clientX: number;
    preventDefault(): void;
  }): void;
};

/**
 * Width state for the right-docked inspector: persisted in localStorage,
 * always clamped to 380-640 px, adjustable by pointer drag or arrow keys.
 */
export function useResizableInspector(): ResizableInspector {
  const [width, setWidth] = useState<number>(readPersistedWidth);
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);

  const applyWidth = useCallback((next: number) => {
    const clamped = clampWidth(next);
    window.localStorage.setItem(INSPECTOR_WIDTH_KEY, String(clamped));
    setWidth(clamped);
    return clamped;
  }, []);

  useEffect(() => {
    window.localStorage.setItem(INSPECTOR_WIDTH_KEY, String(width));
  }, [width]);

  const onSeparatorKeyDown = useCallback(
    (event: { key: string; preventDefault(): void }) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        setWidth((current) => {
          const next = clampWidth(current + KEYBOARD_STEP);
          window.localStorage.setItem(INSPECTOR_WIDTH_KEY, String(next));
          return next;
        });
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        setWidth((current) => {
          const next = clampWidth(current - KEYBOARD_STEP);
          window.localStorage.setItem(INSPECTOR_WIDTH_KEY, String(next));
          return next;
        });
      }
    },
    [],
  );

  const onSeparatorPointerDown = useCallback(
    (event: { clientX: number; preventDefault(): void }) => {
      event.preventDefault();
      const startX = event.clientX;
      let startWidth = 0;
      setWidth((current) => {
        startWidth = current;
        return current;
      });
      dragState.current = { startX, startWidth };

      const onPointerMove = (move: PointerEvent) => {
        const state = dragState.current;
        if (state === null) {
          return;
        }
        // Dragging left widens the panel because it is docked on the right.
        applyWidth(state.startWidth + (state.startX - move.clientX));
      };

      const onPointerUp = () => {
        dragState.current = null;
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
      };

      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
    },
    [applyWidth],
  );

  return {
    width,
    minWidth: INSPECTOR_MIN_WIDTH,
    maxWidth: INSPECTOR_MAX_WIDTH,
    onSeparatorKeyDown,
    onSeparatorPointerDown,
  };
}
