import { useState } from 'react';
import {
  ADD_FIRM_PROBLEM_SENTENCES,
  ADD_FIRM_STATES,
  addFirmProblem,
  emptyAddFirmDraft,
  emptyOutcomeDraft,
  OUTCOME_LABELS,
  OUTCOME_ORDER,
  OUTCOME_PROBLEM_SENTENCES,
  outcomeProblem,
  outcomeSuppresses,
  type AddFirmDraft,
  type OutcomeDraft,
} from './outcomeModel';

/**
 * The outcome form and the add-a-firm form (FSS target design section 3; slice S2). The outcome form is the whole of
 * what David says about one call: the ten outcomes as buttons, a note, the day he promised a callback, "Never call
 * this firm" with his reason, and one Record button. Nothing here decides anything — the worker records the call,
 * advances the sequence, writes the callback and suppresses — and nothing here dials or sends.
 *
 * Recording is refused, with a sentence, until the draft carries what its outcome needs: a callback needs its day,
 * and never-calling a firm needs David's own words, because the suppression it writes is permanent.
 */

export type OutcomeFormProps = {
  firmId: string;
  firmName: string;
  /** The sentence of the handoff that opened this form, if it said anything. */
  notice?: string | null;
  /** Whether a record is in flight; the button says so and cannot be pressed twice. */
  recording?: boolean;
  /** The sentence of a refused or failed record. */
  failure?: string | null;
  onRecord: (draft: OutcomeDraft) => void;
  onCancel: () => void;
};

export function OutcomeForm({ firmId, firmName, notice = null, recording = false, failure = null, onRecord, onCancel }: OutcomeFormProps) {
  const [draft, setDraft] = useState<OutcomeDraft>(emptyOutcomeDraft);
  const [shown, setShown] = useState(false);
  const problem = outcomeProblem(draft);
  const suppresses = outcomeSuppresses(draft);
  return (
    <form
      className="outcome-form"
      data-firm-id={firmId}
      aria-label={`Log the outcome for ${firmName}`}
      onSubmit={(event) => { event.preventDefault(); setShown(true); if (!problem && !recording) onRecord(draft); }}
    >
      {notice ? <p role="status" className="outcome-form__notice">{notice}</p> : null}
      <fieldset className="outcome-form__outcomes">
        <legend>What happened</legend>
        {OUTCOME_ORDER.map((outcome) => (
          <button
            key={outcome}
            type="button"
            className="outcome-form__outcome"
            data-outcome={outcome}
            aria-pressed={draft.outcome === outcome}
            onClick={() => setDraft((held) => ({ ...held, outcome }))}
          >
            {OUTCOME_LABELS[outcome]}
          </button>
        ))}
      </fieldset>
      <label className="outcome-form__note">
        Note
        <textarea value={draft.note} rows={2} onChange={(event) => setDraft((held) => ({ ...held, note: event.target.value }))} />
      </label>
      <label className="outcome-form__callback">
        Callback on
        <input type="date" value={draft.callbackOn} onChange={(event) => setDraft((held) => ({ ...held, callbackOn: event.target.value }))} />
      </label>
      <label className="outcome-form__never">
        <input type="checkbox" checked={draft.neverCall} onChange={(event) => setDraft((held) => ({ ...held, neverCall: event.target.checked }))} />
        Never call this firm
      </label>
      {draft.neverCall ? (
        <label className="outcome-form__never-reason">
          Why
          <input type="text" value={draft.neverCallReason} onChange={(event) => setDraft((held) => ({ ...held, neverCallReason: event.target.value }))} />
        </label>
      ) : null}
      {suppresses ? (
        <p role="alert" className="outcome-form__warning">Recording this suppresses {firmName} for good. There is no undo.</p>
      ) : null}
      {shown && problem ? <p role="alert" className="outcome-form__problem" data-problem={problem}>{OUTCOME_PROBLEM_SENTENCES[problem]}</p> : null}
      {failure ? <p role="alert" className="outcome-form__failure">{failure}</p> : null}
      <div className="outcome-form__controls">
        <button type="submit" className="outcome-form__record" disabled={recording}>{recording ? 'Recording' : 'Record'}</button>
        <button type="button" className="outcome-form__cancel" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

export type AddFirmFormProps = {
  adding?: boolean;
  failure?: string | null;
  onAdd: (draft: AddFirmDraft) => void;
};

/** Add a firm by hand, from Today's header. It enters the pool like a researched one; no research is started for it. */
export function AddFirmForm({ adding = false, failure = null, onAdd }: AddFirmFormProps) {
  const [draft, setDraft] = useState<AddFirmDraft>(emptyAddFirmDraft);
  const [shown, setShown] = useState(false);
  const problem = addFirmProblem(draft);
  return (
    <form
      className="add-firm"
      aria-label="Add a firm"
      onSubmit={(event) => { event.preventDefault(); setShown(true); if (!problem && !adding) onAdd(draft); }}
    >
      <label>Firm name<input type="text" value={draft.name} onChange={(event) => setDraft((held) => ({ ...held, name: event.target.value }))} /></label>
      <label>City<input type="text" value={draft.city} onChange={(event) => setDraft((held) => ({ ...held, city: event.target.value }))} /></label>
      <label>
        State
        <select aria-label="State" value={draft.state} onChange={(event) => setDraft((held) => ({ ...held, state: event.target.value }))}>
          <option value="">Pick one</option>
          {ADD_FIRM_STATES.map((state) => <option key={state} value={state}>{state}</option>)}
        </select>
      </label>
      <label>Phone<input type="tel" value={draft.phone} onChange={(event) => setDraft((held) => ({ ...held, phone: event.target.value }))} /></label>
      <label>Business email<input type="email" value={draft.email} onChange={(event) => setDraft((held) => ({ ...held, email: event.target.value }))} /></label>
      <label>Website<input type="text" value={draft.site} onChange={(event) => setDraft((held) => ({ ...held, site: event.target.value }))} /></label>
      {shown && problem ? <p role="alert" className="add-firm__problem" data-problem={problem}>{ADD_FIRM_PROBLEM_SENTENCES[problem]}</p> : null}
      {failure ? <p role="alert" className="add-firm__failure">{failure}</p> : null}
      <button type="submit" className="add-firm__submit" disabled={adding}>{adding ? 'Adding' : 'Add firm'}</button>
    </form>
  );
}
