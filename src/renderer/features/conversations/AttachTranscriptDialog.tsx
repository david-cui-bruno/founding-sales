import { useId, useState } from 'react';
import type { KeyboardEvent } from 'react';

import { Button } from '../../components/Button';

export type AttachTranscriptDialogProps = {
  personName: string;
  failed: boolean;
  submitting: boolean;
  onClose(): void;
  onSubmit(rawText: string): void;
};

const MAX_RAW_TEXT_LENGTH = 200_000;

/**
 * Mirrors the domain parser closely enough for an honest preview count:
 * non-empty trimmed lines become utterances, with `me:`/`founder:` and
 * short `Name:` prefixes stripped (a prefix-only line is dropped).
 */
export function countParsedUtterances(rawText: string): number {
  let count = 0;
  for (const line of rawText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (/^(me|founder):/i.test(trimmed)) {
      if (trimmed.replace(/^(me|founder):/i, '').trim().length > 0) count += 1;
      continue;
    }
    if (/^[^:]{1,40}:/.test(trimmed)) {
      if (trimmed.replace(/^[^:]{1,40}:/, '').trim().length > 0) count += 1;
      continue;
    }
    count += 1;
  }
  return count;
}

/**
 * Manual transcript paste dialog. The text is untrusted data: it is
 * previewed as a count only and submitted verbatim for the domain to parse.
 */
export function AttachTranscriptDialog({
  personName,
  failed,
  submitting,
  onClose,
  onSubmit,
}: AttachTranscriptDialogProps) {
  const headingId = useId();
  const textareaId = useId();
  const [rawText, setRawText] = useState('');

  const utteranceCount = countParsedUtterances(rawText);
  const tooLong = rawText.length > MAX_RAW_TEXT_LENGTH;
  const submitDisabled = submitting || tooLong || utteranceCount === 0;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return;
    if (submitting) return;
    onClose();
  };

  return (
    <div
      className="attach-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      onKeyDown={handleKeyDown}
    >
      <div className="attach-dialog__panel">
        <header className="attach-dialog__header">
          <h2 id={headingId}>Attach transcript</h2>
          <Button variant="quiet" onClick={onClose} disabled={submitting}>
            Close
          </Button>
        </header>
        <p className="attach-dialog__copy">
          Paste the transcript of this conversation with {personName}. Lines
          starting with <code>me:</code> are yours; <code>Name:</code> lines
          belong to the lead.
        </p>
        {failed && (
          <div className="attach-dialog__alert" role="alert">
            The transcript could not be attached. The conversation may already
            have one, or the text contained no usable lines.
          </div>
        )}
        <div className="attach-dialog__field">
          <label htmlFor={textareaId}>Transcript text</label>
          <textarea
            id={textareaId}
            className="attach-dialog__textarea"
            rows={10}
            value={rawText}
            onChange={(event) => setRawText(event.target.value)}
            disabled={submitting}
          />
        </div>
        <p className="attach-dialog__preview" role="status">
          {tooLong
            ? 'The transcript is too long to attach.'
            : `${utteranceCount} ${utteranceCount === 1 ? 'utterance' : 'utterances'} detected`}
        </p>
        <div className="attach-dialog__actions">
          <Button
            onClick={() => onSubmit(rawText)}
            disabled={submitDisabled}
          >
            Attach
          </Button>
        </div>
      </div>
    </div>
  );
}
