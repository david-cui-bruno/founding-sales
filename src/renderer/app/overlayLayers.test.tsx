// @vitest-environment jsdom
import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PresentationRoot } from './PresentationRoot';
import { CommandPalette } from './commandPalette/CommandPalette';
import { LeadInspector } from '../features/leadInspector/LeadInspector';

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function(this: HTMLDialogElement) { this.open = true; });
  HTMLDialogElement.prototype.close = vi.fn(function(this: HTMLDialogElement) { this.open = false; });
});
afterEach(cleanup);
const props = { onRetry: vi.fn(), onOpenFullPage: vi.fn(), onBeginOutbound: vi.fn(), onConfirmTransition: vi.fn(), onDismissLead: vi.fn(), onOverrideCloudScore: vi.fn() };
describe('maintained overlay composition', () => {
  it('Escape closes only the native palette over a contact after callback changes in StrictMode', () => {
    const close = vi.fn();
    const currentClose = vi.fn();
    const tree = (onClose: () => void) => <StrictMode><PresentationRoot>
      <CommandPalette navigate={vi.fn()} openImport={vi.fn()} />
      <LeadInspector {...props} onClose={onClose} state={{ status: 'loading' }} />
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
  it('does not dismiss contact underneath a handled palette Escape', () => {
    const close = vi.fn();
    render(<PresentationRoot><CommandPalette navigate={vi.fn()} openImport={vi.fn()} /><LeadInspector {...props} onClose={close} state={{ status: 'loading' }} /></PresentationRoot>);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true, metaKey: true });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();
  });
});
