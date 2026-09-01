import { useEffect, useRef, useState } from 'react';

import type {
  CaptureLearningRequest,
  LearningCategory,
  LearningConfidence,
} from '../../../shared/contracts/learningsContract';
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
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.querySelector('select')?.focus();
  }, []);

  const submit = () => {
    const trimmedStatement = statement.trim();
    const trimmedQuotes = quotes
      .map((quote) => quote.trim())
      .filter((quote) => quote.length > 0);
    if (trimmedStatement.length === 0 || trimmedQuotes.length === 0) {
      return;
    }
    const notedAt = now();
    const evidence = trimmedQuotes.map(
      (quote): CaptureLearningRequest['evidence'][number] => ({
        personId: null, activityId: null, quote, notedAt,
      }),
    );
    void onSubmit({
      category,
      statement: trimmedStatement,
      confidence,
      evidence,
      contradictionOf: null,
    }).catch((): void => undefined);
  };

  return (
    <div className="learnings__dialog-backdrop">
      <div
        ref={dialogRef}
        className="learnings__dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Capture learning"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            onCancel();
          }
        }}
      >
        <h2 className="learnings__dialog-title">Capture learning</h2>

        <label className="learnings__field">
          <span className="learnings__field-label">Category</span>
          <select
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

        <fieldset className="learnings__evidence-fieldset">
          <legend className="learnings__field-label">Evidence</legend>
          {quotes.map((quote, index) => (
            /* Rows are positional inputs; index keys are correct here. */
            <label key={index} className="learnings__field">
              <span className="learnings__field-label">
                {`Evidence quote ${index + 1}`}
              </span>
              <textarea
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
            onClick={() => setQuotes([...quotes, ''])}
          >
            Add another evidence row
          </Button>
        </fieldset>

        <div className="learnings__dialog-actions">
          <Button onClick={submit}>Save learning</Button>
          <Button variant="quiet" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
