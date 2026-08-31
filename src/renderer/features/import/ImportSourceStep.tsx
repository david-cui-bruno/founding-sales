import { useId } from 'react';
import type { ChangeEvent } from 'react';

import { Button } from '../../components/Button';
import type { ImportSourceDraft } from './useImportWorkflow';

export type ImportSourceStepProps = {
  draft: ImportSourceDraft;
  onSourceChange(draft: ImportSourceDraft): void;
  onPreview(): void;
};

/**
 * Source selection step: a labelled native CSV file input and a labelled
 * paste textarea. Choosing either replaces the pending source draft; nothing
 * is sent until the explicit "Preview rows" action.
 */
export function ImportSourceStep({
  draft,
  onSourceChange,
  onPreview,
}: ImportSourceStepProps) {
  const fileId = useId();
  const pasteId = useId();

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file === undefined) return;
    void file.text().then((content) => {
      onSourceChange({ sourceKind: 'csv', sourceName: file.name, content });
    });
  };

  const handlePasteChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    onSourceChange({
      sourceKind: 'spreadsheet_paste',
      sourceName: 'Pasted rows',
      content: event.target.value,
    });
  };

  return (
    <div className="import-step">
      <div className="import-field">
        <label htmlFor={fileId}>CSV file</label>
        <input
          id={fileId}
          type="file"
          accept=".csv,text/csv"
          onChange={handleFileChange}
        />
      </div>
      {draft.sourceKind === 'csv' && draft.sourceName !== '' && (
        <p className="import-note">{draft.sourceName} loaded.</p>
      )}
      <div className="import-field">
        <label htmlFor={pasteId}>Paste spreadsheet rows</label>
        <textarea
          id={pasteId}
          rows={8}
          value={draft.sourceKind === 'spreadsheet_paste' ? draft.content : ''}
          onChange={handlePasteChange}
        />
      </div>
      <div className="import-actions">
        <Button onClick={onPreview} disabled={draft.content.trim() === ''}>
          Preview rows
        </Button>
      </div>
    </div>
  );
}
