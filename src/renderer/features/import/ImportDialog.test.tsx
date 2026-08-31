// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import type {
  ImportCommitReceipt,
  ImportPreview,
} from '../../../shared/contracts/importContract';
import { ImportDialog } from './ImportDialog';
import type { ImportApi } from './importApi';

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

afterEach(() => {
  cleanup();
});

describe('ImportDialog', () => {
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

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores Escape while the commit is in flight', async () => {
    const { api, onClose } = await renderDialogWithPreview(basePreview);
    api.commit.mockReturnValue(new Promise<ImportCommitReceipt>(() => undefined));

    fireEvent.click(screen.getByRole('button', { name: 'Import 1 row' }));
    await screen.findByText('Importing rows…');

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

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
