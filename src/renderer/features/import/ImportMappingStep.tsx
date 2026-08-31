import { useId } from 'react';

import type {
  ImportField,
  ImportMapping,
} from '../../../shared/contracts/importContract';

export const IMPORT_FIELD_OPTIONS: { value: ImportField; label: string }[] = [
  { value: 'ignore', label: 'Ignore' },
  { value: 'person_name', label: 'Person name' },
  { value: 'phone', label: 'Phone' },
  { value: 'email', label: 'Email' },
  { value: 'organization', label: 'Organization' },
  { value: 'property_address', label: 'Property address' },
  { value: 'doors', label: 'Doors' },
  { value: 'source', label: 'Source' },
  { value: 'segment', label: 'Segment' },
  { value: 'notes', label: 'Notes' },
];

export type ImportMappingStepProps = {
  columns: string[];
  mapping: ImportMapping;
  mappingError: string | null;
  onMappingChange(mapping: ImportMapping): void;
};

/**
 * Column mapping step: exactly one labelled select per source column so the
 * mapping is fully keyboard- and screen-reader-operable. Invalid mappings
 * surface a polite blocking message instead of a round trip.
 */
export function ImportMappingStep({
  columns,
  mapping,
  mappingError,
  onMappingChange,
}: ImportMappingStepProps) {
  const baseId = useId();

  return (
    <fieldset className="import-mapping">
      <legend>Map columns</legend>
      {columns.map((column, index) => {
        const selectId = `${baseId}-column-${index}`;
        return (
          <div className="import-field" key={column}>
            <label htmlFor={selectId}>{column}</label>
            <select
              id={selectId}
              value={mapping[column] ?? 'ignore'}
              onChange={(event) => {
                onMappingChange({
                  ...mapping,
                  [column]: event.target.value as ImportField,
                });
              }}
            >
              {IMPORT_FIELD_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        );
      })}
      {mappingError !== null && (
        <p className="import-blocking-message" role="alert">
          {mappingError}
        </p>
      )}
    </fieldset>
  );
}
