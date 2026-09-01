import { useEffect, useState } from 'react';

import { Button } from '../../components/Button';

export type LeadsBulkBarProps = {
  count: number;
  /** Existing leads:bulk-update field op; empty input commits null. */
  onSetOrganization(value: string | null): void;
  onClear(): void;
};

/**
 * Floating bottom-center bulk action bar, shown while at least one row is
 * checked. Exposes the contract's bulk field ops (organization_label; the
 * bulk-update union has no stage op) and clears the selection on Escape.
 * While the inline editor is open, Escape only closes the editor.
 */
export function LeadsBulkBar({
  count,
  onSetOrganization,
  onClear,
}: LeadsBulkBarProps) {
  const [editorOpen, setEditorOpen] = useState(false);
  const [value, setValue] = useState('');

  useEffect(() => {
    if (editorOpen) {
      return undefined;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClear();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [editorOpen, onClear]);

  const closeEditor = () => {
    setEditorOpen(false);
    setValue('');
  };

  return (
    <div className="leads-bulk-bar" role="toolbar" aria-label="Bulk actions">
      <span className="leads-bulk-bar__count numeric">{count} selected</span>
      {editorOpen ? (
        <input
          className="leads-bulk-bar__input"
          type="text"
          aria-label={`Organization for ${count} selected`}
          value={value}
          autoFocus
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') {
              const trimmed = value.trim();
              onSetOrganization(trimmed === '' ? null : trimmed);
              closeEditor();
            } else if (event.key === 'Escape') {
              closeEditor();
            }
          }}
        />
      ) : (
        <Button variant="quiet" onClick={() => setEditorOpen(true)}>
          Set organization
        </Button>
      )}
      <Button variant="quiet" onClick={onClear}>
        Clear
      </Button>
    </div>
  );
}
