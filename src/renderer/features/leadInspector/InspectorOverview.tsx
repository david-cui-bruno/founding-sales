import type {
  BeginOutboundRequest,
  CloudScoreOverrideRequest,
  ConfirmTransitionRequest,
  ContactMethod,
  LeadDetail,
} from '../../../shared/contracts/leadDetailContract';
import { humanizeEnumLabel } from '../../../shared/displayText';
import { Button } from '../../components/Button';
import { StatusPill } from '../../components/StatusPill';
import {
  cloudSignalLabel,
  formatCloudChip,
} from '../leads/cloudSignalLabels';

const OPT_OUT_REASON =
  'This person opted out. Outreach is permanently disabled.';

export type InspectorOverviewProps = {
  detail: LeadDetail;
  onBeginOutbound(request: BeginOutboundRequest): void;
  onConfirmTransition(request: ConfirmTransitionRequest): void;
  onOverrideCloudScore(request: CloudScoreOverrideRequest): void;
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

  return (
    <Button
      variant="quiet"
      disabled={detail.optedOut}
      onClick={() =>
        onBeginOutbound({
          channel,
          personId: detail.personId,
          salesCycleId: detail.salesCycleId,
          contactMethodId: contact.id,
        })
      }
    >
      {verb} {contact.value}
    </Button>
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
  onOverrideCloudScore,
}: InspectorOverviewProps) {
  const context = detail.priorityContext;

  return (
    <div className="lead-inspector__overview">
      <div className="lead-inspector__bands">
        <section
          className="lead-inspector__band"
          aria-label="Fit"
        >
          <h3 className="lead-inspector__band-title">Fit</h3>
          {context === null ? (
            <p>Not yet evaluated.</p>
          ) : (
            <p>
              <StatusPill tone={fitTone(context.fitBand)}>
                {humanizeEnumLabel(context.fitBand)}
              </StatusPill>{' '}
              {context.fitPoints}/30 fit points
            </p>
          )}
        </section>
        <section
          className="lead-inspector__band"
          aria-label="Timing"
        >
          <h3 className="lead-inspector__band-title">Timing</h3>
          {context === null ? (
            <p>Not yet evaluated.</p>
          ) : (
            <p>
              <StatusPill tone={timingTone(context.timingBand)}>
                {humanizeEnumLabel(context.timingBand)}
              </StatusPill>{' '}
              {context.timingValue}/40 timing value
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
                <li key={reason.signal}>
                  {cloudSignalLabel(reason.signal)}
                  {' '}
                  <span className="lead-inspector__cloud-contribution">
                    +{Math.round(reason.contribution)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="lead-inspector__cloud-override">
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
            {detail.nextAction.overdue && (
              <StatusPill tone="urgent">overdue</StatusPill>
            )}{' '}
            {detail.nextAction.label}
          </p>
          {detail.stage === 'unreviewed' && (
            <Button
              onClick={() =>
                onConfirmTransition({
                  transition: 'review_to_ready',
                  salesCycleId: detail.salesCycleId,
                  expectedRevision: detail.revision,
                })
              }
            >
              Confirm ready
            </Button>
          )}
        </section>
      )}

      <section aria-label="Reach out" className="lead-inspector__outbound">
        <h3 className="lead-inspector__band-title">Reach out</h3>
        {detail.optedOut && (
          <p className="lead-inspector__opt-out-reason">{OPT_OUT_REASON}</p>
        )}
        <div className="lead-inspector__outbound-buttons">
          {detail.phones.map((phone) => (
            <span key={phone.id} className="lead-inspector__outbound-pair">
              <OutboundButton
                detail={detail}
                channel="call"
                contact={phone}
                onBeginOutbound={onBeginOutbound}
              />
              <OutboundButton
                detail={detail}
                channel="text"
                contact={phone}
                onBeginOutbound={onBeginOutbound}
              />
            </span>
          ))}
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
