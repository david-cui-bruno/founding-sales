// @vitest-environment jsdom

import { PresentationRoot } from '../../app/PresentationRoot';
import { cleanup, fireEvent, render as testingRender, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import type {
  ImportCommitReceipt,
  ImportPreview,
} from '../../../shared/contracts/importContract';
import { ImportDialog } from './ImportDialog';
import type { ImportApi } from './importApi';

const render = (ui: Parameters<typeof testingRender>[0], options?: Parameters<typeof testingRender>[1]) => testingRender(ui, { wrapper: PresentationRoot, ...options });

type MockImportApi = { [K in keyof ImportApi]: Mock<ImportApi[K]> };

const HASH = 'a'.repeat(64);

const basePreview: ImportPreview = {
  previewId: 'preview-1',
  contentHash: HASH,
  columns: ['Name', 'Phone'],
  sampleRows: [{ rowNumber: 2, cells: ['Kevin', '4015550101'] }],
  suggestedMapping: { Name: 'person_name', Phone: 'phone' },
  rowCount: 1,
  validCount: 1,
  errors: [],
  duplicateCandidates: [],
  expiresAt: '2027-01-01T00:00:00.000Z',
};

const receipt: ImportCommitReceipt = {
  jobId: 'job-1',
  importedPersonIds: ['person-1'],
  importedRowCount: 1,
  revision: 3,
};

const createApi = (): MockImportApi => ({
  preview: vi.fn<ImportApi['preview']>(),
  remap: vi.fn<ImportApi['remap']>(),
  commit: vi.fn<ImportApi['commit']>(),
  status: vi.fn<ImportApi['status']>(),
});

const renderDialogWithPreview = async (previewValue: ImportPreview) => {
  const api = createApi();
  api.preview.mockResolvedValue(previewValue);
  const onCommitted = vi.fn();
  const onClose = vi.fn();
  render(<ImportDialog api={api} open onClose={onClose} onCommitted={onCommitted} />);
  fireEvent.change(screen.getByLabelText('Paste spreadsheet rows'), {
    target: { value: 'Name\tPhone\nKevin\t4015550101' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Preview rows' }));
  await screen.findByRole('button', { name: /Import/ });
  return { api, onCommitted, onClose };
};

// jsdom has no native dialog API. These shims model only open/close state;
// real browser/package checks must verify top-layer placement and Tab containment.
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) { this.setAttribute('open', ''); },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) { this.removeAttribute('open'); },
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
});

