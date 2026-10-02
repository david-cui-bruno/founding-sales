import {
  CALL_OUTCOMES,
  type CallAnalysisQuoteRef,
  type CallOutcome,
  type CallProposal,
  type CallProposalEdits,
  type CallProposalKey,
} from '@fss/contracts';
import { OUTCOME_LABELS } from '../outcomeForm.ts';

/**
 * What the after-call block shows and sends, as pure functions of the analysis (slice 3a,
 * lane C; DESIGN-S3A §2.3, §11, §12).
 *
 * `mode` is **data**. A proposal whose mode is `review` is never a row David can apply: it is
 * a Needs review item, and nothing here derives a mode or upgrades one. Of the `apply`
 * proposals, **David's deliberate tick is the safety boundary** (§12): a stop, a buying
 * signal (open a deal), the e-mail follow-up and a callback start unticked whatever their
 * mode, each with its full evidence line beside it; the outcome and the promises may start
 * ticked. The park (pausing calls to the firm) is not on that list and starts unticked too,
 * because it stops work rather than recording it.
 */

/** The proposals David may tick: `mode: apply`, in the order the policy wrote them. */
export function applicable(proposals: readonly CallProposal[]): readonly CallProposal[] {
  return proposals.filter(proposal => proposal.mode === 'apply');
}

/** The proposals that are Needs review items. Never applicable. */
export function reviewOnly(proposals: readonly CallProposal[]): readonly CallProposal[] {
  return proposals.filter(proposal => proposal.mode === 'review');
}

/** Whether a proposal is an outcome that stops or retires something (every SENSITIVE_OUTCOMES value). */
export function isSensitive(proposal: CallProposal): boolean {
  return proposal.kind === 'outcome' && SENSITIVE_OUTCOMES.includes(proposal.params.outcome);
}

/** Whether a proposal is a stop: the `do_not_call` outcome. */
export function isStop(proposal: CallProposal): boolean {
  return proposal.kind === 'outcome' && proposal.params.outcome === 'do_not_call';
}

/**
 * Outcomes that stop or retire something. David's tick is the boundary for them (§12), and the
 * outcome row's tick was given for the outcome the analysis proposed, not for one he picks
 * afterwards. So the editor offers a sensitive outcome only as the proposal's own value: a stop
 * the analysis did not propose goes through the stop suggestion or the firm stop, and a wrong
 * number through the outcome form, each an explicit act.
 */
export const SENSITIVE_OUTCOMES: readonly CallOutcome[] = Object.freeze(['do_not_call', 'wrong_number']);

/** What the outcome select offers for this proposal. */
export function outcomeChoices(proposal: Extract<CallProposal, { kind: 'outcome' }>): readonly CallOutcome[] {
  return CALL_OUTCOMES.filter(value => !SENSITIVE_OUTCOMES.includes(value) || value === proposal.params.outcome);
}

/** The outcome that will be applied: a draft counts only when the select could have offered it. */
export function chosenOutcome(proposal: Extract<CallProposal, { kind: 'outcome' }>, drafts: FieldDrafts): CallOutcome {
  const draft = drafts.outcome;
  return draft !== undefined && outcomeChoices(proposal).includes(draft) ? draft : proposal.params.outcome;
}

/** An answer that is not a definite one: nothing says whether the command ran. */
export function noDefiniteAnswer(reason: string | null): boolean {
  return reason === 'offline' || reason === 'timeout' || reason === 'unreadable_answer' || (reason !== null && /^http_5\d\d$/u.test(reason));
}

/** The tick a row starts with. Only the outcome (not a stop) and the promises may start ticked. */
export function startsTicked(proposal: CallProposal): boolean {
  if (proposal.mode !== 'apply') return false;
  if (proposal.kind === 'task') return true;
  if (proposal.kind === 'outcome') return !isSensitive(proposal);
  return false;
}

export function rowLabel(proposal: CallProposal): string {
  switch (proposal.kind) {
    case 'outcome':
      return isStop(proposal) ? 'Stop: do not call again' : `Outcome: ${OUTCOME_LABELS[proposal.params.outcome]}`;
    case 'callback':
      return 'Call back at the time they gave';
    case 'follow_up':
      return 'Send the overview by e-mail (permission to send)';
    case 'buying_signal':
      return 'Open a deal (buying signal)';
    case 'park':
      return 'Pause calling this firm';
    case 'task':
      return proposal.params.text;
    default:
      return proposal.reason;
  }
}

/** One quote as a line David can check against what was said. */
export function evidenceLine(ref: CallAnalysisQuoteRef): string {
  return `${ref.side === 'them' ? 'They said' : 'You said'}: “${ref.quote}”`;
}

/** The whole evidence of a proposal, one line per quote. Never truncated. */
export function evidenceLines(proposal: CallProposal): readonly string[] {
  return 'evidence' in proposal.params ? proposal.params.evidence.map(evidenceLine) : [];
}

export interface Selection {
  /** Keys ticked, in row order. */
  readonly ticked: ReadonlySet<CallProposalKey>;
  /** The call already has a log: the outcome is history, and callback and follow-up may be applied. */
  readonly logged: boolean;
}

/**
 * Whether a row may be ticked now (§2.3's first-time rules, said before the click):
 *
 *   * with a log, the outcome row reads "Logged: <outcome>" and cannot be ticked;
 *   * a callback or a follow-up needs the outcome in the same Apply, or a log that exists.
 */
