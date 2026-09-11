import { useEffect } from 'react';
import { useOverlayLayers } from '../../app/overlayLayers';
import { Button } from '../../components/Button';
import type { BulkEdit, LeadSaveResult } from './useLeadMutations';

export type LeadsBulkBarProps = {
  count: number;
  outsideCount?: number;
  editor: BulkEdit | null;
  pending: boolean;
  onStart(): void;
  onChange(value: string): void;
  onCancel(): void;
  onSetOrganization(value: string | null): Promise<LeadSaveResult>;
  onClear(): void;
};

/** Controlled route-owned bulk input. Only an acknowledged owner may clear it. */
export function LeadsBulkBar({ count, outsideCount = 0, editor, pending, onStart, onChange, onCancel, onSetOrganization, onClear }: LeadsBulkBarProps) {
  const layers = useOverlayLayers();
  useEffect(() => {
    if (editor) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pending && !event.defaultPrevented && !event.isComposing && !event.repeat && !layers.hasOpenLayer()) onClear();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [editor, pending, onClear, layers]);
  const submit = () => {
    if (pending || !editor) return;
    void onSetOrganization(editor.draft.trim() || null);
  };
  return <div className="leads-bulk-bar" role="toolbar" aria-label="Bulk actions">
    <span className="leads-bulk-bar__count numeric">{count} selected{outsideCount > 0 ? ` · ${outsideCount} outside view` : ''}</span>
    <div className="leads-bulk-bar__actions">
    {editor ? <>
      <input className="leads-bulk-bar__input" type="text" aria-label={`Organization for ${count} selected`}
        value={editor.draft} readOnly={pending} autoFocus onChange={event => onChange(event.target.value)}
        onKeyDown={event => {
          if (event.metaKey || event.ctrlKey || event.altKey) return;
          event.stopPropagation();
          if (event.defaultPrevented || event.nativeEvent.isComposing || event.repeat || layers.hasOpenLayer()) return;
          if (event.key === 'Enter') { event.preventDefault(); submit(); }
          else if (event.key === 'Escape' && !pending) onCancel();
        }} />
      <Button variant="quiet" disabled={pending} onClick={submit}>Save organization</Button>
      <Button variant="quiet" disabled={pending} onClick={onCancel}>Cancel organization</Button>
    </> : <Button variant="quiet" disabled={pending} onClick={onStart}>Set organization</Button>}
    <Button variant="quiet" disabled={pending} onClick={onClear}>Clear</Button>
    </div>
    {editor?.error && <p className="leads-bulk-bar__error" role="alert">{editor.error}</p>}
  </div>;
}
