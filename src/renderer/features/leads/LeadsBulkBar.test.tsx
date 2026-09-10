import { useRef } from 'react';
import { useDismissibleLayer } from '../../app/overlayLayers';
import { PresentationRoot } from '../../app/PresentationRoot';
// @vitest-environment jsdom

import { cleanup, fireEvent, render as testingRender, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LeadsBulkBar } from './LeadsBulkBar';

afterEach(() => {
  cleanup();
});

describe('LeadsBulkBar', () => {
  it('announces the selection count and offers the bulk field op plus Clear', () => {
    render(
      <LeadsBulkBar
        count={3}
        onSetOrganization={vi.fn()}
        onClear={vi.fn()}
      />,
    );

    const bar = screen.getByRole('toolbar', { name: 'Bulk actions' });
    expect(bar.textContent).toContain('3 selected');
    expect(screen.getByRole('button', { name: 'Set organization' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy();
  });

  it('commits a bulk organization value with Enter', () => {
    const onSetOrganization = vi.fn();
    render(
      <LeadsBulkBar
        count={2}
        onSetOrganization={onSetOrganization}
        onClear={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Set organization' }));
    const input = screen.getByRole('textbox', {
      name: 'Organization for 2 selected',
    });
    fireEvent.change(input, { target: { value: 'Shared Holdings' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSetOrganization).toHaveBeenCalledWith('Shared Holdings');
  });

  it('clears the selection when Escape is pressed anywhere', () => {
    const onClear = vi.fn();
    render(
      <LeadsBulkBar count={1} onSetOrganization={vi.fn()} onClear={onClear} />,
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('lets Escape close the inline editor without clearing the selection', () => {
    const onClear = vi.fn();
    render(
      <LeadsBulkBar count={1} onSetOrganization={vi.fn()} onClear={onClear} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Set organization' }));
    const input = screen.getByRole('textbox', {
      name: 'Organization for 1 selected',
    });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClear).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('textbox', { name: 'Organization for 1 selected' }),
    ).toBeNull();
  });

  it('clears through the Clear button', () => {
    const onClear = vi.fn();
    render(
      <LeadsBulkBar count={4} onSetOrganization={vi.fn()} onClear={onClear} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});

const render = (ui: Parameters<typeof testingRender>[0], options?: Parameters<typeof testingRender>[1]) => testingRender(ui, { wrapper: PresentationRoot, ...options });

Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false; } });

it('ignores repeated, composing and already handled Escape without clearing selection', () => {
  const onClear = vi.fn();
  render(<LeadsBulkBar count={1} onSetOrganization={vi.fn()} onClear={onClear} />);
  fireEvent.keyDown(document, { key: 'Escape', repeat: true });
  fireEvent.keyDown(document, { key: 'Escape', isComposing: true });
  const handled = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  handled.preventDefault(); document.dispatchEvent(handled);
  expect(onClear).not.toHaveBeenCalled();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClear).toHaveBeenCalledTimes(1);
});

function ContactLayer() {
  const elementRef = useRef<HTMLElement>(null);
  useDismissibleLayer({ open: true, kind: 'nonmodal', elementRef, canDismiss: () => false, onDismiss: () => {} });
  return <aside ref={elementRef}>Pending contact layer</aside>;
}
it('preserves bulk selection and an inline draft while a contact layer owns Escape', () => {
  const onClear = vi.fn();
  const view = render(<LeadsBulkBar count={1} onSetOrganization={vi.fn()} onClear={onClear} />);
  fireEvent.click(screen.getByRole('button', { name: 'Set organization' }));
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'Retained organization' } });
  view.rerender(<><LeadsBulkBar count={1} onSetOrganization={vi.fn()} onClear={onClear} /><ContactLayer /></>);
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(screen.getByRole('textbox')).toBe(input);
  expect((input as HTMLInputElement).value).toBe('Retained organization');
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClear).not.toHaveBeenCalled();
});
