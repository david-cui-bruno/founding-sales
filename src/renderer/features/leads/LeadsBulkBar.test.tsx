import { useRef, useState } from 'react';
import { useDismissibleLayer } from '../../app/overlayLayers';
import { PresentationRoot } from '../../app/PresentationRoot';
// @vitest-environment jsdom

import { cleanup, fireEvent, render as testingRender, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LeadsBulkBar as BulkBar, type LeadsBulkBarProps } from './LeadsBulkBar';
import type { BulkEdit } from './useLeadMutations';
function LeadsBulkBar(props: Pick<LeadsBulkBarProps, 'count' | 'onSetOrganization' | 'onClear'>) {
  const [editor, setEditor] = useState<BulkEdit | null>(null);
  return <BulkBar {...props} editor={editor} pending={false} onStart={() => setEditor({ draft: '', status: 'editing', error: null })} onChange={draft => setEditor(current => current && ({ ...current, draft }))} onCancel={() => setEditor(null)} onSetOrganization={async value => { await props.onSetOrganization(value); setEditor(null); return { status: 'saved' }; }} />;
}

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

it('keeps safe bulk error in a dedicated full-width row outside its action group',()=>{
  render(<BulkBar count={200} outsideCount={199} editor={{draft:'Kept organization',status:'failed',error:'The change could not be confirmed. Your input is kept. Review the records before retrying.'}} pending={false} onStart={vi.fn()} onChange={vi.fn()} onCancel={vi.fn()} onSetOrganization={vi.fn()} onClear={vi.fn()}/>);
  const error=screen.getByRole('alert');expect(error.classList.contains('leads-bulk-bar__error')).toBe(true);
  expect(error.closest('.leads-bulk-bar__actions')).toBeNull();expect(screen.getByText('200 selected · 199 outside view')).toBeTruthy();
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Kept organization');expect(screen.getByRole('button',{name:'Save organization'}).closest('.leads-bulk-bar__actions')).not.toBeNull();
});
