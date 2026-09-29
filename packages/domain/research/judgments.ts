import type { AdmittedFact, FactKey } from './facts.ts';

/**
 * The four judgments, kept apart (`.context/DECISION-20260928-crm-design.md`,
 * "Research").
 *
 * > Four judgments kept separate: fit, evidence of a relevant problem, timing,
 * > ability to reach someone.
 *
 * Separate because they fail separately. A firm can be an obvious fit with nothing
 * said about timing; a firm can be plainly reachable and plainly not a prospect.
 * Collapsing them into one score would produce a number that is wrong in a way nobody
 * can see, and the whole point of this lane is that a person can look at a judgment
 * and find the sentence it rests on.
 *
 * ## Nothing here infers budget or intent
 *
 * "A portal link can support a software inference; a maintenance job posting can
 * suggest an opportunity for discussion. Neither proves budget or buying intent."
 *
 * So there is no fifth judgment, no score and no field that could hold one.
 * `problem_evidence` says a page shows something this product is about; it does not
 * say the firm wants to buy anything, and `timing` says a page shows something
 * changed recently, not that the firm is in a buying cycle. A reader who wants either
 * of those has to make the call themselves, which is the honest arrangement.
 *
 * ## `unknown` is never `no`
 *
 * Silence is not a denial. A firm whose site says nothing about maintenance gets
 * `problem_evidence: 'unknown'`, never `'no'` — the only `no` any of these four can
 * reach is `fit: 'no'` (the firm's own site says it is not that kind of firm) and
 * `reachability: 'no'` (an active firm-wide suppression, which is a fact about us and
 * not about the firm).
 *
 * ## A page on somebody else's host is not the firm speaking
 *
 * A link a person adds is fetched and quoted through the same path as the firm's own
 * site, and on the brief it would read as what the firm said. So every fact carries
 * `firstParty`, and a third-party fact counts for **`problem_evidence` and `timing`
 * only**. `fit` is a statement about what the firm is, and the firm's own site is the
 * only source that gets to make it — a trade article calling a brokerage a property
 * manager must not turn into `fit: 'yes'`, and nor must the brokerage's own site saying
 * otherwise be outvoted. `reachability` is the same kind of claim: that the *firm*
 * publishes a way to reach a person, which a directory listing is not.
 *
 * Pure. No database, no clock, no provider. Everything it needs is an argument.
 */

export const JUDGMENT_VALUES = ['yes', 'no', 'unknown'] as const;
export type JudgmentValue = (typeof JUDGMENT_VALUES)[number];

export interface JudgmentContact {
  readonly contactId: string;
  readonly fullName: string;
  readonly title: string | null;
}

export interface JudgmentInput {
  /** The facts this firm has now, each with the id of the `firm_facts` row. */
  readonly facts: readonly (AdmittedFact & { readonly id: string })[];
  /** True when the firm has a `usable` or `candidate` phone route. */
  readonly hasPhoneRoute: boolean;
  /** True when an active firm-wide suppression covers the firm (10.2). */
  readonly suppressed: boolean;
  /** The firm's active contacts, for `likelyContactId`. */
  readonly contacts: readonly JudgmentContact[];
  /**
   * The text of the blocks the run's `role` and `named_role` selections named, in
   * memory, for `likelyContactId` alone.
   *
   * Not stored anywhere and not carried on the result: those keys hold no quote
   * (`PERSON_FACT_KEYS`), because a block naming a person would outlive that person's
   * deletion. Matching a contact's recorded title against the published text is still
   * worth doing, and what comes out of it is a contact **id** — a row deletion already
   * reaches — so the text is read during the run and then dropped.
   */
  readonly roleBlocks?: readonly string[] | undefined;
}

export interface Judgments {
  readonly fit: JudgmentValue;
  readonly problemEvidence: JudgmentValue;
  readonly timing: JudgmentValue;
  readonly reachability: JudgmentValue;
  /** One short sentence per judgment, naming the `firm_facts` ids it rests on. */
  readonly reasons: Readonly<Record<'fit' | 'problemEvidence' | 'timing' | 'reachability', string>>;
  readonly callFirst: boolean;
  readonly likelyContactId: string | null;
}

/** `firm_judgments_reasons_bounded` bounds the whole object; each sentence is bounded here. */
export const MAX_REASON_CHARACTERS = 300;

/**
 * The ids of the facts a judgment rests on.
 *
 * `firstPartyOnly` matches the rule the judgment itself used, so a reason never cites a
 * fact that was not allowed to count towards it.
 */
function idsFor(input: JudgmentInput, keys: readonly FactKey[], firstPartyOnly = false): readonly string[] {
  return input.facts
    .filter(fact => keys.includes(fact.key) && (!firstPartyOnly || fact.firstParty))
    .map(fact => fact.id);
}

