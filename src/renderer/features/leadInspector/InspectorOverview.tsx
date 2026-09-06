import { useState } from 'react';

import { selectPrimaryPhone } from '../../../shared/contactPresentation';
import type {
  FindContactInfoReceipt,
  FindContactInfoRequest,
} from '../../../shared/contracts/enrichmentRequestContract';
import type {
  BeginOutboundRequest,
  CloudScoreOverrideRequest,
  ConfirmTransitionRequest,
  ContactMethod,
  DismissLeadRequest,
  LeadDetail,
  QualificationGateReason,
} from '../../../shared/contracts/leadDetailContract';
import { humanizeEnumLabel } from '../../../shared/displayText';
import { Button } from '../../components/Button';
import { Select } from '../../components/Select';
import { StatusPill } from '../../components/StatusPill';
import {
  cloudSignalLabel,
  formatCloudChip,
} from '../leads/cloudSignalLabels';
import { ContactEvidenceCard } from './ContactEvidenceCard';

const OPT_OUT_REASON =
  'This person opted out. Outreach is permanently disabled.';

/** Founder-facing labels for the exact qualification gate reasons. */
const DISMISS_REASON_OPTIONS: ReadonlyArray<{
  value: QualificationGateReason;
  label: string;
}> = [
  { value: 'out_of_area', label: 'Out of area' },
  { value: 'no_relevant_decision_relationship', label: 'Not a decision maker' },
  { value: 'institutional_outside_icp', label: 'Institutional, outside ICP' },
  { value: 'harmful_operator', label: 'Harmful operator' },
  { value: 'non_paying_operator', label: 'Won\u2019t pay for tools' },
  { value: 'unresolved_duplicate', label: 'Unresolved duplicate' },
];

export type InspectorOverviewProps = {
  detail: LeadDetail;
  onBeginOutbound(request: BeginOutboundRequest): void;
  onConfirmTransition(request: ConfirmTransitionRequest): void;
  onDismissLead(request: DismissLeadRequest): void;
  onOverrideCloudScore(request: CloudScoreOverrideRequest): void;
  onFindContactInfo?(request: FindContactInfoRequest): Promise<FindContactInfoReceipt>;
};

const fitTone = (band: string) => (band === 'high' ? 'urgent' : 'neutral');
const timingTone = (band: string) => (band === 'hot' ? 'urgent' : 'neutral');

function OutboundButton({
  detail,
  channel,
  contact,
  onBeginOutbound,
}: {
  detail: LeadDetail;
  channel: BeginOutboundRequest['channel'];
  contact: ContactMethod;
  onBeginOutbound(request: BeginOutboundRequest): void;
}) {
  const verb = channel === 'call' ? 'Call' : channel === 'text' ? 'Text' : 'Email';
  const refusalReason = contact.kind === 'phone' && contact.compliance !== null
    ? channel === 'call'
      ? contact.compliance.callRefusalReason
      : channel === 'text'
        ? contact.compliance.textRefusalReason
        : null
    : null;
  const blocked = refusalReason !== null;
  const helpId = blocked ? `${contact.id}-${channel}-compliance-help` : undefined;

  return (
    <>
      <Button
        variant="quiet"
        disabled={detail.optedOut || blocked}
        aria-describedby={helpId}
        onClick={() => {
          void Promise.resolve(onBeginOutbound({
            channel,
            personId: detail.personId,
            salesCycleId: detail.salesCycleId,
            contactMethodId: contact.id,
          })).catch(() => {
            // The main-process final gate is authoritative even after an
            // allowed advisory snapshot. Keep the stale action from advancing.
          });
        }}
      >
        {verb} {contact.value}
      </Button>
      {helpId !== undefined && (
        <span id={helpId} className="lead-inspector__outbound-refusal">
          {refusalReason}
        </span>
      )}
    </>
  );
}

/**
 * The explicit review flow for unreviewed leads: one primary Mark ready and
 * one secondary Dismiss that requires an exact qualification gate reason.
 */
