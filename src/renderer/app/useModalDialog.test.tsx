// @vitest-environment jsdom
import { StrictMode, useRef, useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PresentationRoot } from './PresentationRoot';
import { useModalDialog } from './useModalDialog';
import { useDismissibleLayer } from './overlayLayers';
import { CommandPalette } from './commandPalette/CommandPalette';
import { ImportDialog } from '../features/import/ImportDialog';
import { Select } from '../components/Select';

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function(this: HTMLDialogElement) { this.open = true; });
  HTMLDialogElement.prototype.close = vi.fn(function(this: HTMLDialogElement) { this.open = false; });
});
afterEach(cleanup);
function Modal({ open = true, blocked = false, close, name = 'Feature', returnFocus }: { open?: boolean; blocked?: boolean; close(): void; name?: string; returnFocus?: () => HTMLElement | null }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const modal = useModalDialog({ open, dialogRef, canDismiss: () => !blocked, onDismiss: close, returnFocus, initialFocus: () => dialogRef.current?.querySelector('button') ?? null });
  if (!open) return null;
  return <dialog ref={dialogRef} aria-label={name} onCancel={modal.onCancel} onKeyDown={modal.onKeyDown}>
    <button onClick={() => modal.requestDismiss('close-button')}>Close {name}</button>
    <Select label="Choice" value="one" onChange={() => undefined} options={[{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }]} />
  </dialog>;
}
function Contact({ close, returnFocus, distinct = false }: { close(): void; returnFocus?: () => HTMLElement | null; distinct?: boolean }) {
  const elementRef = useRef<HTMLElement>(null);
  useDismissibleLayer({ open: true, elementRef, kind: 'nonmodal', canDismiss: () => true, onDismiss: close, returnFocus });
  return <aside ref={elementRef}>{distinct && <button>Contact fallback</button>}<button>Contact action</button></aside>;
}
const flushFocus = async () => { await act(async () => { await Promise.resolve(); }); };
describe('useModalDialog', () => {
  it('blocked top consumes Escape, native cancel and Close without falling through, using latest policy without reopening', () => {
    const oldClose = vi.fn(); const close = vi.fn(); const contactClose = vi.fn();
    const tree = (blocked: boolean, callback: () => void) => <PresentationRoot><Modal blocked={blocked} close={callback} /><Contact close={contactClose} /></PresentationRoot>;
    const view = render(tree(true, oldClose));
    const dialog = screen.getByRole('dialog');
    expect(fireEvent.keyDown(dialog, { key: 'Escape' })).toBe(false);
    expect(fireEvent.keyDown(document, { key: 'Escape' })).toBe(false);
    expect(fireEvent(dialog, new Event('cancel', { cancelable: true }))).toBe(false);
    fireEvent.click(screen.getByText('Close Feature'));
    expect(oldClose).not.toHaveBeenCalled(); expect(contactClose).not.toHaveBeenCalled();
    view.rerender(tree(false, close));
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(close).toHaveBeenCalledTimes(1); expect(oldClose).not.toHaveBeenCalled(); expect(contactClose).not.toHaveBeenCalled();
  });
  it('keeps modal opening order across rerenders and refuses non-top native cancel', () => {
    const first = vi.fn(); const second = vi.fn(); const updated = vi.fn();
    const tree = (callback: () => void) => <PresentationRoot><Modal close={callback} name="First" /><Modal close={second} name="Second" /></PresentationRoot>;
    const view = render(tree(first)); view.rerender(tree(updated));
    fireEvent(screen.getByRole('dialog', { name: 'First' }), new Event('cancel', { cancelable: true }));
    expect(updated).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(second).toHaveBeenCalledTimes(1); expect(first).not.toHaveBeenCalled();
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledTimes(2);
  });
  it('lets nested Select consume Escape before the dialog and ignores repeat/composition', () => {
    const close = vi.fn(); render(<PresentationRoot><Modal close={close} /></PresentationRoot>);
    const choice = screen.getByRole('combobox');
    fireEvent.click(choice);
    fireEvent.keyDown(choice, { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.keyDown(choice, { key: 'Escape', repeat: true });
    fireEvent.keyDown(choice, { key: 'Escape', isComposing: true });
    expect(close).not.toHaveBeenCalled();
    fireEvent.keyDown(choice, { key: 'Escape' });
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('balances native lifecycle in StrictMode and never reopens for callback changes', async () => {
    const close = vi.fn(); const view = render(<StrictMode><PresentationRoot><Modal close={close} /></PresentationRoot></StrictMode>);
    await flushFocus();
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledTimes(2);
    view.rerender(<StrictMode><PresentationRoot><Modal close={vi.fn()} /></PresentationRoot></StrictMode>);
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledTimes(2);
    view.unmount(); await flushFocus();
    expect(HTMLDialogElement.prototype.close).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(document, { key: 'Escape' }); expect(close).not.toHaveBeenCalled();
  });
  it('does not open palette over a feature modal', () => {
    render(<PresentationRoot><CommandPalette navigate={vi.fn()} openImport={vi.fn()} /><Modal close={vi.fn()} /></PresentationRoot>);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true, metaKey: true });
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });
  it('does not toggle an existing palette behind a newer feature modal', () => {
    const tree = (open: boolean) => <PresentationRoot><CommandPalette navigate={vi.fn()} openImport={vi.fn()} /><Modal open={open} close={vi.fn()} /></PresentationRoot>;
    const view = render(tree(false));
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true, metaKey: true });
    view.rerender(tree(true));
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true, metaKey: true });
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Feature' })).toBeTruthy();
  });
  it('does not steal focus from a palette replacement modal', async () => {
    function Workspace() {
      const [open, setOpen] = useState(false);
      return <PresentationRoot><button>Opener</button><CommandPalette navigate={vi.fn()} openImport={() => setOpen(true)} /><Modal open={open} close={() => setOpen(false)} /></PresentationRoot>;
    }
    render(<Workspace />); screen.getByText('Opener').focus();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true, metaKey: true });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Import' } });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    await flushFocus();
    const feature = screen.getByRole('dialog', { name: 'Feature' });
    expect(feature.contains(document.activeElement)).toBe(true);
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull();
  });
  it('restores a visible parent control before navigation when opener disappears', async () => {
    const tree = (open: boolean) => <PresentationRoot><Contact close={vi.fn()} /><Modal open={open} close={vi.fn()} /><nav aria-label="Primary"><a href="#today" aria-current="page">Today</a></nav></PresentationRoot>;
    const view = render(tree(true)); view.rerender(tree(false)); await flushFocus();
    expect(document.activeElement).toBe(screen.getByText('Contact action'));
  });
  it('uses More rather than a hidden current secondary link, then main if no safe navigation remains', async () => {
    const tree = (open: boolean, more: boolean) => <PresentationRoot><nav aria-label="Primary"><div hidden><a href="#leads" aria-current="page">Leads</a></div>{more && <button aria-expanded="false">More</button>}</nav><main id="main-content" tabIndex={-1} /><Modal open={open} close={vi.fn()} /></PresentationRoot>;
    const view = render(tree(true, true)); view.rerender(tree(false, true)); await flushFocus();
    expect(document.activeElement).toBe(screen.getByText('More'));
    view.rerender(tree(true, false)); view.rerender(tree(false, false)); await flushFocus();
    expect(document.activeElement).toBe(screen.getByRole('main'));
  });
  it('restores the exact opener inside a surviving parent modal, not its underlying opener', async () => {
    const tree = (child: boolean) => <PresentationRoot><button>Workspace opener</button><Modal close={vi.fn()} name="Parent" /><Modal open={child} close={vi.fn()} name="Child" /></PresentationRoot>;
    const view = render(tree(false));
    const opener = screen.getByRole('combobox'); opener.focus();
    view.rerender(tree(true)); view.rerender(tree(false)); await flushFocus();
    expect(document.activeElement).toBe(opener);
  });
  it('resolves the current focus-origin getter without registering a new nonmodal lifetime', async () => {
    const tree = (open: boolean, id: string) => <PresentationRoot><button id="first">First</button><button id="second">Second</button>{open && <Contact close={vi.fn()} returnFocus={() => document.getElementById(id)} />}</PresentationRoot>;
    const view = render(tree(true, 'first')); view.rerender(tree(true, 'second'));
    screen.getByText('Contact action').focus(); view.rerender(tree(false, 'second')); await flushFocus();
    expect(document.activeElement).toBe(screen.getByText('Second'));
  });
  it('hands the actual palette to actual Import without focus theft and preserves the contact underneath', async () => {
    const api = { preview: vi.fn(), remap: vi.fn(), commit: vi.fn(), status: vi.fn() };
    function Workspace() {
      const [open, setOpen] = useState(false);
      return <PresentationRoot><Contact distinct close={vi.fn()} /><CommandPalette navigate={vi.fn()} openImport={() => setOpen(true)} /><ImportDialog api={api} open={open} onClose={() => setOpen(false)} onCommitted={vi.fn()} /></PresentationRoot>;
    }
    render(<Workspace />); screen.getByText('Contact action').focus();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true, metaKey: true });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Import' } });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' }); await flushFocus();
    const dialog = screen.getByRole('dialog', { name: 'Import leads' });
    expect(dialog.tagName).toBe('DIALOG'); expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(dialog, { key: 'Escape' }); await flushFocus();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByText('Contact action'));
    expect(api.commit).not.toHaveBeenCalled();
  });
  it('does not retain a replacement origin after the no-replacement microtask', async () => {
    const tree = (open: boolean) => <PresentationRoot><button>Old opener</button><button>New opener</button><Modal open={open} close={vi.fn()} /></PresentationRoot>;
    const view = render(tree(false)); screen.getByText('Old opener').focus(); view.rerender(tree(true));
    view.rerender(tree(false)); await flushFocus();
    screen.getByText('New opener').focus(); view.rerender(tree(true)); view.rerender(tree(false)); await flushFocus();
    expect(document.activeElement).toBe(screen.getByText('New opener'));
  });
  it('prefers a replacement modal explicit origin over the transferred opener', async () => {
    const tree = (stage: number) => <PresentationRoot><button>Old opener</button><button id="explicit-return">Explicit opener</button><Modal open={stage === 1} close={vi.fn()} name="Old" /><Modal open={stage === 2} close={vi.fn()} name="New" returnFocus={() => document.getElementById('explicit-return')} /></PresentationRoot>;
    const view = render(tree(0)); screen.getByText('Old opener').focus(); view.rerender(tree(1)); view.rerender(tree(2)); await flushFocus();
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
    view.rerender(tree(0)); await flushFocus(); expect(document.activeElement).toBe(screen.getByText('Explicit opener'));
  });
  it('resolves nested closing origins when parent cleanup precedes child cleanup', async () => {
    const tree = (stage: number) => <PresentationRoot><button>Workspace origin</button><nav aria-label="Primary"><a href="#today" aria-current="page">Fallback route</a></nav><Modal open={stage > 0} close={vi.fn()} name="Parent" /><Modal open={stage > 1} close={vi.fn()} name="Child" /></PresentationRoot>;
    const view = render(tree(0)); const origin = screen.getByText('Workspace origin'); origin.focus();
    view.rerender(tree(1)); screen.getByRole('combobox').focus(); view.rerender(tree(2));
    view.rerender(tree(0)); await flushFocus(); expect(document.activeElement).toBe(origin);
  });
  it('resolves nested closing origins when child cleanup precedes parent cleanup', async () => {
    const tree = (stage: number) => <PresentationRoot><button>Workspace origin</button><nav aria-label="Primary"><a href="#today" aria-current="page">Fallback route</a></nav><Modal open={stage > 1} close={vi.fn()} name="Child" /><Modal open={stage > 0} close={vi.fn()} name="Parent" /></PresentationRoot>;
    const view = render(tree(0)); const origin = screen.getByText('Workspace origin'); origin.focus();
    view.rerender(tree(1)); screen.getByRole('combobox').focus(); view.rerender(tree(2));
    view.rerender(tree(0)); await flushFocus(); expect(document.activeElement).toBe(origin);
  });
  it('preserves the original opener through StrictMode modal replay and replacement', async () => {
    const tree = (stage: number) => <StrictMode><PresentationRoot><button>Original opener</button>{stage === 1 && <Modal close={vi.fn()} name="Old" />}{stage === 2 && <Modal close={vi.fn()} name="New" />}</PresentationRoot></StrictMode>;
    const view = render(tree(0)); const origin = screen.getByText('Original opener'); origin.focus();
    view.rerender(tree(1)); view.rerender(tree(2)); await flushFocus();
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
    view.rerender(tree(0)); await flushFocus(); expect(document.activeElement).toBe(origin);
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledTimes(4);
  });
  it('preserves focus already moved outside a closing nonmodal contact', async () => {
    const tree = (open: boolean) => <PresentationRoot><button>Elsewhere</button>{open && <Contact close={vi.fn()} />}</PresentationRoot>;
    const view = render(tree(true)); screen.getByText('Contact action').focus(); screen.getByText('Elsewhere').focus();
    view.rerender(tree(false)); await flushFocus(); expect(document.activeElement).toBe(screen.getByText('Elsewhere'));
  });
});

