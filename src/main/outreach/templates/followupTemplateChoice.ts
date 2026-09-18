import { actualAccountCallOutcomes } from '../../../shared/contracts/accountOutboundContract';
import type { ReplyTemplateHoldReason, ReplyTemplateId, ReplyTemplateValues } from '../../../shared/contracts/replyTemplateContract';

/**
 * Which template a follow-up after a call uses, and with which values (design D13, David's decision of
 * 17 September 2026: "a follow-up drafts after every call outcome when the firm has a business email").
 *
 * Pure. It reads the outcome David logged, the note and callback he typed, and whether the firm has a
 * business email the account record already carries; it decides only which template to draft. It never
 * invents an address, never sends, and never treats a missing fact as a fact:
 *
 * - `interested` uses T1, which needs `{next_step}` from the call note. With no note the follow-up waits
 *   rather than drafting an email whose one ask is blank.
 * - `connected` with a callback date uses T3 and fills `{callback_date}` from the callback David promised.
 * - `connected` with no callback, and every unreached outcome (`no_answer`, `voicemail`, `busy`,
 *   `gatekeeper`), use T2.
 * - `not_interested`, `wrong_number` and `opt_out` draft nothing: the firm has answered.
 * - No business email on the account holds the follow-up with `no_business_email`; an address is never guessed.
 */
export const FOLLOWUP_TEMPLATE_OUTCOMES = actualAccountCallOutcomes.filter(outcome => outcome !== 'not_interested' && outcome !== 'wrong_number');
export type FollowupTemplateOutcome = typeof FOLLOWUP_TEMPLATE_OUTCOMES[number];
/** Why no template draft was prepared. `outcome_needs_no_followup` is a decision, not a failure. */
export type FollowupTemplateHold = ReplyTemplateHoldReason | 'outcome_needs_no_followup';
export type FollowupTemplateChoice =
  | { templateId: ReplyTemplateId; values: ReplyTemplateValues }
  | { hold: FollowupTemplateHold; missing?: readonly string[] };

export function chooseFollowupTemplate(input: {
  outcome: string;
  /** The note David typed on the report, which is what `{next_step}` says. Blank is blank, never filled in. */
  note: string | null;
  /** The callback he promised, as a plain local date, or null. */
  callbackDate: string | null;
  /** The firm as the account record states it. A business email is a claim on the account, never derived from a domain. */
  firm: { name: string; city: string | null; businessEmail: string | null };
}): FollowupTemplateChoice {
  if (!(FOLLOWUP_TEMPLATE_OUTCOMES as readonly string[]).includes(input.outcome)) return { hold: 'outcome_needs_no_followup' };
  if (!input.firm.businessEmail) return { hold: 'no_business_email' };
  const note = input.note?.trim() ?? '';
  const base: ReplyTemplateValues = { firm: input.firm.name, ...(input.firm.city ? { city: input.firm.city } : {}) };
  if (input.outcome === 'interested') {
    if (!note) return { hold: 'template_variable_missing', missing: ['next_step'] };
    return { templateId: 'T1', values: { ...base, next_step: note } };
  }
  if (input.outcome === 'connected' && input.callbackDate) return { templateId: 'T3', values: { ...base, callback_date: input.callbackDate } };
  return { templateId: 'T2', values: base };
}
