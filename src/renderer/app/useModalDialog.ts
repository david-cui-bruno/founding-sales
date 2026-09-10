import { useLayoutEffect, useRef, type KeyboardEvent, type RefObject, type SyntheticEvent } from 'react';
import { useDismissibleLayer, type DismissReason } from './overlayLayers';

type ModalDialogOptions = {
  open: boolean;
  dialogRef: RefObject<HTMLDialogElement | null>;
  canDismiss(): boolean;
  onDismiss(reason: DismissReason): void;
  initialFocus?: () => HTMLElement | null;
  returnFocus?: () => HTMLElement | null;
};
/** Recompute on each Tab, since feature-owned busy state can remove tab stops. */
function tabStops(dialog: HTMLDialogElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(
    'button, input, textarea, select, a[href], area[href], summary, iframe, object, embed, [tabindex], [contenteditable]',
  )).filter((element) => {
    if (element.tabIndex < 0 || element.matches(':disabled, input[type="hidden"]') ||
      element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      if (node === dialog) break;
    }
    // Native layout also excludes closed details and other non-rendered controls.
    if (typeof element.checkVisibility === 'function' && !element.checkVisibility()) return false;
    return true;
  }).sort((a, b) => (a.tabIndex > 0 ? a.tabIndex : Infinity) - (b.tabIndex > 0 ? b.tabIndex : Infinity));
}
/** Native modality and current feature policy, without owning feature state. */
export function useModalDialog(options: ModalDialogOptions) {
  const { open, dialogRef } = options;
  const latest = useRef(options);
  latest.current = options;
  const layer = useDismissibleLayer({ ...options, kind: 'modal', elementRef: dialogRef });
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    const originalTabIndex = dialog.getAttribute('tabindex');
    if (originalTabIndex === null) dialog.tabIndex = -1;
    dialog.showModal();
    latest.current.initialFocus?.()?.focus();
    return () => {
      dialog.close();
      if (originalTabIndex === null) dialog.removeAttribute('tabindex');
    };
  }, [open, dialogRef]);
  const onCancel = (event: SyntheticEvent<HTMLDialogElement>) => {
    event.preventDefault();
    event.stopPropagation();
    layer.requestDismiss('cancel');
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key === 'Tab') {
      const dialog = dialogRef.current;
      if (event.defaultPrevented || !dialog || !layer.isTopmost()) return;
      const stops = tabStops(dialog);
      const active = document.activeElement;
      const first = stops[0];
      const last = stops.at(-1);
      const outsideStops = !stops.some((element) => element === active);
      if (!first || outsideStops || (event.shiftKey ? active === first : active === last)) {
        event.preventDefault();
        event.stopPropagation();
        (event.shiftKey ? last ?? dialog : first ?? dialog).focus();
      }
      return;
    }
    if (event.key !== 'Escape') return;
    const handled = event.defaultPrevented;
    event.preventDefault();
    event.stopPropagation();
    if (!handled && !event.nativeEvent.isComposing && !event.repeat) layer.requestDismiss('escape');
  };
  return { onCancel, onKeyDown, requestDismiss: layer.requestDismiss };
}