export function selectable(proposal: CallProposal, selection: Selection): { readonly ok: boolean; readonly why: string | null } {
  if (proposal.kind === 'outcome' && selection.logged) return { ok: false, why: null };
  if ((proposal.kind === 'callback' || proposal.kind === 'follow_up') && !selection.logged && !selection.ticked.has('outcome')) {
    return { ok: false, why: 'Tick the outcome too: this needs the call logged.' };
  }
  return { ok: true, why: null };
}

/** Drop what can no longer stand: a callback or follow-up whose outcome was unticked. */
export function settle(ticked: ReadonlySet<CallProposalKey>, proposals: readonly CallProposal[], logged: boolean): ReadonlySet<CallProposalKey> {
  const next = new Set(ticked);
  for (const proposal of proposals) {
    if (!next.has(proposal.key)) continue;
    if (!selectable(proposal, { ticked: next, logged }).ok) next.delete(proposal.key);
  }
  return next;
}

export interface FieldDrafts {
  readonly outcome?: CallOutcome;
  readonly coversAll?: boolean;
  readonly callbackDate?: string;
  readonly callbackTime?: string;
  readonly templateVersionId?: string;
}

/** The edits an Apply carries: only what David changed or had to choose. */
export function editsOf(proposals: readonly CallProposal[], ticked: ReadonlySet<CallProposalKey>, drafts: FieldDrafts): CallProposalEdits {
  const edits: {
    outcome?: NonNullable<CallProposalEdits['outcome']>;
    callback?: NonNullable<CallProposalEdits['callback']>;
    follow_up?: NonNullable<CallProposalEdits['follow_up']>;
  } = {};
  for (const proposal of proposals) {
    if (!ticked.has(proposal.key)) continue;
    if (proposal.kind === 'outcome') {
      const effective = chosenOutcome(proposal, drafts);
      const changed = effective !== proposal.params.outcome;
      const covers = effective === 'do_not_call' && drafts.coversAll === true;
      if (changed || covers) edits.outcome = { ...(changed ? { outcome: effective } : {}), ...(covers ? { doNotCallCoversAllContact: true } : {}) };
    }
    if (proposal.kind === 'callback') {
      const date = drafts.callbackDate ?? proposal.params.localDate;
      const time = drafts.callbackTime ?? proposal.params.localTime;
      if (date !== proposal.params.localDate || time !== proposal.params.localTime) {
        edits.callback = { localDate: date, localTime: time, sourceTimeZone: proposal.params.sourceTimeZone };
      }
    }
    if (proposal.kind === 'follow_up' && drafts.templateVersionId !== undefined && drafts.templateVersionId !== '') {
      edits.follow_up = { templateVersionId: drafts.templateVersionId };
    }
  }
  return edits;
}

/** Why Apply cannot be pressed yet, or null. */
export function applyProblem(proposals: readonly CallProposal[], ticked: ReadonlySet<CallProposalKey>, drafts: FieldDrafts): string | null {
  if (ticked.size === 0) return 'Tick what you want applied.';
  if (proposals.some(proposal => proposal.kind === 'follow_up' && ticked.has(proposal.key)) && (drafts.templateVersionId ?? '') === '') {
    return 'Choose the e-mail they agreed to receive.';
  }
  return null;
}

/** What each refusal says, in one local sentence. `reload` refusals read the analysis again. */
export const REFUSALS: Readonly<Record<string, { readonly text: string; readonly reload: boolean }>> = Object.freeze({
  stale_analysis: { text: 'These notes were replaced by newer ones. Reloaded: check the suggestions and apply again.', reload: true },
  stale_proposal: { text: 'The suggestions changed. Reloaded: check them and apply again.', reload: true },
  call_already_logged: { text: 'This call was already logged. Reloaded.', reload: true },
  proposal_unknown: { text: 'One of those suggestions is no longer there. Reloaded.', reload: true },
  outcome_required: { text: 'Tick the outcome as well: a callback or an e-mail needs the call logged.', reload: false },
  callback_exists: { text: 'This call already has a callback.', reload: true },
  follow_up_expired: { text: 'Over 7 days: in Needs review.', reload: true },
  callback_instant_mismatch: { text: 'The callback’s day, time and zone do not agree. Check them and apply again.', reload: false },
  callback_not_created: { text: 'The callback could not be created. Nothing was applied.', reload: false },
  effects_not_applied: { text: 'The outcome could not be fully applied, so nothing was written. Try again.', reload: false },
  route_not_named: { text: 'This call’s number is not known, so nothing was applied. Log the outcome by hand.', reload: false },
  follow_up_not_granted: { text: 'That e-mail can no longer be promised. Reloaded: choose another and apply again.', reload: true },
});

/** What an applied key says on its row. */
export const KEY_RESULT_TEXT: Readonly<Record<string, string>> = Object.freeze({
  applied: 'Done',
  already_created: 'Already a task for this call',
  already_parked: 'Calling is already paused here',
  already_applied: 'Already on the deal',
});

export function refusalOf(reason: string | null): { readonly text: string; readonly reload: boolean } {
  if (reason === null) return { text: 'Callie could not apply that. Nothing was changed.', reload: false };
  const known = REFUSALS[reason];
  if (known !== undefined) return known;
  if (reason.startsWith('stale_')) return REFUSALS['stale_analysis'] as { text: string; reload: boolean };
  return { text: reason === 'offline' ? 'Callie is offline. Nothing was applied.' : 'Callie could not apply that. Nothing was changed.', reload: false,
  };
}

/** What a refused key says beside its own suggestion; null for a code with no key-level meaning. */
export function keyRefusalText(code: string): string {
  const known = REFUSALS[code];
  if (known !== undefined) return known.text;
  if (code === 'not_found') return 'Callie cannot find this any more.';
  return 'Callie could not apply this one.';
}
