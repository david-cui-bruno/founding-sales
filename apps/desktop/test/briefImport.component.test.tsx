// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { BriefImport } from '../src/renderer/firms/BriefImport.tsx';
import type { BriefImportView } from '../src/shared/briefImport.ts';
import type { ImportBridge, OperationApi, OperationName } from '../src/shared/operations.ts';

/**
 * Lane PB: Firms → Import → "Import prepared briefs (JSON)…". The window shows the main
 * process's preview and sends the commit; a refused row says so on its own line.
 */

const PREVIEW: BriefImportView = {
  previewId: 1,
  fileName: 'dfw-batch-1-briefs.json',
  fileError: null,
  reason: null,
  committing: false,
  committed: false,
  rows: [
    { index: 1, label: 'Alpha Test Co', status: 'matched', issue: null, firmName: 'Alpha Test Co', matchedOn: 'external_id', briefLength: 300, sourceCount: 4, result: null },
    { index: 2, label: 'Bravo Test Co', status: 'matched', issue: null, firmName: 'Bravo Test Co', matchedOn: 'external_id', briefLength: 300, sourceCount: 1, result: null },
    { index: 3, label: 'Nobody Test Co', status: 'unmatched', issue: null, firmName: null, matchedOn: null, briefLength: 300, sourceCount: 1, result: null },
    { index: 4, label: 'Twin Test Co', status: 'ambiguous', issue: 'firm_name', firmName: null, matchedOn: null, briefLength: 300, sourceCount: 1, result: null },
    { index: 5, label: 'Row 5', status: 'invalid', issue: 'sources', firmName: null, matchedOn: null, briefLength: 0, sourceCount: 0, result: null },
  ],
};

afterEach(() => {
  cleanup();
  globalThis.callieApi = undefined;
  globalThis.callieImport = undefined;
});

describe('the prepared-brief import screen', () => {
  it('shows the preview, imports the matched rows, and says which row was refused', async () => {
    const user = userEvent.setup();
    const asked: string[] = [];
    let held: BriefImportView = { previewId: 0, fileName: null, fileError: null, reason: null, committing: false, committed: false, rows: [] };
    const commits: unknown[] = [];
    const answer = async (operation: OperationName, input?: unknown): Promise<unknown> => {
      asked.push(operation);
      if (operation === 'firms.briefImportCommit') commits.push(input);
      if (operation === 'firms.briefImportState') return await Promise.resolve(held);
      if (operation === 'firms.briefImportCommit') {
        held = {
          ...PREVIEW,
          committed: true,
          rows: PREVIEW.rows.map(row => (row.index === 1 ? { ...row, result: 'saved' } : row.index === 2 ? { ...row, result: 'unchanged' } : row.index === 3 ? { ...row, result: 'unmatched' } : row.index === 4 ? { ...row, result: 'ambiguous' } : row)),
        };
        return await Promise.resolve(held);
      }
      return await Promise.reject(new Error(`unscripted ${operation}`));
    };
    globalThis.callieApi = { read: answer, command: answer } as unknown as OperationApi;
    globalThis.callieImport = {
      choose: async () => await Promise.reject(new Error('not the CSV')),
      chooseBriefs: async () => {
        held = PREVIEW;
        return await Promise.resolve(held);
      },
    } as unknown as ImportBridge;

    render(<BriefImport enabled />);
    await user.click(screen.getByTestId('brief-import-choose'));
    await waitFor(() => expect(screen.getAllByTestId('brief-import-row')).toHaveLength(5));
    expect(screen.getByTestId('brief-import-summary').textContent).toBe('dfw-batch-1-briefs.json · 2 matched · 1 unmatched · 1 ambiguous · 1 to fix');
    expect(screen.getAllByTestId('brief-import-row').map(row => row.getAttribute('data-status'))).toEqual(['matched', 'matched', 'unmatched', 'ambiguous', 'invalid']);
    expect(screen.getByTestId('brief-import-commit').textContent).toBe('Import 2 briefs');

    await user.click(screen.getByTestId('brief-import-commit'));
    await waitFor(() => expect(screen.getByTestId('brief-import-results').textContent).toBe('1 imported · 1 unchanged · 2 skipped'));
    expect(screen.getAllByTestId('brief-import-row').map(row => row.getAttribute('data-result'))).toEqual(['saved', 'unchanged', 'unmatched', 'ambiguous', '']);
    expect(screen.getAllByTestId('brief-import-row')[2]?.textContent).not.toContain('unmatched;');
    // Answered: nothing left to press.
    expect((screen.getByTestId('brief-import-commit') as HTMLButtonElement).disabled).toBe(true);
    expect(asked).toEqual(['firms.briefImportState', 'firms.briefImportCommit']);
    // The commit names the preview it was pressed on.
    expect(commits).toEqual([{ previewId: 1 }]);
  });

  it('reads the held preview when it mounts again, so leaving the screen loses nothing', async () => {
    const answer = async (): Promise<unknown> => await Promise.resolve(PREVIEW);
    globalThis.callieApi = { read: answer, command: answer } as unknown as OperationApi;
    globalThis.callieImport = { choose: answer, chooseBriefs: answer } as unknown as ImportBridge;
    render(<BriefImport enabled />);
    await waitFor(() => expect(screen.getAllByTestId('brief-import-row')).toHaveLength(5));
  });

  it('disables choosing another file while the import is on the wire', async () => {
    const committing: BriefImportView = { ...PREVIEW, committing: true };
    const answer = async (): Promise<unknown> => await Promise.resolve(committing);
    globalThis.callieApi = { read: answer, command: answer } as unknown as OperationApi;
    globalThis.callieImport = { choose: answer, chooseBriefs: answer } as unknown as ImportBridge;
    render(<BriefImport enabled />);
    await waitFor(() => expect(screen.getAllByTestId('brief-import-row')).toHaveLength(5));
    expect((screen.getByTestId('brief-import-choose') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('brief-import-commit') as HTMLButtonElement).disabled).toBe(true);
  });
});
