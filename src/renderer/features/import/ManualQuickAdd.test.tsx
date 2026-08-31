// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import type {
  ImportCommitReceipt,
  ImportPreview,
} from '../../../shared/contracts/importContract';
import type { ImportApi } from './importApi';
import { ManualQuickAdd } from './ManualQuickAdd';

type MockImportApi = { [K in keyof ImportApi]: Mock<ImportApi[K]> };

const HASH = 'c'.repeat(64);

const preview: ImportPreview = {
  previewId: 'preview-manual',
  contentHash: HASH,
  columns: ['Name', 'Phone', 'Email', 'Notes'],
  sampleRows: [{ rowNumber: 2, cells: ['Dana', '4015550188', '', ''] }],
  suggestedMapping: {
    Name: 'person_name',
    Phone: 'phone',
    Email: 'email',
    Notes: 'notes',
  },
  rowCount: 1,
  validCount: 1,
  errors: [],
  duplicateCandidates: [],
  expiresAt: '2027-01-01T00:00:00.000Z',
};

const receipt: ImportCommitReceipt = {
  jobId: 'job-manual',
  importedPersonIds: ['person-11'],
  importedRowCount: 1,
  revision: 8,
};

const createApi = (): MockImportApi => ({
  preview: vi.fn<ImportApi['preview']>(),
  remap: vi.fn<ImportApi['remap']>(),
  commit: vi.fn<ImportApi['commit']>(),
  status: vi.fn<ImportApi['status']>(),
});

afterEach(() => {
  cleanup();
});

describe('ManualQuickAdd', () => {
  it('submits one synthetic row through the same preview and commit API', async () => {
    const api = createApi();
    api.preview.mockResolvedValue(preview);
    api.commit.mockResolvedValue(receipt);
    const onCommitted = vi.fn();
    render(<ManualQuickAdd api={api} onCommitted={onCommitted} />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Dana' } });
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '4015550188' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add lead' }));

    await waitFor(() => expect(onCommitted).toHaveBeenCalledWith(receipt));

    expect(api.preview).toHaveBeenCalledTimes(1);
    const source = api.preview.mock.calls[0][0];
    expect(source.kind).toBe('spreadsheet_paste');
    expect(source.sourceName).toBe('Manual quick add');
    const lines = source.content.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0].split('\t')).toEqual(['Name', 'Phone', 'Email', 'Notes']);
    expect(lines[1].split('\t')).toEqual(['Dana', '4015550188', '', '']);

    expect(api.commit).toHaveBeenCalledTimes(1);
    expect(api.commit).toHaveBeenCalledWith({
      previewId: 'preview-manual',
      contentHash: HASH,
      mapping: preview.suggestedMapping,
      source: { channel: 'custom', referredByPersonId: null },
      duplicateDecisions: [],
    });
  });

  it('requires a name before submitting anything', () => {
    const api = createApi();
    render(<ManualQuickAdd api={api} onCommitted={vi.fn()} />);

    expect(
      screen.getByRole('button', { name: 'Add lead' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(api.preview).not.toHaveBeenCalled();
    expect(api.commit).not.toHaveBeenCalled();
  });

  it('shows row, field, and code for validation failures without committing', async () => {
    const api = createApi();
    api.preview.mockResolvedValue({
      ...preview,
      validCount: 0,
      errors: [
        { rowNumber: 2, field: 'phone', code: 'INVALID_PHONE', message: 'Invalid phone' },
      ],
    });
    render(<ManualQuickAdd api={api} onCommitted={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Dana' } });
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add lead' }));

    expect(await screen.findByText('INVALID_PHONE')).toBeTruthy();
    expect(screen.getByText('Invalid phone')).toBeTruthy();
    expect(api.commit).not.toHaveBeenCalled();
  });

  it('surfaces a safe error and allows retry when the preview call fails', async () => {
    const api = createApi();
    api.preview.mockRejectedValueOnce(
      Object.assign(new Error('The import preview is expired or changed; restart the import.'), {
        code: 'IMPORT_PREVIEW_INVALID',
      }),
    );
    api.preview.mockResolvedValueOnce(preview);
    api.commit.mockResolvedValue(receipt);
    const onCommitted = vi.fn();
    render(<ManualQuickAdd api={api} onCommitted={onCommitted} />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Dana' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add lead' }));

    expect(await screen.findByText(/IMPORT_PREVIEW_INVALID/)).toBeTruthy();
    expect(api.commit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Add lead' }));
    await waitFor(() => expect(onCommitted).toHaveBeenCalledWith(receipt));
  });
});
