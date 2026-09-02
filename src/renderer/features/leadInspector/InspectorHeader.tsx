import { ExternalLink, X } from 'lucide-react';

import type { LeadDetail } from '../../../shared/contracts/leadDetailContract';
import { humanizeEnumLabel, titleCaseDisplayName } from '../../../shared/displayText';
import { Avatar } from '../../components/Avatar';
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

/**
 * Identity strip: avatar and name stay on one truncating line with the two
 * icon exits top-right; the stage pill and segment · source context sit on
 * their own line below. Nothing here ever wraps.
 */
export function InspectorHeader({
  detail,
  onClose,
  onOpenFullPage,
}: InspectorHeaderProps) {
  const name = titleCaseDisplayName(detail.personName);

  return (
    <header className="lead-inspector__header">
      <div className="lead-inspector__identity">
        <Avatar name={detail.personName} />
        <h2 className="lead-inspector__name" title={name}>
          {name}
        </h2>
        <div className="lead-inspector__header-actions">
          {onOpenFullPage !== undefined && (
            <IconButton
              label="Open full page"
              icon={ExternalLink}
              onClick={onOpenFullPage}
            />
          )}
          {onClose !== undefined && (
            <IconButton label="Close inspector" icon={X} onClick={onClose} />
          )}
        </div>
      </div>
      <div className="lead-inspector__subline">
        <StatusPill tone={detail.optedOut ? 'danger' : 'neutral'}>
          {detail.optedOut ? 'Opted out' : humanizeEnumLabel(detail.stage)}
        </StatusPill>
        <p className="lead-inspector__meta">
          {detail.organizationLabel !== null && (
            <span>{detail.organizationLabel} · </span>
          )}
          <span>{SEGMENT_LABELS[detail.segment]}</span>
          <span> · via {detail.sourceLabel}</span>
        </p>
      </div>
    </header>
  );
}
