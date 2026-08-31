// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import type {
  ImportCommitReceipt,
  ImportPreview,
} from '../../../shared/contracts/importContract';
import type { ImportApi } from './importApi';
import { useImportWorkflow } from './useImportWorkflow';

type MockImportApi = { [K in keyof ImportApi]: Mock<ImportApi[K]> };

const HASH = 'b'.repeat(64);

const makePreview = (overrides: Partial<ImportPreview> = {}): ImportPreview => ({
  previewId: 'preview-1',
  contentHash: HASH,
  columns: ['Name'],
  sampleRows: [{ rowNumber: 2, cells: ['Kevin'] }],
  suggestedMapping: { Name: 'person_name' },
  rowCount: 1,
  validCount: 1,
  errors: [],
  duplicateCandidates: [],
  expiresAt: '2027-01-01T00:00:00.000Z',
  ...overrides,
});

const receipt: ImportCommitReceipt = {
  jobId: 'job-1',
  importedPersonIds: ['person-1'],
  importedRowCount: 1,
  revision: 5,
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

describe('useImportWorkflow', () => {
  it('starts at the source step and previews into the ready step', async () => {
    const api = createApi();
    api.preview.mockResolvedValue(makePreview());
    const { result } = renderHook(() => useImportWorkflow(api));

    expect(result.current.state.step).toBe('source');

    act(() => {
      result.current.setSource({
        sourceKind: 'spreadsheet_paste',
        sourceName: 'Pasted rows',
        content: 'Name\nKevin',
      });
    });
    act(() => {
      result.current.requestPreview();
    });
    expect(result.current.state.step).toBe('previewing');

    await waitFor(() => expect(result.current.state.step).toBe('ready'));
    expect(api.commit).not.toHaveBeenCalled();
  });

  it('ignores stale preview responses after a restart', async () => {
    const api = createApi();
    let resolveFirst: (preview: ImportPreview) => void = () => undefined;
    api.preview.mockImplementationOnce(
      () => new Promise<ImportPreview>((resolve) => {
        resolveFirst = resolve;
      }),
    );
    const { result } = renderHook(() => useImportWorkflow(api));

    act(() => {
      result.current.setSource({
        sourceKind: 'spreadsheet_paste',
        sourceName: 'Pasted rows',
        content: 'Name\nKevin',
      });
    });
    act(() => {
      result.current.requestPreview();
    });
    act(() => {
      result.current.restart();
    });
    expect(result.current.state.step).toBe('source');

    await act(async () => {
      resolveFirst(makePreview({ previewId: 'stale-preview' }));
      await Promise.resolve();
    });

    expect(result.current.state.step).toBe('source');
  });

  it('ignores stale remap responses when a newer remap is in flight', async () => {
    const api = createApi();
    api.preview.mockResolvedValue(makePreview({ columns: ['Name', 'Phone'], suggestedMapping: { Name: 'person_name', Phone: 'phone' } }));
    let resolveSlow: (preview: ImportPreview) => void = () => undefined;
    api.remap
      .mockImplementationOnce(
        () => new Promise<ImportPreview>((resolve) => {
          resolveSlow = resolve;
        }),
      )
      .mockImplementationOnce(async () => makePreview({
        columns: ['Name', 'Phone'],
        suggestedMapping: { Name: 'person_name', Phone: 'email' },
        validCount: 99,
      }));
    const { result } = renderHook(() => useImportWorkflow(api));

    act(() => {
      result.current.setSource({
        sourceKind: 'spreadsheet_paste',
        sourceName: 'Pasted rows',
        content: 'Name\tPhone\nKevin\t4015550101',
      });
    });
    act(() => {
      result.current.requestPreview();
    });
    await waitFor(() => expect(result.current.state.step).toBe('ready'));

    act(() => {
      result.current.setMapping({ Name: 'person_name', Phone: 'notes' });
    });
    act(() => {
      result.current.setMapping({ Name: 'person_name', Phone: 'email' });
    });

    await waitFor(() => expect(result.current.state.step).toBe('ready'));
    const readyState = result.current.state;
    if (readyState.step !== 'ready') throw new Error('expected ready');
    expect(readyState.preview.validCount).toBe(99);

    await act(async () => {
      resolveSlow(makePreview({ validCount: 1 }));
      await Promise.resolve();
    });

    const finalState = result.current.state;
    if (finalState.step !== 'ready') throw new Error('expected ready');
    expect(finalState.preview.validCount).toBe(99);
  });

  it('commits only from the explicit commit call and reports completion', async () => {
    const api = createApi();
    api.preview.mockResolvedValue(makePreview());
    api.commit.mockResolvedValue(receipt);
    const { result } = renderHook(() => useImportWorkflow(api));

    act(() => {
      result.current.setSource({
        sourceKind: 'spreadsheet_paste',
        sourceName: 'Pasted rows',
        content: 'Name\nKevin',
      });
    });
    act(() => {
      result.current.requestPreview();
    });
    await waitFor(() => expect(result.current.state.step).toBe('ready'));
    expect(api.commit).not.toHaveBeenCalled();

    act(() => {
      result.current.commit();
    });
    expect(result.current.state.step).toBe('committing');

    await waitFor(() => expect(result.current.state.step).toBe('complete'));
    const state = result.current.state;
    if (state.step !== 'complete') throw new Error('expected complete');
    expect(state.receipt).toEqual(receipt);
    expect(api.commit).toHaveBeenCalledTimes(1);
    expect(api.commit).toHaveBeenCalledWith({
      previewId: 'preview-1',
      contentHash: HASH,
      mapping: { Name: 'person_name' },
      source: { channel: 'custom', referredByPersonId: null },
      duplicateDecisions: [],
    });
  });

  it('surfaces a safe failure code without stack traces when commit fails', async () => {
    const api = createApi();
    api.preview.mockResolvedValue(makePreview());
    api.commit.mockRejectedValue(
      Object.assign(new Error('The import preview is expired or changed; restart the import.'), {
        code: 'IMPORT_PREVIEW_INVALID',
      }),
    );
    const { result } = renderHook(() => useImportWorkflow(api));

    act(() => {
      result.current.setSource({
        sourceKind: 'spreadsheet_paste',
        sourceName: 'Pasted rows',
        content: 'Name\nKevin',
      });
    });
    act(() => {
      result.current.requestPreview();
    });
    await waitFor(() => expect(result.current.state.step).toBe('ready'));

    act(() => {
      result.current.commit();
    });
    await waitFor(() => expect(result.current.state.step).toBe('failed'));

    const state = result.current.state;
    if (state.step !== 'failed') throw new Error('expected failed');
    expect(state.safeCode).toBe('IMPORT_PREVIEW_INVALID');
    expect(state.message).not.toContain('at ');

    act(() => {
      result.current.restart();
    });
    expect(result.current.state.step).toBe('source');
  });

  it('keeps commit blocked while errors, duplicates, or referral referrer are unresolved', async () => {
    const api = createApi();
    api.preview.mockResolvedValue(makePreview({
      duplicateCandidates: [{ rowNumber: 2, personIds: ['person-2'], reason: 'Same phone' }],
    }));
    const { result } = renderHook(() => useImportWorkflow(api));

    act(() => {
      result.current.setSource({
        sourceKind: 'spreadsheet_paste',
        sourceName: 'Pasted rows',
        content: 'Name\nKevin',
      });
    });
    act(() => {
      result.current.requestPreview();
    });
    await waitFor(() => expect(result.current.state.step).toBe('ready'));

    expect(result.current.commitBlockers).toContain('duplicates_unresolved');

    act(() => {
      result.current.setDuplicateDecision(2, { decision: 'merge', personId: null });
    });
    expect(result.current.commitBlockers).toContain('duplicates_unresolved');

    act(() => {
      result.current.setDuplicateDecision(2, { decision: 'merge', personId: 'person-2' });
    });
    expect(result.current.commitBlockers).not.toContain('duplicates_unresolved');

    act(() => {
      result.current.setSourceChannel('referral');
    });
    expect(result.current.commitBlockers).toContain('referrer_required');

    act(() => {
      result.current.setReferredByPersonId('person-3');
    });
    expect(result.current.commitBlockers).toEqual([]);
  });
});
