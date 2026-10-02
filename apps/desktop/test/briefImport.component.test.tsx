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
  fileName: 'dfw-batch-1-briefs.json',
  fileError: null,
  reason: null,
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
    let held: BriefImportView = { fileName: null, fileError: null, reason: null, rows: [] };
    const answer = async (operation: OperationName): Promise<unknown> => {
      asked.push(operation);
      if (operation === 'firms.briefImportState') return await Promise.resolve(held);
      if (operation === 'firms.briefImportCommit') {
        held = { ...PREVIEW, rows: PREVIEW.rows.map(row => (row.index === 1 ? { ...row, result: 'saved' } : row.index === 2 ? { ...row, result: 'not_assigned' } : row)) };
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
    await waitFor(() => expect(screen.getByTestId('brief-import-results').textContent).toBe('1 imported · 1 refused'));
    expect(screen.getAllByTestId('brief-import-row').map(row => row.getAttribute('data-result'))).toEqual(['saved', 'not_assigned', '', '', '']);
    // The refused row says why in words, never the code; it is the only one left to send.
    expect(screen.getAllByTestId('brief-import-row')[1]?.textContent).not.toContain('not_assigned');
    expect(screen.getByTestId('brief-import-commit').textContent).toBe('Import 1 brief');
    expect(asked).toEqual(['firms.briefImportState', 'firms.briefImportCommit']);
  });

  it('reads the held preview when it mounts again, so leaving the screen loses nothing', async () => {
    const answer = async (): Promise<unknown> => await Promise.resolve(PREVIEW);
    globalThis.callieApi = { read: answer, command: answer } as unknown as OperationApi;
    globalThis.callieImport = { choose: answer, chooseBriefs: answer } as unknown as ImportBridge;
    render(<BriefImport enabled />);
    await waitFor(() => expect(screen.getAllByTestId('brief-import-row')).toHaveLength(5));
  });
});