describe('ImportDialog', () => {
  it('opens a native modal, focuses its close control and restores the opener when closed', async () => {
    const api = createApi();
    const onClose = vi.fn();
    const onCommitted = vi.fn();
    render(<button type="button">Open import</button>);
    const opener = screen.getByRole('button', { name: 'Open import' });
    opener.focus();
    const view = render(<ImportDialog api={api} open onClose={onClose} onCommitted={onCommitted} />);

    const dialog = screen.getByRole('dialog', { name: 'Import leads' });
    expect(dialog.tagName).toBe('DIALOG');
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));

    view.rerender(<ImportDialog api={api} open={false} onClose={onClose} onCommitted={onCommitted} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(opener));

    view.rerender(<ImportDialog api={api} open onClose={onClose} onCommitted={onCommitted} />);
    expect(screen.getByRole('dialog').hasAttribute('open')).toBe(true);
    view.unmount();
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('restores focus to the connected replacement when a successful import remounts its opener', async () => {
    const api = createApi();
    const onClose = vi.fn();
    const onCommitted = vi.fn();
    const trigger = render(<button key="before" id="leads-import-trigger">Import</button>);
    const original = screen.getByRole('button', { name: 'Import' });
    original.focus();
    const view = render(<ImportDialog api={api} open onClose={onClose} onCommitted={onCommitted} />);

    // A refreshed Leads route has a new DOM button with the same stable ID.
    trigger.rerender(<button key="after" id="leads-import-trigger">Import</button>);
    const replacement = screen.getByRole('button', { name: 'Import' });
    expect(original.isConnected).toBe(false);
    expect(replacement).not.toBe(original);
    expect(replacement.isConnected).toBe(true);
    view.rerender(<ImportDialog api={api} open={false} onClose={onClose} onCommitted={onCommitted} />);

    await waitFor(() => expect(document.activeElement).toBe(replacement));
  });

  it.each([undefined, 'removed-import-trigger'])('returns focus to the current primary route when opener %s has no replacement', async (id) => {
    const api = createApi();
    const onClose = vi.fn();
    const onCommitted = vi.fn();
    const navigation = <nav className="nav-rail" aria-label="Primary"><a href="#/leads" aria-current="page">Leads</a></nav>;
    const workspace = render(<>{navigation}<button id={id}>Open import</button></>);
    const opener = screen.getByRole('button', { name: 'Open import' });
    opener.focus();
    const view = render(<ImportDialog api={api} open onClose={onClose} onCommitted={onCommitted} />);

    workspace.rerender(navigation);
    expect(opener.isConnected).toBe(false);
    view.rerender(<ImportDialog api={api} open={false} onClose={onClose} onCommitted={onCommitted} />);

    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Leads' })));
  });

  it('requests controlled closing from the Close button', () => {
    const onClose = vi.fn();
    render(<ImportDialog api={createApi()} open onClose={onClose} onCommitted={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders nothing while closed', () => {
    render(
      <ImportDialog api={createApi()} open={false} onClose={vi.fn()} onCommitted={vi.fn()} />,
    );

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('walks source, mapping, validation, and atomic commit without writing during preview', async () => {
    const api = createApi();
    api.preview.mockResolvedValue(basePreview);
    api.commit.mockResolvedValue(receipt);
    const onCommitted = vi.fn();
    render(<ImportDialog api={api} open onClose={vi.fn()} onCommitted={onCommitted} />);

    fireEvent.change(screen.getByLabelText('Paste spreadsheet rows'), {
      target: { value: 'Name\tPhone\nKevin\t4015550101' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview rows' }));

    expect(await screen.findByText('1 row ready')).toBeTruthy();
    expect(api.commit).not.toHaveBeenCalled();
    expect(api.preview).toHaveBeenCalledWith({
      kind: 'spreadsheet_paste',
      sourceName: 'Pasted rows',
      content: 'Name\tPhone\nKevin\t4015550101',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Import 1 row' }));

    await waitFor(() => expect(onCommitted).toHaveBeenCalledWith(receipt));
    expect(api.commit).toHaveBeenCalledTimes(1);
    expect(api.commit).toHaveBeenCalledWith({
      previewId: 'preview-1',
      contentHash: HASH,
      mapping: { Name: 'person_name', Phone: 'phone' },
      source: { channel: 'custom', referredByPersonId: null },
      duplicateDecisions: [],
    });
  });

  it('keeps commit disabled while any blocking row error remains', async () => {
    await renderDialogWithPreview({
      ...basePreview,
      validCount: 0,
      errors: [
        { rowNumber: 2, field: 'phone', code: 'INVALID_PHONE', message: 'Invalid phone' },
      ],
    });

    expect(
      screen.getByRole('button', { name: /Import/ }).hasAttribute('disabled'),
    ).toBe(true);
    expect(screen.getByText('INVALID_PHONE')).toBeTruthy();
    expect(screen.getByText('Invalid phone')).toBeTruthy();
  });

  it('loads a CSV file through the labelled native file input', async () => {
    const api = createApi();
    api.preview.mockResolvedValue(basePreview);
    render(<ImportDialog api={api} open onClose={vi.fn()} onCommitted={vi.fn()} />);

    const file = new File(['Name,Phone\nKevin,4015550101'], 'leads.csv', {
      type: 'text/csv',
    });
    fireEvent.change(screen.getByLabelText('CSV file'), { target: { files: [file] } });

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Preview rows' }).hasAttribute('disabled'),
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Preview rows' }));

    await screen.findByText('1 row ready');
    expect(api.preview).toHaveBeenCalledWith({
      kind: 'csv',
      sourceName: 'leads.csv',
      content: 'Name,Phone\nKevin,4015550101',
    });
  });

  it('remaps columns through one labelled select per source column', async () => {
    const { api } = await renderDialogWithPreview(basePreview);
    api.remap.mockResolvedValue(basePreview);

    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: 'email' } });

    await waitFor(() =>
      expect(api.remap).toHaveBeenCalledWith({
        previewId: 'preview-1',
        contentHash: HASH,
        mapping: { Name: 'person_name', Phone: 'email' },
      }),
    );
    await waitFor(() =>
      expect((screen.getByLabelText('Phone') as HTMLSelectElement).value).toBe('email'),
    );
  });

  it('blocks import and skips remap when no column maps to person name', async () => {
    const { api } = await renderDialogWithPreview(basePreview);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'ignore' } });

    expect(api.remap).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain(
      'Exactly one column must be mapped to Person name',
    );
    expect(
      screen.getByRole('button', { name: /Import/ }).hasAttribute('disabled'),
    ).toBe(true);
  });

  it('requires an explicit merge, create, or skip decision per duplicate', async () => {
    const { api, onCommitted } = await renderDialogWithPreview({
      ...basePreview,
      duplicateCandidates: [
        { rowNumber: 2, personIds: ['person-9', 'person-10'], reason: 'Same phone' },
      ],
    });
    api.commit.mockResolvedValue(receipt);

    expect(
      screen.getByRole('button', { name: 'Import 1 row' }).hasAttribute('disabled'),
    ).toBe(true);

    fireEvent.change(screen.getByLabelText('Duplicate action for row 2'), {
      target: { value: 'merge' },
    });
    fireEvent.change(screen.getByLabelText('Merge target for row 2'), {
      target: { value: 'person-10' },
    });

    expect(
      screen.getByRole('button', { name: 'Import 1 row' }).hasAttribute('disabled'),
    ).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 row' }));

    await waitFor(() =>
      expect(api.commit).toHaveBeenCalledWith(
        expect.objectContaining({
          duplicateDecisions: [{ rowNumber: 2, decision: 'merge', personId: 'person-10' }],
        }),
      ),
    );
    await waitFor(() => expect(onCommitted).toHaveBeenCalled());
  });

  it('requires referrer resolution for the referral channel', async () => {
    const { api, onCommitted } = await renderDialogWithPreview(basePreview);
    api.commit.mockResolvedValue(receipt);

    fireEvent.change(screen.getByLabelText('Source channel'), {
      target: { value: 'referral' },
    });
    expect(
      screen.getByRole('button', { name: 'Import 1 row' }).hasAttribute('disabled'),
    ).toBe(true);

    fireEvent.change(screen.getByLabelText('Referred by person ID'), {
      target: { value: 'person-7' },
    });
    expect(
      screen.getByRole('button', { name: 'Import 1 row' }).hasAttribute('disabled'),
    ).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Import 1 row' }));

    await waitFor(() =>
      expect(api.commit).toHaveBeenCalledWith(
        expect.objectContaining({
          source: { channel: 'referral', referredByPersonId: 'person-7' },
        }),
      ),
    );
    await waitFor(() => expect(onCommitted).toHaveBeenCalled());
  });

  it('closes on Escape before commit', () => {
    const onClose = vi.fn();
    render(<ImportDialog api={createApi()} open onClose={onClose} onCommitted={vi.fn()} />);

    const cancel = new Event('cancel', { bubbles: false, cancelable: true });
    fireEvent(screen.getByRole('dialog'), cancel);
    expect(cancel.defaultPrevented).toBe(true);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores Escape while the commit is in flight', async () => {
    const { api, onClose } = await renderDialogWithPreview(basePreview);
    api.commit.mockReturnValue(new Promise<ImportCommitReceipt>(() => undefined));

    fireEvent.click(screen.getByRole('button', { name: 'Import 1 row' }));
    await screen.findByText('Importing rows…');

    const cancel = new Event('cancel', { bubbles: false, cancelable: true });
    fireEvent(screen.getByRole('dialog'), cancel);
    expect(cancel.defaultPrevented).toBe(true);

    const close = screen.getByRole('button', { name: 'Close' });
    expect(close.hasAttribute('disabled')).toBe(true);
    fireEvent.click(close);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('offers a restart when the preview expired before commit', async () => {
    const { api, onCommitted } = await renderDialogWithPreview(basePreview);
    api.commit.mockRejectedValue(
      Object.assign(
        new Error('The import preview is expired or changed; restart the import.'),
        { code: 'IMPORT_PREVIEW_INVALID' },
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Import 1 row' }));

    await screen.findByText(/restart the import/);
    expect(screen.getByText(/IMPORT_PREVIEW_INVALID/)).toBeTruthy();
    expect(onCommitted).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Start over' }));

    const paste = screen.getByLabelText('Paste spreadsheet rows') as HTMLTextAreaElement;
    expect(paste.value).toContain('Kevin');
  });
});
