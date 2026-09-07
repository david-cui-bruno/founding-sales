import { useEffect, useRef, useState } from 'react';
import type { LeadDetail, ConfirmTransitionRequest, ConversationSummary } from '../../../shared/contracts/leadDetailContract';
import { Button } from '../../components/Button';
import { Select } from '../../components/Select';
import { EmptyState } from '../../components/EmptyState';
import { StatusPill } from '../../components/StatusPill';

export type InspectorConversationProps = {
  conversations: ConversationSummary[];
};

export const formatDuration = (totalSeconds: number): string => {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds}s`;
};

const formatWhen = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

/** Real recorded conversations with evidence availability, never transcripts. */
export function InspectorConversation({
  conversations,
}: InspectorConversationProps) {
  if (conversations.length === 0) {
    return (
      <EmptyState
        title="No conversations yet"
        description="Connected calls will appear here with recordings when available."
      />
    );
  }

  return (
    <ul className="lead-inspector__conversations">
      {conversations.map((conversation) => (
        <li key={conversation.id} className="lead-inspector__conversation">
          <p className="lead-inspector__timeline-summary">
            <span>{formatWhen(conversation.occurredAt)}</span>
            {' · '}
            <span>{formatDuration(conversation.durationSeconds)}</span>
          </p>
          <p className="lead-inspector__timeline-meta">
            <StatusPill
              tone={conversation.recordingAvailable ? 'positive' : 'neutral'}
            >
              {conversation.recordingAvailable ? 'recording' : 'no recording'}
            </StatusPill>{' '}
            <StatusPill
              tone={conversation.transcriptAvailable ? 'positive' : 'neutral'}
            >
              {conversation.transcriptAvailable ? 'transcript' : 'no transcript'}
            </StatusPill>
            {conversation.reviewCount > 0 && (
              <span> · reviewed {conversation.reviewCount}×</span>
            )}
          </p>
        </li>
      ))}
    </ul>
  );
}

/** Only actual activities returned for this selected Person/Cycle may be chosen. */
export function FounderConfirmation({ detail, onConfirmTransition }: {
  detail: LeadDetail; onConfirmTransition(request: ConfirmTransitionRequest): void;
}) {
  const [activityId, setActivityId] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const pending = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++; setActivityId(''); setBusy(false); setFailed(false); pending.current = false;
    return () => { generation.current++; };
  }, [detail.personId, detail.salesCycleId, detail.revision]);
  const offered = detail.stage === 'interviewed';
  const active = detail.workflowStatus === 'active' && detail.nextAction !== null
    && (offered || detail.stage === 'contacted' || detail.stage === 'ready');
  if (!active) return null;
  const evidence = detail.activities.filter(activity => !activity.markedInError
    && (offered ? ['call', 'voicemail', 'text', 'email'].includes(activity.kind) && activity.outcome === 'price_said'
      : activity.kind === 'interview' || activity.kind === 'call' && activity.outcome === 'answered'));
  const eligible = evidence.some(activity => activity.id === activityId);
  const confirm = async () => {
    if (!eligible || pending.current) return;
    const current = generation.current;
    pending.current = true; setBusy(true); setFailed(false);
    try {
      await onConfirmTransition({ transition: offered ? 'confirm_offered' : 'confirm_interviewed',
        salesCycleId: detail.salesCycleId, expectedRevision: detail.revision, suggestionActivityId: activityId });
    } catch { if (generation.current === current) setFailed(true); }
    finally { if (generation.current === current) { pending.current = false; setBusy(false); } }
  };
  return <section aria-label="Founder confirmation" className="lead-inspector__confirmation">
    <h3>Confirm {offered ? 'Offered' : 'Interviewed'}</h3>
    <p>Select actual evidence for this Person and sales cycle. A suggestion or price in a note is not evidence. An offer is not a payment.</p>
    <Select label={offered ? 'Price-stated evidence' : 'Conversation evidence'}
      options={[{ value: '', label: 'Select actual activity' }, ...evidence.map(activity => ({ value: activity.id,
        label: `${activity.occurredAt} · ${activity.summary} · ${activity.id}` }))]}
      value={activityId} disabled={busy} onChange={setActivityId} />
    {evidence.length === 0 && <p>No eligible evidence in recent Activity. If the logged event is outside this bounded history, do not guess its ID.</p>}
    <Button disabled={!eligible || busy} onClick={() => { void confirm(); }}>Confirm {offered ? 'Offered' : 'Interviewed'}</Button>
    {failed && <p role="alert">Confirmation could not be applied. Refresh this Person and select current evidence.</p>}
  </section>;
}
