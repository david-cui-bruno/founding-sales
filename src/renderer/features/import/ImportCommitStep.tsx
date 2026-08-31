import { useId } from 'react';

import { Button } from '../../components/Button';
import type { ImportSourceChannel } from './useImportWorkflow';

export const SOURCE_CHANNEL_OPTIONS: { value: ImportSourceChannel; label: string }[] = [
  { value: 'frbo', label: 'FRBO' },
  { value: 'registry', label: 'Registry' },
  { value: 'rireig', label: 'RIREIG' },
  { value: 'referral', label: 'Referral' },
  { value: 'inbound_demo', label: 'Inbound demo' },
  { value: 'community', label: 'Community' },
  { value: 'custom', label: 'Custom' },
];

export type ImportCommitStepProps = {
  rowCount: number;
  sourceChannel: ImportSourceChannel;
  referredByPersonId: string | null;
  commitDisabled: boolean;
  onSourceChannelChange(channel: ImportSourceChannel): void;
  onReferredByChange(personId: string | null): void;
  onCommit(): void;
};

/**
 * Final commit step: source channel attribution, referral resolution, and the
 * single explicit "Import N rows" action. The button stays disabled while any
 * blocker remains, so the handler never needs to re-guard user intent.
 */
export function ImportCommitStep({
  rowCount,
  sourceChannel,
  referredByPersonId,
  commitDisabled,
  onSourceChannelChange,
  onReferredByChange,
  onCommit,
}: ImportCommitStepProps) {
  const channelId = useId();
  const referrerId = useId();
  const importLabel = rowCount === 1 ? 'Import 1 row' : `Import ${rowCount} rows`;

  return (
    <div className="import-step">
      <div className="import-field">
        <label htmlFor={channelId}>Source channel</label>
        <select
          id={channelId}
          value={sourceChannel}
          onChange={(event) => {
            onSourceChannelChange(event.target.value as ImportSourceChannel);
          }}
        >
          {SOURCE_CHANNEL_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      {sourceChannel === 'referral' && (
        <div className="import-field">
          <label htmlFor={referrerId}>Referred by person ID</label>
          <input
            id={referrerId}
            type="text"
            value={referredByPersonId ?? ''}
            onChange={(event) => {
              onReferredByChange(
                event.target.value.trim() === '' ? null : event.target.value,
              );
            }}
          />
        </div>
      )}
      <div className="import-actions">
        <Button onClick={onCommit} disabled={commitDisabled}>
          {importLabel}
        </Button>
      </div>
    </div>
  );
}