function ReviewSection({
  detail,
  onConfirmTransition,
  onDismissLead,
}: {
  detail: LeadDetail;
  onConfirmTransition(request: ConfirmTransitionRequest): void;
  onDismissLead(request: DismissLeadRequest): void;
}) {
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState<QualificationGateReason>('out_of_area');

  return (
    <section aria-label="Review this lead" className="lead-inspector__review">
      <h3 className="lead-inspector__band-title">Review this lead</h3>
      <div className="lead-inspector__review-actions">
        <Button
          onClick={() =>
            onConfirmTransition({
              transition: 'review_to_ready',
              salesCycleId: detail.salesCycleId,
              expectedRevision: detail.revision,
            })
          }
        >
          Mark ready
        </Button>
        {!dismissing && (
          <Button variant="quiet" onClick={() => setDismissing(true)}>
            Dismiss
          </Button>
        )}
      </div>
      {dismissing && (
        <div className="lead-inspector__dismiss">
          <Select<QualificationGateReason>
            label="Dismissal reason"
            options={DISMISS_REASON_OPTIONS}
            value={reason}
            onChange={setReason}
          />
          <div className="lead-inspector__review-actions">
            <Button
              variant="danger"
              onClick={() =>
                onDismissLead({
                  salesCycleId: detail.salesCycleId,
                  personId: detail.personId,
                  qualificationGateReason: reason,
                  expectedRevision: detail.revision,
                })
              }
            >
              Confirm dismiss
            </Button>
            <Button variant="quiet" onClick={() => setDismissing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

/** Founder-facing receipt lines for the Find contact info refusals. */
const FIND_CONTACT_RECEIPTS: Readonly<Record<NonNullable<FindContactInfoReceipt['refusalReason']> | 'written', string>> = {
  written: 'Contact info requested. Results arrive with the next sync.',
  qualification_required: 'Founder qualification is required.',
  fit_gate_failed: 'Medium or High Fit is required.',
  identity_or_address_missing: 'A verified identity, cloud link, and usable property address are required.',
  direct_contact_exists: 'A usable verified contact is already on file.',
  suppression_blocked: 'Opt-out or suppression prevents contact enrichment.',
  rate_limited: 'Already requested in the last 30 days.',
  credentials_unavailable: 'Sourcing credentials are not provisioned.',
};

/**
 * Domain-eligible leads can request enrichment regardless of candidate count. One
 * explicit click writes one request; the receipt renders inline (no toast).
 */
function FindContactInfoSection({
  detail,
  onFindContactInfo,
}: {
  detail: LeadDetail;
  onFindContactInfo(request: FindContactInfoRequest): Promise<FindContactInfoReceipt>;
}) {
  const [receipt, setReceipt] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const { eligible, refusalReason } = detail.findContactEligibility;

  return (
    <div className="lead-inspector__find-contact">
      <Button
        variant="quiet"
        disabled={!eligible || requesting || receipt !== null}
        onClick={() => {
          setRequesting(true);
          onFindContactInfo({ personId: detail.personId }).then(
            (result) => {
              setRequesting(false);
              setReceipt(
                result.written
                  ? FIND_CONTACT_RECEIPTS.written
                  : result.refusalReason === null
                    ? 'The request was not submitted.'
                    : FIND_CONTACT_RECEIPTS[result.refusalReason],
              );
            },
            () => {
              setRequesting(false);
              setReceipt('The request failed. Try again later.');
            },
          );
        }}
      >
        Find contact info
      </Button>
      {!eligible && refusalReason !== null && (
        <p className="lead-inspector__find-contact-reason">
          {FIND_CONTACT_RECEIPTS[refusalReason]}
        </p>
      )}
      {receipt !== null && (
        <p className="lead-inspector__find-contact-reason" role="status">
          {receipt}
        </p>
      )}
    </div>
  );
}

/**
 * Evidence-first summary. Fit and Timing stay separate labelled regions and
 * are never merged into one synthesized score.
 */
export function InspectorOverview({
  detail,
  onBeginOutbound,
  onConfirmTransition,
  onDismissLead,
  onOverrideCloudScore,
  onFindContactInfo,
}: InspectorOverviewProps) {
  const context = detail.priorityContext;
  const { primary, alternatives } = selectPrimaryPhone(detail.phones);

  return (
    <div className="lead-inspector__overview">
      {detail.stage === 'unreviewed' && (
        <ReviewSection
          detail={detail}
          onConfirmTransition={onConfirmTransition}
          onDismissLead={onDismissLead}
        />
      )}

      <div className="lead-inspector__bands">
        <section className="lead-inspector__band" aria-label="Fit">
          <h3 className="lead-inspector__band-label">Fit</h3>
          {context === null ? (
            <p className="lead-inspector__band-empty">Not yet evaluated</p>
          ) : (
            <p className="lead-inspector__band-row">
              <span className="lead-inspector__band-value">
                {context.fitPoints}
                <span className="lead-inspector__band-denominator">/30</span>
              </span>
              <StatusPill tone={fitTone(context.fitBand)}>
                {humanizeEnumLabel(context.fitBand)}
              </StatusPill>
            </p>
          )}
        </section>
        <section className="lead-inspector__band" aria-label="Timing">
          <h3 className="lead-inspector__band-label">Timing</h3>
          {context === null ? (
            <p className="lead-inspector__band-empty">Not yet evaluated</p>
          ) : (
            <p className="lead-inspector__band-row">
              <span className="lead-inspector__band-value">
                {context.timingValue}
                <span className="lead-inspector__band-denominator">/40</span>
              </span>
              <StatusPill tone={timingTone(context.timingBand)}>
                {humanizeEnumLabel(context.timingBand)}
              </StatusPill>
            </p>
          )}
        </section>
      </div>

      {context !== null && (
        <dl className="lead-inspector__facts">
          <div>
            <dt>Reachability</dt>
            <dd>{humanizeEnumLabel(context.reachability)}</dd>
          </div>
          <div>
            <dt>Data confidence</dt>
            <dd>{context.dataConfidence}/10</dd>
          </div>
          <div>
            <dt>Priority</dt>
            <dd>{context.priority}</dd>
          </div>
        </dl>
      )}

      {detail.priorityReasons.length > 0 && (
        <section aria-label="Why this lead">
          <h3 className="lead-inspector__band-title">Why this lead</h3>
          <ul className="lead-inspector__reasons">
            {detail.priorityReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </section>
      )}

      {detail.cloudScores !== null && (
        <section aria-label="Cloud scores" className="lead-inspector__cloud">
          <h3 className="lead-inspector__band-title">Cloud scores</h3>
          <p>
            <span className="lead-inspector__cloud-chip">
              {formatCloudChip(detail.cloudScores.scores)}
            </span>
          </p>
          {detail.cloudScores.reasons.length > 0 && (
            <ul
              className="lead-inspector__reasons"
              aria-label="Top cloud signals"
            >
              {detail.cloudScores.reasons.map((reason) => (
                <li
                  key={reason.signal}
                  className={
                    Math.round(reason.contribution) === 0
                      ? 'lead-inspector__cloud-reason--muted'
                      : undefined
                  }
                >
                  {cloudSignalLabel(reason.signal)}
                  {Math.round(reason.contribution) !== 0 && (
                    <>
                      {' '}
                      <span className="lead-inspector__cloud-contribution">
                        +{Math.round(reason.contribution)}
                      </span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="lead-inspector__cloud-override">
            <p className="lead-inspector__cloud-explainer">
              Feedback trains scoring
            </p>
            <div className="lead-inspector__cloud-override-buttons">
              <Button
                variant="quiet"
                onClick={() => onOverrideCloudScore({
                  personId: detail.personId,
                  direction: 'up',
                })}
              >
                Signal too low
              </Button>
              <Button
                variant="quiet"
                onClick={() => onOverrideCloudScore({
                  personId: detail.personId,
                  direction: 'down',
                })}
              >
                Wrong signal
              </Button>
            </div>
          </div>
        </section>
      )}

      {detail.cadence !== null && (
        <p className="lead-inspector__cadence">
          {detail.cadence.name} · {detail.cadence.stepLabel} · touch{' '}
          {detail.cadence.touchIndex} of {detail.cadence.touchLimit}
        </p>
      )}

      {detail.nextAction !== null && (
        <section aria-label="Next action" className="lead-inspector__next-action">
          <h3 className="lead-inspector__band-title">Next action</h3>
          <p>
            {detail.nextAction.label}
          </p>
        </section>
      )}

      <section aria-label="Reach out" className="lead-inspector__outbound">
        <h3 className="lead-inspector__band-title">Reach out</h3>
        {detail.optedOut && (
          <p className="lead-inspector__opt-out-reason">{OPT_OUT_REASON}</p>
        )}
        <ContactEvidenceCard
          key={detail.personId}
          detail={detail}
          primary={primary}
          alternatives={alternatives}
          onBeginOutbound={onBeginOutbound}
        />
        <div className="lead-inspector__outbound-buttons">
          {detail.emails.map((email) => (
            <OutboundButton
              key={email.id}
              detail={detail}
              channel="email"
              contact={email}
              onBeginOutbound={onBeginOutbound}
            />
          ))}
        </div>
        {detail.cloudLinked && onFindContactInfo !== undefined && (
          <FindContactInfoSection
            detail={detail}
            onFindContactInfo={onFindContactInfo}
          />
        )}
      </section>

      {detail.propertySummaries.length > 0 && (
        <section aria-label="Properties at a glance">
          <h3 className="lead-inspector__band-title">Properties</h3>
          <ul className="lead-inspector__reasons">
            {detail.propertySummaries.map((summary) => (
              <li key={summary}>{summary}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