describe('native modal Tab boundary', () => {
  function TabModal({ busy = false, changed = false, name = 'Tab modal', handled = false }: { busy?: boolean; changed?: boolean; name?: string; handled?: boolean }) {
    const dialogRef = useRef<HTMLDialogElement>(null);
    const modal = useModalDialog({ open: true, dialogRef, canDismiss: () => !busy, onDismiss: vi.fn() });
    return <dialog ref={dialogRef} aria-label={name} onKeyDown={modal.onKeyDown} onCancel={modal.onCancel}>
      <button disabled={busy || changed}>First</button>
      <input aria-label="Middle" disabled={busy} onKeyDown={event => { if (handled && event.key === 'Tab') event.preventDefault(); }} />
      <div style={{ display: changed ? 'none' : undefined }}><button disabled={busy}>Last</button></div>
      <button hidden>Hidden</button><button style={{ visibility: 'hidden' }}>Invisible</button>
      <div inert><button>Inert</button></div><input type="hidden" /><button tabIndex={-1}>Not tabbed</button>
      <fieldset disabled><button>Disabled fieldset</button></fieldset>
    </dialog>;
  }
  it('wraps forward and reverse using the current visible enabled controls', () => {
    const view = render(<PresentationRoot><TabModal /></PresentationRoot>);
    const first = screen.getByText('First'); const last = screen.getByText('Last');
    last.focus(); expect(fireEvent.keyDown(last, { key: 'Tab' })).toBe(false); expect(document.activeElement).toBe(first);
    expect(fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })).toBe(false); expect(document.activeElement).toBe(last);
    view.rerender(<PresentationRoot><TabModal changed /></PresentationRoot>);
    const middle = screen.getByRole('textbox'); middle.focus();
    expect(fireEvent.keyDown(middle, { key: 'Tab' })).toBe(false); expect(document.activeElement).toBe(middle);
    expect(fireEvent.keyDown(middle, { key: 'Tab', shiftKey: true })).toBe(false); expect(document.activeElement).toBe(middle);
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledTimes(1);
  });
  it('focuses the native dialog itself when all current controls are unavailable', () => {
    render(<PresentationRoot><TabModal busy changed /></PresentationRoot>);
    const dialog = screen.getByRole('dialog');
    expect(fireEvent.keyDown(dialog, { key: 'Tab' })).toBe(false); expect(document.activeElement).toBe(dialog);
    expect(fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })).toBe(false); expect(document.activeElement).toBe(dialog);
    expect((dialog as HTMLDialogElement).open).toBe(true);
  });
  it('leaves child-handled Tab and ordinary interior Tab to the child/browser', () => {
    const view = render(<PresentationRoot><TabModal /></PresentationRoot>);
    const middle = screen.getByRole('textbox'); middle.focus();
    expect(fireEvent.keyDown(middle, { key: 'Tab' })).toBe(true);
    view.rerender(<PresentationRoot><TabModal changed handled /></PresentationRoot>);
    expect(fireEvent.keyDown(middle, { key: 'Tab' })).toBe(false); expect(document.activeElement).toBe(middle);
  });
  it('never redirects a non-top modal Tab into the underlying modal', () => {
    render(<PresentationRoot><TabModal name="Under" /><TabModal name="Top" /></PresentationRoot>);
    const under = screen.getByRole('dialog', { name: 'Under' });
    const first = under.querySelector('button')!; first.focus();
    expect(fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })).toBe(true); expect(document.activeElement).toBe(first);
  });
});
