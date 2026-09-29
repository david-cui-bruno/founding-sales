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
 * ## The rule, exactly (decided 29 September 2026, after the review of PR 311)
 *
 * A visible opt-out link is a URL or `mailto:` that appears **on the same line as, or on
 * the line immediately before or after, an opt-out phrase**. Bodies are plain text and a
 * subject is one line, so that is what "the link and its label" means here: a label
 * above its link, a link above its label, or both in one sentence.
 *
 * Before matching, the text is normalised so that a lookalike cannot walk past the rule:
 * NFKC, then every named dash to `-`, then every named space to ` `, then the 26 ASCII
 * capitals to their lower-case letters — an explicit map, because both `toLowerCase()`
 * and SQL `lower()` are locale-dependent and would make this two rules rather than one.
 * The same four steps, over the same code points, are what
 * `email_has_optout_link(text)` does in SQL (migration 0024), and
 * `packages/domain/test/db/support/optOutLinkCases.ts` is one table of examples run
 * against both — so the Mac's refusal, the save's refusal and the two CHECKs cannot
 * drift apart.
 *
 * ## What this rule cannot see, and we accept
 *
 *   * **A bare shortener.** `https://short.example/a` with no phrase near it passes: the
 *     stored bytes cannot say where it redirects to. David writes the copy, and the
 *     approval names the rule when it refuses.
 *   * **A confusable letter from another script.** NFKC folds a non-breaking hyphen and
 *     a full-width space; it does not fold a Cyrillic `О` into a Latin `O`.
 *   * **The price of a rule a CHECK can enforce:** "You can opt out by replying. Our
 *     website is https://firm.example" *is* refused, although the website has nothing to
 *     do with opting out. A rule that could tell those apart is not a rule a CHECK can
 *     apply, and the answer to a false refusal is to put the website on another line.
 */
const OPT_OUT_PHRASES = String.raw`unsubscribe|opt[ -]?out|remove me|stop receiving|stop these (?:emails|messages)|no longer receive|list-manage|manage (?:your )?preferences`;
const URL_TOKEN = String.raw`https?://|www\.|mailto:`;

/**
 * The dashes folded to `-` before matching, and the spaces folded to ` `. Named code
 * point by code point because migration 0024's `translate()` names exactly these and the
 * two lists have to be the same list.
 */
export const OPT_OUT_DASH_CODE_POINTS =
  '\u002D\u058A\u05BE\u1806\u2010\u2011\u2012\u2013\u2014\u2015\u2212\u2E3A\u2E3B\u301C\u3030\uFE58\uFE63\uFF0D';
export const OPT_OUT_SPACE_CODE_POINTS =
  '\u0009\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u200B\u202F\u205F\u3000';

/** What each list above is translated *to*, character for character. */
export const OPT_OUT_DASH_REPLACEMENT = '------------------';
export const OPT_OUT_SPACE_REPLACEMENT = '                   ';

/**
 * The case step, in full: 26 letters, and no locale anywhere near it.
 *
 * **Not** `toLowerCase()` and **not** SQL `lower()`. Both are locale-dependent, and in a
 * Turkish locale they disagree about `I` — the database and the Mac would then be
 * applying two different rules (review of PR 311, second round). Every phrase is ASCII
 * and NFKC has already folded a full-width letter into an ASCII one, so these 26 pairs
 * are the whole of it, and migration 0024's `translate()` names the same two strings.
 */
export const OPT_OUT_UPPERCASE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const OPT_OUT_LOWERCASE = 'abcdefghijklmnopqrstuvwxyz';

/** `translate()`, character for character, so the SQL and the TypeScript are one rule. */
const translate = (text: string, from: string, to: string): string =>
  [...text]
    .map(character => {
      const at = from.indexOf(character);
      return at === -1 ? character : (to[at] ?? character);
    })
    .join('');

/**
 * The bytes the rule is applied to: NFKC, dashes, spaces, ASCII case — in that order,
 * which is the order `email_has_optout_link` applies them in, with the same three
 * translation tables. A newline is never folded: the rule counts lines.
 */
export function normalizeForOptOutRule(text: string): string {
  const dashed = translate(text.normalize('NFKC'), OPT_OUT_DASH_CODE_POINTS, OPT_OUT_DASH_REPLACEMENT);
  const spaced = translate(dashed, OPT_OUT_SPACE_CODE_POINTS, OPT_OUT_SPACE_REPLACEMENT);
  return translate(spaced, OPT_OUT_UPPERCASE, OPT_OUT_LOWERCASE);
}

/**
 * The opt-out-link shape over normalised text: a phrase and a URL on one line, or on two
 * lines that touch, in either order. No `i` flag and no `\s`: the normalisation has
 * already done the folding, so this pattern and the SQL one are the same pattern.
 */
export const OPT_OUT_LINK_PATTERN = new RegExp(
  [
    `(?:${OPT_OUT_PHRASES})[^\\n]*(?:\\n[^\\n]*)?(?:${URL_TOKEN})`,
    `(?:${URL_TOKEN})[^\\n]*(?:\\n[^\\n]*)?(?:${OPT_OUT_PHRASES})`,
  ].join('|'),
  'u',
);

/** Whether a subject, a body or a sign-off carries a visible opt-out link. */
export function hasOptOutLink(text: string): boolean {
  return OPT_OUT_LINK_PATTERN.test(normalizeForOptOutRule(text));
}

/** The refusal the Mac shows, and the sentence the rule is written as. */
export const NO_OPTOUT_LINK_RULE =
  'Leave out any opt-out link: Callie takes a stop request in ordinary language, so write "reply unsubscribe" rather than putting a link near those words.';

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
