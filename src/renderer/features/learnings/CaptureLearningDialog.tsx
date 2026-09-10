import { useEffect, useRef, useState } from 'react';

import type {
  CaptureLearningRequest,
  LearningCategory,
  LearningConfidence,
} from '../../../shared/contracts/learningsContract';
import { useModalDialog } from '../../app/useModalDialog';
import { Button } from '../../components/Button';
import { CATEGORY_LABELS } from './learningMeta';

const CATEGORY_ORDER: LearningCategory[] = [
  'pain', 'objection', 'alternative', 'winning_language',
  'pricing_reaction', 'product_request', 'coaching',
  'invalidated_assumption',
];

const CONFIDENCE_OPTIONS: { value: LearningConfidence; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

export type CaptureLearningDialogProps = {
  onSubmit(request: CaptureLearningRequest): Promise<void>;
  onCancel(): void;
  now(): string;
};

/**
 * Manual founder capture. V1 evidence rows are quote-only (notedAt is the
 * capture moment); person links arrive later through analysis suggestions,
 * so the contract keeps personId nullable without a picker here.
 */
export function CaptureLearningDialog({
  onSubmit,
  onCancel,
  now,
}: CaptureLearningDialogProps) {
  const [category, setCategory] = useState<LearningCategory>('pain');
  const [statement, setStatement] = useState('');
  const [confidence, setConfidence] = useState<LearningConfidence>('medium');
  const [quotes, setQuotes] = useState<string[]>(['']);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pendingRef = useRef(false);
  const generation = useRef(0);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const modal = useModalDialog({ open: true, dialogRef, canDismiss: () => !pendingRef.current,
    onDismiss: onCancel, initialFocus: () => dialogRef.current?.querySelector('select') ?? null });

  useEffect(() => {
    generation.current++;
    return () => { generation.current++; };
  }, []);

  const submit = async () => {
    if (pendingRef.current) return;
    const trimmedStatement = statement.trim();
    const trimmedQuotes = quotes
      .map((quote) => quote.trim())
      .filter((quote) => quote.length > 0);
    if (trimmedStatement.length === 0 || trimmedQuotes.length === 0) {
      return;
    }
    pendingRef.current = true; setPending(true); setFailed(false);
    const current = generation.current;
    try {
    const notedAt = now();
    const evidence = trimmedQuotes.map(
      (quote): CaptureLearningRequest['evidence'][number] => ({
        personId: null, activityId: null, quote, notedAt,
      }),
    );
    await onSubmit({
      category,
      statement: trimmedStatement,
      confidence,
      evidence,
      contradictionOf: null,
    });
    } catch { if (generation.current === current) setFailed(true); }
    finally { if (generation.current === current) { pendingRef.current = false; setPending(false); } }
  };

  return (
    <dialog ref={dialogRef} className="learnings__dialog" aria-label="Capture learning"
      onCancel={modal.onCancel} onKeyDown={modal.onKeyDown} onChange={() => setFailed(false)}>
        <h2 className="learnings__dialog-title">Capture learning</h2>

        <label className="learnings__field">
          <span className="learnings__field-label">Category</span>
          <select
            disabled={pending}
            className="learnings__select"
            value={category}
            onChange={(event) => setCategory(event.target.value as LearningCategory)}
          >
            {CATEGORY_ORDER.map((option) => (
              <option key={option} value={option}>
                {CATEGORY_LABELS[option]}
              </option>
            ))}
          </select>
        </label>

        <label className="learnings__field">
          <span className="learnings__field-label">Statement</span>
          <textarea
            disabled={pending}
            className="learnings__textarea"
            value={statement}
            maxLength={500}
            placeholder="What did you learn?"
            onChange={(event) => setStatement(event.target.value)}
          />
        </label>

        <label className="learnings__field">
          <span className="learnings__field-label">Confidence</span>
          <select
            disabled={pending}
            className="learnings__select"
            value={confidence}
            onChange={(event) => setConfidence(event.target.value as LearningConfidence)}
          >
            {CONFIDENCE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <fieldset disabled={pending} className="learnings__evidence-fieldset">
          <legend className="learnings__field-label">Evidence</legend>
          {quotes.map((quote, index) => (
            /* Rows are positional inputs; index keys are correct here. */
            <label key={index} className="learnings__field">
              <span className="learnings__field-label">
                {`Evidence quote ${index + 1}`}
              </span>
              <textarea
            disabled={pending}
                className="learnings__textarea"
                value={quote}
                maxLength={2000}
                placeholder="What did they actually say?"
                onChange={(event) => {
                  const next = [...quotes];
                  next[index] = event.target.value;
                  setQuotes(next);
                }}
              />
            </label>
          ))}
          <Button
            variant="quiet"
            onClick={() => { setQuotes([...quotes, '']); setFailed(false); }}
          >
            Add another evidence row
          </Button>
        </fieldset>

        {failed && <p role="alert">Learning save was not confirmed. Your input is still here. Check Learnings before submitting again.</p>}
        <div className="learnings__dialog-actions">
          <Button disabled={pending} onClick={() => { void submit(); }}>Save learning</Button>
          <Button variant="quiet" disabled={pending} onClick={() => modal.requestDismiss('close-button')}>
            Cancel
          </Button>
        </div>
    </dialog>
  );
}
