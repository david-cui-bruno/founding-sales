/**
 * The one sentence every approved automated template ends with (specification 12.6:
 * reply-based opt-out, no web unsubscribe link).
 *
 * It is here rather than in `@fss/domain` because two packages need the same bytes:
 * the approval rule in `packages/domain/src/rules/templates.ts`, which refuses a body
 * that does not end with the footer block, and the Mac's template panel, which shows
 * that block and says whether the body carries it. The desktop depends on
 * `@fss/contracts` and not on `@fss/domain`, so a copy in the renderer would be a
 * second spelling of a sentence that has to have one.
 *
 * `@fss/domain` re-exports it, so every existing importer is unchanged.
 */
export const SENDING_STOP_LINE = 'Reply "stop" and I will not email you again.';

/**
 * The variables a template may name, and the only ones (specification 11.1: "Launch
 * templates support deterministic variables from eligible CRM data").
 *
 * Here since lane g88, for the reason the stop line is: the domain fills them
 * (`templateVariablesFor` in `packages/domain/sequences/variables.ts`, which re-exports
 * this list) and the Mac's template form names them to the person writing one, and a
 * second spelling on the Mac would be a list that drifts from the one that fills them.
 * A template that names anything else would hold every step that uses it for
 * `missing_variables`, so the form says so before it is sent.
 */
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
 * is what a send or the law depends on: the sign-off and stop line at the end, no
 * markup, plain text, a one-line subject, and only variables Callie can fill.
 */
export const TEMPLATE_WARNING_CODES = [
  'template_body_too_long',
  'template_body_multiple_urls',
  'template_subject_url',
  'template_pricing_or_guarantee_language',
] as const;
export type TemplateWarningCode = (typeof TEMPLATE_WARNING_CODES)[number];
