import { useId, useState } from 'react';

import { isPositivelyBlocked } from '../../../shared/contactPresentation';
import type { OutboundAuthorizationReasonCode } from '../../../shared/contracts/commonContract';
import type {
  ContactMethod,
  LeadDetail,
} from '../../../shared/contracts/leadDetailContract';
import { humanizeEnumLabel } from '../../../shared/displayText';
import { Button } from '../../components/Button';
import { StatusBadge } from '../../components/StatusBadge';

export type ContactEvidenceCardProps = {
  detail: LeadDetail;
  primary: ContactMethod | null;
  alternatives: readonly ContactMethod[];
  onSelectOutbound(channel: 'call' | 'text', contact: ContactMethod): void;
};

const OWNERSHIP_LABELS: Record<ContactMethod['ownershipState'], string> = {
  verified_person: 'Verified for this person',
  vendor_candidate: 'Vendor candidate',
  conflicting_identity: 'Conflicting identity',
  unknown: 'Unknown ownership',
};

// Display the existing authorization decision. Do not evaluate compliance here.
const REFUSAL_LABELS: Record<OutboundAuthorizationReasonCode, string> = {
  person_or_handle_opted_out: 'This person or contact opted out.',
  channel_contact_kind_mismatch: 'This contact does not support this channel.',
  contact_validation_unusable: 'Phone validation does not permit outreach.',
  federal_status_unknown: 'Federal DNC status is unknown.',
  federal_dnc_listed: 'Federal DNC listed.',
  federal_evidence_stale: 'Federal scrub evidence has expired.',
  federal_area_code_mismatch: 'Area code is not covered by federal scrub evidence.',
  tcpa_status_unknown: 'TCPA status is unknown.',
  tcpa_blocked: 'TCPA blocked.',
  jurisdiction_unknown: 'Recipient jurisdiction is unknown.',
  jurisdiction_blocked: 'Recipient jurisdiction blocks outreach.',
  state_registration_missing: 'State registration is missing.',
  state_dnc_subscription_missing: 'State DNC subscription is missing.',
  state_consent_rule_unknown: 'State consent requirements are unknown.',
  outside_recipient_window: 'Outside recipient calling window.',
};

function EvidenceTime({ value }: { value: string | null }) {
  if (value === null) return <>Unknown</>;
  return (
    <time dateTime={value}>
      {new Date(value).toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit', second: '2-digit',
        timeZone: 'UTC', timeZoneName: 'short',
      })}
    </time>
  );
}

type PhoneEvidenceProps = Pick<ContactEvidenceCardProps, 'detail' | 'onSelectOutbound'> & {
  contact: ContactMethod;
};

export function phoneActionHelp(detail: LeadDetail, contact: ContactMethod, channel: 'call' | 'text'): string | null {
  const reason = channel === 'call' ? contact.compliance?.callRefusalReason : contact.compliance?.textRefusalReason;
  return detail.optedOut ? 'This person opted out.'
    : contact.validationState !== 'valid' ? `Phone validation is ${contact.validationState}.`
      : contact.compliance === null ? 'Compliance unknown. Outreach is disabled.'
        : reason === null ? null : REFUSAL_LABELS[reason!];
}

function PhoneAction({
  detail, contact, channel, onSelectOutbound,
}: PhoneEvidenceProps & { channel: 'call' | 'text' }) {
  const helpId = useId();
  const help = phoneActionHelp(detail, contact, channel);

  return (
    <div className="contact-evidence__action">
      <Button
        variant="quiet"
        disabled={help !== null}
        aria-describedby={help === null ? undefined : helpId}
        onClick={() => onSelectOutbound(channel, contact)}
      >
        {channel === 'call' ? 'Call' : 'Text'} {contact.value}
      </Button>
      {help !== null && (
        <span id={helpId} className="contact-evidence__refusal">{help}</span>
      )}
    </div>
  );
}

