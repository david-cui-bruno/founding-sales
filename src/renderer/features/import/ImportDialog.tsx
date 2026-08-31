import { useId } from 'react';
import type { KeyboardEvent } from 'react';

import { Button } from '../../components/Button';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import type { ImportCommitReceipt } from '../../../shared/contracts/importContract';
import type { ImportApi } from './importApi';
import { ImportCommitStep } from './ImportCommitStep';
import { ImportMappingStep } from './ImportMappingStep';
import { ImportSourceStep } from './ImportSourceStep';
import { ImportValidationStep } from './ImportValidationStep';
import { useImportWorkflow } from './useImportWorkflow';
import './import.css';

export type ImportDialogProps = {
  api: ImportApi;
  open: boolean;
  onClose(): void;
  onCommitted(receipt: ImportCommitReceipt): void;
};

/**
 * CSV/paste lead import dialog. Preview and remap are read-only round trips;
 * the workflow writes exactly once, from the explicit "Import N rows"
 * handler. Escape closes the dialog at any point before that commit starts.
 */
export function ImportDialog({ api, open, onClose, onCommitted }: ImportDialogProps) {
  const headingId = useId();
  const workflow = useImportWorkflow(api);
  const { state, preview } = workflow;

  if (!open) return null;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return;
    if (state.step === 'committing') return;
    onClose();
  };

  const handleCommit = () => {
    void workflow.commit().then((receipt) => {
      if (receipt !== null) onCommitted(receipt);
    });
  };

  const commitDisabled = state.step !== 'ready' || workflow.commitBlockers.length > 0;

  return (
    <div
      className="import-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      onKeyDown={handleKeyDown}
    >
      <header className="import-dialog__header">
        <h2 id={headingId}>Import leads</h2>
        <Button variant="quiet" onClick={onClose} disabled={state.step === 'committing'}>
          Close
        </Button>
      </header>

      {state.step === 'source' && (
        <ImportSourceStep
          draft={{
            sourceKind: state.sourceKind,
            sourceName: state.sourceName,
            content: state.content,
          }}
          onSourceChange={workflow.setSource}
          onPreview={workflow.requestPreview}
        />
      )}

      {state.step === 'previewing' && <LoadingState label="Building preview…" />}

      {preview !== null && workflow.draftMapping !== null && (
        <>
          <ImportMappingStep
            columns={preview.columns}
            mapping={workflow.draftMapping}
            mappingError={workflow.mappingError}
            onMappingChange={workflow.setMapping}
          />
          <ImportValidationStep
            preview={preview}
            decisions={workflow.duplicateDecisions}
            onDecisionChange={workflow.setDuplicateDecision}
          />
          {state.step === 'committing' ? (
            <LoadingState label="Importing rows…" />
          ) : (
            <ImportCommitStep
              rowCount={preview.validCount}
              sourceChannel={workflow.sourceChannel}
              referredByPersonId={workflow.referredByPersonId}
              commitDisabled={commitDisabled}
              onSourceChannelChange={workflow.setSourceChannel}
              onReferredByChange={workflow.setReferredByPersonId}
              onCommit={handleCommit}
            />
          )}
        </>
      )}

      {state.step === 'complete' && (
        <div className="import-step">
          <p role="status">
            Imported {state.receipt.importedRowCount}{' '}
            {state.receipt.importedRowCount === 1 ? 'row' : 'rows'}.
          </p>
          <div className="import-actions">
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      )}

      {state.step === 'failed' && (
        <div className="import-step">
          <ErrorState
            title={`Import failed (${state.safeCode})`}
            description={state.message}
          />
          <div className="import-actions">
            <Button variant="quiet" onClick={workflow.restart}>
              Start over
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