function reason(sentence: string, ids: readonly string[]): string {
  const cited = ids.length === 0 ? sentence : `${sentence} (${ids.join(', ')})`;
  return cited.length <= MAX_REASON_CHARACTERS ? cited : `${cited.slice(0, MAX_REASON_CHARACTERS - 1)}…`;
}

/**
 * Which contact is most likely the person to ask for.
 *
 * A role selection named a block carrying a title the firm published; a contact carries
 * a title somebody recorded. The block's text is passed in (`roleBlocks`) rather than
 * read off the fact, because a person key stores no quote. The match is a case-insensitive containment either way, which is
 * deliberately loose — "Maintenance Coordinator" should match a `role` quote that
 * says "our maintenance coordinator handles every request" — and deliberately
 * suggestive: `likely_contact_id` is what the brief offers as "probably this person",
 * and nothing acts on it.
 */
function likelyContact(input: JudgmentInput): string | null {
  const roleQuotes = (input.roleBlocks ?? []).map(text => text.toLowerCase());
  if (roleQuotes.length === 0) return null;
  for (const contact of input.contacts) {
    const title = contact.title?.trim().toLowerCase();
    if (title === undefined || title === '') continue;
    if (roleQuotes.some(quote => quote.includes(title))) return contact.contactId;
  }
  return null;
}

export function judgeFirm(input: JudgmentInput): Judgments {
  /** Any source. Used by the two judgments a third party may speak to. */
  const has = (key: FactKey): boolean => input.facts.some(fact => fact.key === key);
  /** The firm's own site only. Used by the two that are claims about the firm itself. */
  const hasOwn = (key: FactKey): boolean => input.facts.some(fact => fact.key === key && fact.firstParty);

  // Fit. `not_target` wins over `target_fit`: the conservative direction is not to
  // call a firm a prospect when its own site says otherwise. First-party only: what
  // kind of firm this is, is the firm's own site's to say.
  const fit: JudgmentValue = hasOwn('not_target') ? 'no' : hasOwn('target_fit') ? 'yes' : 'unknown';

  // A relevant problem. Either the firm describes how it handles maintenance, or it
  // is hiring for it. Silence is `unknown`, never `no`.
  const problemKeys: readonly FactKey[] = ['maintenance_workflow', 'hiring_maintenance'];
  const problemEvidence: JudgmentValue = problemKeys.some(has) ? 'yes' : 'unknown';

  // Timing. Something the firm says changed, or a job it is advertising now.
  const timingKeys: readonly FactKey[] = ['recent_change', 'hiring_maintenance'];
  const timing: JudgmentValue = timingKeys.some(has) ? 'yes' : 'unknown';

  // Reachability. A suppression is the only `no`, and it outranks every yes: a firm
  // that has asked not to be contacted is not reachable however many numbers it
  // publishes (10.2).
  const reachKeys: readonly FactKey[] = ['phone_listed', 'named_role'];
  const reachability: JudgmentValue = input.suppressed
    ? 'no'
    : input.hasPhoneRoute || reachKeys.some(hasOwn)
      ? 'yes'
      : 'unknown';

  const fitIds = idsFor(input, ['not_target', 'target_fit'], true);
  const reasons = {
    fit: reason(
      fit === 'no'
        ? 'the firm’s own site says it is not this kind of firm'
        : fit === 'yes'
          ? 'the firm’s own site says it manages property for owners'
          : 'the pages read did not say either way',
      fitIds,
    ),
    problemEvidence: reason(
      problemEvidence === 'yes'
        ? 'the firm publishes something about how maintenance is handled or is hiring for it'
        : 'the pages read said nothing about maintenance; that is not evidence against',
      idsFor(input, problemKeys),
    ),
    timing: reason(
      timing === 'yes'
        ? 'the firm says something changed recently, or is advertising a role now'
        : 'the pages read named nothing recent; that is not evidence against',
      idsFor(input, timingKeys),
    ),
    reachability: reason(
      reachability === 'no'
        ? 'an active firm-wide do-not-contact covers this firm'
        : reachability === 'yes'
          ? input.hasPhoneRoute
            ? 'the firm has a recorded telephone route'
            : 'the firm publishes a way to reach a person'
          : 'nothing read names a number or a person',
      reachability === 'no' ? [] : idsFor(input, reachKeys, true),
    ),
  } as const;

  return {
    fit,
    problemEvidence,
    timing,
    reachability,
    reasons,
    // The queue's rule, and the same expression `firm_judgments_call_first_consistent`
    // holds the row to. Note what it does *not* include: a firm with no problem
    // evidence and no timing is still called first if it fits and can be reached,
    // because a call is how you find out.
    callFirst: fit === 'yes' && reachability !== 'no',
    likelyContactId: likelyContact(input),
  };
}
