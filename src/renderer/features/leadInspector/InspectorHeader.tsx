import { X } from 'lucide-react';

import type { LeadDetail } from '../../../shared/contracts/leadDetailContract';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { IconButton } from '../../components/IconButton';
import { StatusPill } from '../../components/StatusPill';

const SEGMENT_LABELS: Record<LeadDetail['segment'], string> = {
  hot: 'Hot',
  cold: 'Cold',
  warm: 'Warm',
};

export type InspectorHeaderProps = {
  detail: LeadDetail;
  onClose?: () => void;
  onOpenFullPage?: () => void;
};

/** Identity strip: who the lead is, where they came from, and exits. */
export function InspectorHeader({
  detail,
  onClose,
  onOpenFullPage,
}: InspectorHeaderProps) {
  return (
    <header className="lead-inspector__header">
      <div className="lead-inspector__identity">
        <Avatar name={detail.personName} />
        <div>
          <h2 className="lead-inspector__name">{detail.personName}</h2>
          <p className="lead-inspector__meta">
            {detail.organizationLabel !== null && (
              <span>{detail.organizationLabel} · </span>
            )}
            <span>{SEGMENT_LABELS[detail.segment]}</span>
            <span> · via {detail.sourceLabel}</span>
          </p>
        </div>
      </div>
      <div className="lead-inspector__header-actions">
        <StatusPill tone={detail.optedOut ? 'danger' : 'neutral'}>
          {detail.optedOut ? 'opted out' : detail.stage}
        </StatusPill>
        {onOpenFullPage !== undefined && (
          <Button variant="quiet" onClick={onOpenFullPage}>
            Open full page
          </Button>
        )}
        {onClose !== undefined && (
          <IconButton label="Close inspector" icon={X} onClick={onClose} />
        )}
      </div>
    </header>
  );
}
