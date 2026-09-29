/**
 * The sentence Callie's automated e-mail used to end with, kept only so the code can
 * recognise it (David's decision of 29 September 2026: "remove the mandatory 'Reply
 * "stop"' footer and remove the blanket database ban on the word 'unsubscribe.'").
 *
 * **Nothing appends it any more.** It is legacy bytes: every template approved before
 * that decision, and every fence prepared before it, ends with the sign-off and then
 * this line, and `composeSendBody` recognises that block so it can be *replaced* by the
 * footer the workspace composes now (the sign-off, and its postal address when it has
 * one). A body that carries the line somewhere the records cannot account for is still
 * held rather than edited.
 *
 * It stays in `@fss/contracts` because both the domain's composition rule and the Mac's
 * template panel have to recognise the same bytes, and a copy in the renderer would be a
 * second spelling of a sentence that has to have one. `@fss/domain` re-exports it.
 */
export const SENDING_STOP_LINE = 'Reply "stop" and I will not email you again.';

/**
 * The one rule left about opting out: **no visible opt-out link** (specification 12.6,
 * and David's decision of 29 September 2026, which kept exactly this part). Callie takes
 * a stop request in ordinary language — "please unsubscribe me", "stop emailing me" —
 * and suppresses on it (`packages/domain/src/rules/replyClassification.ts`), so the
 * *word* is not the problem and is allowed: "just reply unsubscribe and I'll stop" is a
 * sentence we want to be able to write. A *link* is the problem.
 *
 * Bodies are plain text, so a visible opt-out link is a URL. Two shapes are refused,
 * case-insensitively:
 *
 *   * a URL (`https://…`, `www.…`, `mailto:…`) whose own text carries one of the opt-out
 *     words — `.../unsubscribe`, a `list-manage` host, `mailto:unsubscribe@…`;
 *   * any single LINE that carries both a URL and one of those words, whichever comes
 *     first — "click here to opt out: https://x" is a link with its label.
 *
 * These are the same two shapes migration 0023's `template_versions_no_optout_link` and
 * `outbound_messages_no_optout_link` CHECKs refuse, written once here so the Mac's
 * refusal, the save's refusal and the database's refusal cannot drift apart.
 */
const OPT_OUT_WORDS = String.raw`unsubscribe|opt[-_ ]?out|optout|remove[-_ ]?me|list-manage`;
const URL_TOKEN = String.raw`https?://|www\.`;

/** The opt-out-link shape, mirroring the CHECKs of migration 0023 line for line. */
export const OPT_OUT_LINK_PATTERN = new RegExp(
  [
    `(?:${URL_TOKEN})[^\\n]*(?:${OPT_OUT_WORDS})`,
    `(?:${OPT_OUT_WORDS})[^\\n]*(?:${URL_TOKEN})`,
    `mailto:[^\\s]*(?:${OPT_OUT_WORDS})`,
  ].join('|'),
  'iu',
);

/** Whether a subject or body carries a visible opt-out link. */
export function hasOptOutLink(text: string): boolean {
  return OPT_OUT_LINK_PATTERN.test(text);
}

/** The refusal the Mac shows, and the sentence the rule is written as. */
export const NO_OPTOUT_LINK_RULE =
  'Leave out any opt-out link: Callie takes a stop request in ordinary language, so write "reply unsubscribe" rather than linking to one.';

export const TEMPLATE_VARIABLE_NAMES = [
  'firm_name',
  'firm_locality',
  'firm_region',
  'firm_website',
  'contact_first_name',
  'contact_full_name',
  'contact_title',
] as const;
export type TemplateVariableName = (typeof TEMPLATE_VARIABLE_NAMES)[number];

/**
 * What a template approval warns about and still approves (26 September 2026).
 *
 * Until then each of these refused the approval: more than 89 words, more than one link
 * in the body or any link in the subject, and any price, percentage or guarantee
 * wording. They are copy advice, not rules a send depends on, so the approval (and the
 * create before it) answers them as `warnings` beside the version. What still refuses
 * is what a send or the law depends on: a footer Callie can compose, no visible opt-out
 * link, no markup, plain text, a one-line subject, and only variables Callie can fill.
 */
export const TEMPLATE_WARNING_CODES = [
  'template_body_too_long',
  'template_body_multiple_urls',
  'template_subject_url',
  'template_pricing_or_guarantee_language',
] as const;
export type TemplateWarningCode = (typeof TEMPLATE_WARNING_CODES)[number];
