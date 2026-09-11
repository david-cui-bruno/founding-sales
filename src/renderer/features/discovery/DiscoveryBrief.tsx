import { useEffect, useId, useRef, useState } from 'react';
import { mutationReceiptSchema, type MutationReceipt } from '../../../shared/contracts/commonContract';
import { discoveryBriefSchema, overrideDiscoveryRequestSchema,
  type DiscoveryBrief as Brief, type DiscoveryEvidenceRef, type OverrideDiscoveryRequest,
} from '../../../shared/contracts/discoveryContract';
import { useModalDialog } from '../../app/useModalDialog';
import { Button } from '../../components/Button';
import { Select } from '../../components/Select';
import { staleDiscoveryError } from './useDiscovery';

const reference = (ref: DiscoveryEvidenceRef) => ref.kind === 'source'
  ? `Source ${ref.sourceEventId}, ${ref.field}, ${ref.observedAt}`
  : ref.kind === 'activity' ? `Activity ${ref.activityId}, ${ref.field}, ${ref.observedAt}`
    : `Activity ${ref.activityId}, transcript ${ref.transcriptId}, utterance ${ref.utteranceId}, ${ref.observedAt}: ${ref.quote}`;

/** Evidence is plain text. Discovery decisions never close a sales cycle. */
export function DiscoveryBrief({ brief, onOverride }: {
  brief: Brief; onOverride(request: OverrideDiscoveryRequest): Promise<MutationReceipt>;
}) {
  const parsed = discoveryBriefSchema.safeParse(brief);
  const [editing, setEditing] = useState(false);
  const [decision, setDecision] = useState<OverrideDiscoveryRequest['decision']>('watch');
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const pending = useRef(false);
  const retained = useRef<OverrideDiscoveryRequest | null>(null);
  const generation = useRef(0);
  const titleId = useId();
  const reasonErrorId = useId();
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const close = () => { setEditing(false); };
  const modal = useModalDialog({ open: editing && parsed.success, dialogRef, canDismiss: () => !busy,
    onDismiss: close, initialFocus: () => reasonRef.current, returnFocus: () => triggerRef.current });
  useEffect(() => {
    generation.current++;
    setEditing(false); setReason(''); setReasonError(null); setMessage(null); setBusy(false);
    pending.current = false; retained.current = null;
    return () => { generation.current++; };
  }, [brief.personId, brief.salesCycleId, brief.assessment?.id, onOverride]);
  if (!parsed.success) return <p role="alert">Discovery evidence unavailable.</p>;
  const value = parsed.data;
  const assessment = value.assessment;
  const save = async () => {
    if (pending.current || assessment === null || value.stale) return;
    const input = overrideDiscoveryRequestSchema.safeParse(retained.current ?? {
      commandId: crypto.randomUUID(), personId: value.personId, assessmentId: assessment.id,
      expectedFingerprint: assessment.fingerprint, decision, reason: reason.trim(),
    });
    if (!input.success) {
      setReasonError('Use one line of 1 to 2,000 characters without control characters.');
      reasonRef.current?.focus();
      return;
    }
    setReasonError(null);
    const current = generation.current;
    retained.current = input.data;
    pending.current = true; setBusy(true); setMessage(null);
    try {
      const receipt = mutationReceiptSchema.parse(await onOverride(input.data));
      if (!receipt.affectedPersonIds.includes(value.personId)) throw new Error('Invalid override receipt');
      if (current === generation.current) { close(); setMessage('Discovery decision saved. Sales history is unchanged.'); retained.current = null; }
    } catch (error) {
      if (current === generation.current) setMessage(staleDiscoveryError(error)
        ? 'Evidence changed. Refresh the evidence before deciding again.'
        : 'Decision response unavailable. Retry preserves the same decision and reason.');
    } finally {
      if (current === generation.current) { pending.current = false; setBusy(false); }
    }
  };
  return <section className="discovery-brief" aria-label={`Discovery evidence for ${value.personName}`}>
    {assessment === null ? <p>Not assessed</p> : <>
      <p>{assessment.axes.fit === null ? 'Fit unknown' : assessment.axes.fit.completeness === 'partial'
        ? `Fit: ${assessment.axes.fit.points} supported points /30 (partial)` : `Fit: ${assessment.axes.fit.points}/30`}</p>
      <p>{assessment.axes.timing.hasSupportedTrigger ? `Timing: ${assessment.axes.timing.milliPoints / 1000}/40` : 'No current trigger established'}</p>
      <p>Reachability: {assessment.axes.reachability}. Assessed {assessment.evaluatedAt}.</p>
      {!assessment.identitySupported && <p>Owner identity needs evidence or conflict resolution before preparation.</p>}
      {assessment.reasonCodes.length > 0 && <p>{assessment.reasonCodes.map(code => code.replaceAll('_', ' ')).join(' · ')}</p>}
      <ul>{assessment.claims.map(claim => <li key={claim.id}>
        <strong>{claim.label}</strong> ({claim.certainty}): <span>{claim.value === null ? 'Unknown' : String(claim.value)}</span>
        <ul>{claim.refs.map((ref, index) => <li key={index}>{reference(ref)}</li>)}</ul>
      </li>)}</ul>
      {assessment.unknowns.length > 0 && <><h4>Unknowns to explore</h4><ul>{assessment.unknowns.map(unknown => <li key={unknown}>{unknown}</li>)}</ul></>}
      <h4>Discovery questions</h4><ul>{assessment.questions.map(question => <li key={question}>{question}</li>)}</ul>
    </>}
    {value.stale && <p>Evidence may have changed. Refresh before preparing or deciding.</p>}
    {value.latestOverride !== null && <p>Prior decision: {value.latestOverride.decision}. {value.latestOverride.reason} ({value.latestOverride.createdAt}). {value.latestOverride.evidenceChanged && 'Revised evidence since this decision.'}</p>}
    {value.pilotNextStep !== null && <p>Conversation-based suggestion: {value.pilotNextStep.label}. Evidence: {value.pilotNextStep.activityIds.join(', ')}. This is not an offer or payment.</p>}
    {assessment !== null && <Button variant="quiet" disabled={value.stale} onClick={event => { triggerRef.current = event.currentTarget; setEditing(true); }}>Adjust discovery</Button>}
    {editing && <dialog ref={dialogRef} aria-labelledby={titleId} className="discovery-brief__decision"
      onKeyDown={modal.onKeyDown} onCancel={modal.onCancel}>
      <h4 id={titleId}>Discovery decision for {value.personName}</h4>
      <p>Affects discovery visibility only. Does not dismiss, opt out, or close this sales cycle.</p>
      <Select<OverrideDiscoveryRequest['decision']> label="Discovery decision" options={[{ value: 'watch', label: 'Watch' }, { value: 'exclude', label: 'Exclude' }, { value: 'reconsider', label: 'Reconsider' }]}
        value={decision} disabled={busy || retained.current !== null} onChange={setDecision} />
      <label>Reason<textarea ref={reasonRef} value={reason} maxLength={2000} disabled={busy || retained.current !== null}
        aria-invalid={reasonError !== null} aria-describedby={reasonError === null ? undefined : reasonErrorId}
        onChange={event => { setReason(event.target.value); setReasonError(null); }} /></label>
      {reasonError !== null && <p id={reasonErrorId} role="alert">{reasonError}</p>}
      <Button disabled={busy || reason.trim().length === 0} onClick={() => { void save(); }}>Save discovery decision</Button>
      <Button variant="quiet" disabled={busy} onClick={() => modal.requestDismiss('close-button')}>Close decision</Button>
    </dialog>}
    {message !== null && <p role="status">{message}</p>}
  </section>;
}
