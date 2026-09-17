// @vitest-environment jsdom
import { StrictMode, useRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PresentationRoot } from './PresentationRoot';
import { CommandPalette } from './commandPalette/CommandPalette';
import { useDismissibleLayer } from './overlayLayers';

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function(this: HTMLDialogElement) { this.open = true; });
  HTMLDialogElement.prototype.close = vi.fn(function(this: HTMLDialogElement) { this.open = false; });
});
afterEach(cleanup);

/** A nonmodal detail layer underneath the palette, as the account detail pane composes it. */
function Detail({ onClose }: { onClose(): void }) {
  const elementRef = useRef<HTMLElement>(null);
  useDismissibleLayer({ open: true, elementRef, kind: 'nonmodal', canDismiss: () => true, onDismiss: onClose });
  return <aside ref={elementRef} aria-label="Account detail"><button type="button">Detail action</button></aside>;
}

describe('maintained overlay composition', () => {
  it('Escape closes only the native palette over a nonmodal detail after callback changes in StrictMode', () => {
    const close = vi.fn();
    const currentClose = vi.fn();
    const tree = (onClose: () => void) => <StrictMode><PresentationRoot>
      <CommandPalette navigate={vi.fn()} />
      <Detail onClose={onClose} />
    </PresentationRoot></StrictMode>;
    const view = render(tree(close));
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true, metaKey: true });
    view.rerender(tree(currentClose));
    const dialog = screen.getByRole('dialog');
    expect(dialog.tagName).toBe('DIALOG');
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(close).not.toHaveBeenCalled();
    expect(currentClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(currentClose).toHaveBeenCalledTimes(1);
    view.unmount();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(currentClose).toHaveBeenCalledTimes(1);
  });
  it('does not dismiss the detail underneath a handled palette Escape', () => {
    const close = vi.fn();
    render(<PresentationRoot><CommandPalette navigate={vi.fn()} /><Detail onClose={close} /></PresentationRoot>);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true, metaKey: true });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();
  });
});
