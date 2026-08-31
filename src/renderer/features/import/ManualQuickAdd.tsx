import { useId, useState } from 'react';

import { Button } from '../../components/Button';
import { ErrorState } from '../../components/ErrorState';
import type {
  ImportCommitReceipt,
  ImportPreview,
} from '../../../shared/contracts/importContract';
import type { ImportApi } from './importApi';
import { ImportValidationErrors } from './ImportValidationStep';
import { commitPreparedImport, toSafeImportError } from './useImportWorkflow';

export type ManualQuickAddProps = {
  api: ImportApi;
  onCommitted(receipt: ImportCommitReceipt): void;
};

const MANUAL_COLUMNS = ['Name', 'Phone', 'Email', 'Notes'] as const;

type ManualDraft = Record<(typeof MANUAL_COLUMNS)[number], string>;

const EMPTY_DRAFT: ManualDraft = { Name: '', Phone: '', Email: '', Notes: '' };

const sanitizeCell = (value: string): string =>
  value.replace(/[\t\r\n]+/g, ' ').trim();

/** Builds the one-row synthetic spreadsheet paste for the shared pipeline. */
export const buildManualContent = (draft: ManualDraft): string => {
  const header = MANUAL_COLUMNS.join('\t');
  const row = MANUAL_COLUMNS.map((column) => sanitizeCell(draft[column])).join('\t');
  return `${header}\n${row}`;
};

/**
 * One-lead quick add. Submits a single synthetic row through the exact same
 * preview and commit API as bulk import, so normalization, validation, and
 * invariants are identical. The "Add lead" handler is the explicit commit
 * trigger; validation failures surface without writing anything.
 */
export function ManualQuickAdd({ api, onCommitted }: ManualQuickAddProps) {
  const baseId = useId();
  const [draft, setDraft] = useState<ManualDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [rowErrors, setRowErrors] = useState<ImportPreview['errors']>([]);
  const [failure, setFailure] = useState<{ safeCode: string; message: string } | null>(
    null,
  );

  const handleAdd = async () => {
    setBusy(true);
    setRowErrors([]);
    setFailure(null);
    try {
      const preview = await api.preview({
        kind: 'spreadsheet_paste',
        sourceName: 'Manual quick add',
        content: buildManualContent(draft),
      });
      if (preview.errors.length > 0 || preview.validCount === 0) {
        setRowErrors(preview.errors);
        return;
      }
      if (preview.duplicateCandidates.length > 0) {
        setFailure({
          safeCode: 'IMPORT_DUPLICATE_REVIEW_REQUIRED',
          message:
            'This person may already exist. Use the full import to resolve duplicates.',
        });
        return;
      }
      const receipt = await commitPreparedImport(api, {
        previewId: preview.previewId,
        contentHash: preview.contentHash,
        mapping: preview.suggestedMapping,
        source: { channel: 'custom', referredByPersonId: null },
        duplicateDecisions: [],
      });
      setDraft(EMPTY_DRAFT);
      onCommitted(receipt);
    } catch (error) {
      setFailure(toSafeImportError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="manual-quick-add"
      aria-label="Manual quick add"
      onSubmit={(event) => {
        event.preventDefault();
      }}
    >
      {MANUAL_COLUMNS.map((column) => {
        const fieldId = `${baseId}-${column}`;
        return (
          <div className="import-field" key={column}>
            <label htmlFor={fieldId}>{column}</label>
            <input
              id={fieldId}
              type="text"
              value={draft[column]}
              onChange={(event) => {
                setDraft((current) => ({ ...current, [column]: event.target.value }));
              }}
            />
          </div>
        );
      })}
      <ImportValidationErrors errors={rowErrors} />
      {failure !== null && (
        <ErrorState
          title={`Add failed (${failure.safeCode})`}
          description={failure.message}
        />
      )}
      <div className="import-actions">
        <Button
          onClick={() => {
            void handleAdd();
          }}
          disabled={busy || sanitizeCell(draft.Name) === ''}
        >
          Add lead
        </Button>
      </div>
    </form>
  );
}
