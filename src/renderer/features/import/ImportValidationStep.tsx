import type {
  ImportPreview,
} from '../../../shared/contracts/importContract';
import type { DuplicateDecisionDraft } from './useImportWorkflow';

export type ImportValidationErrorsProps = {
  errors: ImportPreview['errors'];
};

/**
 * Validation table: row, field, and safe code per failure. Messages are the
 * domain's human copy; stack traces and internal paths never reach here.
 */
export function ImportValidationErrors({ errors }: ImportValidationErrorsProps) {
  if (errors.length === 0) return null;
  return (
    <table className="import-table">
      <caption>Rows that block this import</caption>
      <thead>
        <tr>
          <th scope="col">Row</th>
          <th scope="col">Field</th>
          <th scope="col">Code</th>
          <th scope="col">Problem</th>
        </tr>
      </thead>
      <tbody>
        {errors.map((error, index) => (
          <tr key={`${error.rowNumber}-${error.field ?? 'row'}-${index}`}>
            <td>{error.rowNumber}</td>
            <td>{error.field ?? '—'}</td>
            <td>{error.code}</td>
            <td>{error.message}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export type ImportDuplicateDecisionsProps = {
  duplicateCandidates: ImportPreview['duplicateCandidates'];
  decisions: Record<number, DuplicateDecisionDraft>;
  onDecisionChange(rowNumber: number, decision: DuplicateDecisionDraft): void;
};

/**
 * Duplicate resolution list: every candidate row requires an explicit merge,
 * create, or skip choice, and merge requires picking the exact target person.
 */
export function ImportDuplicateDecisions({
  duplicateCandidates,
  decisions,
  onDecisionChange,
}: ImportDuplicateDecisionsProps) {
  if (duplicateCandidates.length === 0) return null;
  return (
    <fieldset className="import-duplicates">
      <legend>Possible duplicates</legend>
      {duplicateCandidates.map((candidate) => {
        const decision = decisions[candidate.rowNumber];
        const decisionValue = decision?.decision ?? '';
        return (
          <div className="import-duplicate" key={candidate.rowNumber}>
            <p className="import-duplicate__reason">
              Row {candidate.rowNumber}: {candidate.reason}
            </p>
            <div className="import-field">
              <label htmlFor={`duplicate-decision-${candidate.rowNumber}`}>
                Duplicate action for row {candidate.rowNumber}
              </label>
              <select
                id={`duplicate-decision-${candidate.rowNumber}`}
                value={decisionValue}
                onChange={(event) => {
                  const next = event.target.value as 'merge' | 'create' | 'skip' | '';
                  if (next === '') return;
                  onDecisionChange(candidate.rowNumber, {
                    decision: next,
                    personId: null,
                  });
                }}
              >
                <option value="" disabled>
                  Choose an action
                </option>
                <option value="merge">Merge into existing person</option>
                <option value="create">Create a new person</option>
                <option value="skip">Skip this row</option>
              </select>
            </div>
            {decisionValue === 'merge' && (
              <div className="import-field">
                <label htmlFor={`duplicate-target-${candidate.rowNumber}`}>
                  Merge target for row {candidate.rowNumber}
                </label>
                <select
                  id={`duplicate-target-${candidate.rowNumber}`}
                  value={decision?.personId ?? ''}
                  onChange={(event) => {
                    onDecisionChange(candidate.rowNumber, {
                      decision: 'merge',
                      personId: event.target.value === '' ? null : event.target.value,
                    });
                  }}
                >
                  <option value="" disabled>
                    Choose the person
                  </option>
                  {candidate.personIds.map((personId) => (
                    <option key={personId} value={personId}>
                      {personId}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        );
      })}
    </fieldset>
  );
}

export type ImportValidationStepProps = {
  preview: ImportPreview;
  decisions: Record<number, DuplicateDecisionDraft>;
  onDecisionChange(rowNumber: number, decision: DuplicateDecisionDraft): void;
};

/** Validation summary plus the blocking-error and duplicate resolution UI. */
export function ImportValidationStep({
  preview,
  decisions,
  onDecisionChange,
}: ImportValidationStepProps) {
  const readyLabel = preview.validCount === 1
    ? '1 row ready'
    : `${preview.validCount} rows ready`;

  return (
    <div className="import-step">
      <p className="import-summary" role="status">
        {readyLabel}
        {preview.errors.length > 0 &&
          `, ${preview.errors.length} blocking ${preview.errors.length === 1 ? 'error' : 'errors'}`}
      </p>
      <ImportValidationErrors errors={preview.errors} />
      <ImportDuplicateDecisions
        duplicateCandidates={preview.duplicateCandidates}
        decisions={decisions}
        onDecisionChange={onDecisionChange}
      />
    </div>
  );
}