function PhoneEvidence({ detail, contact, onSelectOutbound }: PhoneEvidenceProps) {
  const titleId = useId();
  const positivelyBlocked = isPositivelyBlocked(contact.compliance?.status ?? 'compliance_unknown');

  return (
    <article
      tabIndex={0}
      aria-labelledby={titleId}
      className={`contact-evidence__row${positivelyBlocked ? ' contact-evidence__row--blocked' : ''}`}
    >
      <h4 id={titleId} className="contact-evidence__number">{contact.value}</h4>
      <dl className="contact-evidence__metadata">
        <div><dt>Source</dt><dd>{contact.sourceLabel ?? 'Unknown source'}</dd></div>
        <div><dt>Vendor rank</dt><dd>{contact.vendorRank ?? 'Unknown'}</dd></div>
        <div><dt>Phone kind</dt><dd>{contact.phoneKind === null ? 'Unknown' : humanizeEnumLabel(contact.phoneKind)}</dd></div>
        <div><dt>Ownership</dt><dd>{OWNERSHIP_LABELS[contact.ownershipState]}</dd></div>
        <div><dt>Validation</dt><dd>{humanizeEnumLabel(contact.validationState)}</dd></div>
        <div>
          <dt>Compliance</dt>
          <dd>
            <StatusBadge
              tone={positivelyBlocked ? 'danger' : contact.compliance?.status === 'verified_clear' ? 'neutral' : 'warning'}
              label={contact.compliance?.label ?? 'Compliance unknown'}
            />
          </dd>
        </div>
        <div><dt>Evidence observed</dt><dd><EvidenceTime value={contact.evidenceObservedAt} /></dd></div>
        <div><dt>Compliance expires</dt><dd><EvidenceTime value={contact.compliance?.expiresAt ?? null} /></dd></div>
      </dl>
      <div className="contact-evidence__actions">
        <PhoneAction detail={detail} contact={contact} channel="call" onSelectOutbound={onSelectOutbound} />
        <PhoneAction detail={detail} contact={contact} channel="text" onSelectOutbound={onSelectOutbound} />
      </div>
    </article>
  );
}

/** Presentation only. Selection is shared with main, and rank never grants permission. */
export function ContactEvidenceCard({
  detail, primary, alternatives, onSelectOutbound,
}: ContactEvidenceCardProps) {
  const [expanded, setExpanded] = useState(false);
  const alternativesId = useId();

  return (
    <div className="contact-evidence">
      {primary === null ? (
        <p className="contact-evidence__empty">
          {alternatives.length === 0
            ? 'No phone candidates on file.'
            : 'No recommended phone candidate. All numbers are positively blocked.'}
        </p>
      ) : (
        <section aria-label="Primary phone candidate" className="contact-evidence__primary">
          <p className="contact-evidence__label">Primary candidate</p>
          <PhoneEvidence detail={detail} contact={primary} onSelectOutbound={onSelectOutbound} />
        </section>
      )}
      {alternatives.length > 0 && (
        <>
          <Button
            variant="quiet"
            aria-expanded={expanded}
            aria-controls={alternativesId}
            onClick={() => setExpanded((value) => !value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                // Handle activation once, without a second native click or page scroll.
                event.preventDefault();
                if (event.key === 'Enter' && !event.repeat) event.currentTarget.click();
              }
            }}
            onKeyUp={(event) => {
              if (event.key === ' ') {
                event.preventDefault();
                event.currentTarget.click();
              }
            }}
          >
            {expanded ? 'Hide' : 'Show'} {alternatives.length} alternative {alternatives.length === 1 ? 'number' : 'numbers'}
          </Button>
          <div id={alternativesId} hidden={!expanded} className="contact-evidence__alternatives">
            {expanded && alternatives.map((contact) => (
              <PhoneEvidence key={contact.id} detail={detail} contact={contact} onSelectOutbound={onSelectOutbound} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
