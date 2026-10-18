import { createHash } from 'node:crypto';
import { APPROVAL_FOOTER_POLICY, composeSendBody, type SendFooterConfiguration } from './templateFooter.ts';
import {
  NO_OPTOUT_LINK_RULE,
  OPT_OUT_LINK_PATTERN,
  SENDING_STOP_LINE,
  TEMPLATE_WARNING_CODES,
  hasOptOutLink,
  type TemplateWarningCode,
} from '@fss/contracts';

/**
 * Template content hash and footer block (specification 11.1, 12.6).
 *
 * Ported from `src/shared/contracts/replyTemplateContract.ts` and
 * `cloud/lambdas/delegated-worker/src/v1/templates.ts`. Two rules survive unchanged:
 *
 *   * the content hash covers the exact text that may be sent — identity, version,
 *     subject and body — so an approval is bound to bytes rather than to a name, and
 *     an edit in place recomputes it (wave 2, S3);
 *   * a body may be approved only if Callie can give it exactly one footer block, which
 *     since migration 0024 is the sign-off (and the workspace's postal address when it
 *     has one) and nothing else. The rule applies unconditionally: at every approval and
 *     on every save of an approved version.
 *
 * The copy rules — word count, links, price and guarantee wording — are warnings since
 * 26 September 2026 (`TEMPLATE_WARNING_CODES`): an approval reports them and approves.
 *
 * The block is the sign-off, then the workspace's postal address when it has one. The
 * address left the block on 22 September 2026
 * (`docs/archive/decisions/g20-automated-email-carries-no-postal-address.md`) and came
 * back on 27 September as a *setting* rather than a template column, composed at send
 * (migration 0020, lane W3-F): reversing G20 is a new migration, not a revert.
 *
 * **The stop line went on 29 September 2026** (David: "remove the mandatory 'Reply
 * "stop"' footer and remove the blanket database ban on the word 'unsubscribe.'";
 * `docs/greenfield/decisions/email-presentation-20260929.md`). Nothing appends
 * `SENDING_STOP_LINE` any more. What is left of 12.6 is the part David kept: **no
 * visible opt-out link** (`NO_OPTOUT_LINK_RULE`, `hasOptOutLink`, and migration 0024's
 * two `*_no_optout_link` CHECKs), and a stop request in ordinary language still
 * suppresses (`rules/replyClassification.ts`, untouched by that decision).
 *
 * **The footer is composed at send, before the fence freezes the bytes.** `composeSendBody`
 * is the one function that decides the final text: it removes a recognised footer block —
 * and nothing else, never the sign-off a second time — and appends the block the
 * workspace's configuration says now. A recognised block is one this workspace's records
 * can rebuild, in today's shape or in the pre-0024 shape that ends with the stop line, so
 * a template approved or a fence prepared before the decision loses the line at send
 * rather than keeping it forever.
 *
 * What does not survive from the old module is its hard-coded sign-off, which carried
 * a real name, phone number and site. The sign-off is workspace configuration here;
 * no repository file carries a real contact detail.
 */

/**
 * The pre-0024 stop line: recognised so it can be removed, never appended. It lives in
 * `@fss/contracts` so the Mac reads the same bytes, and so does the opt-out-link rule.
 */
export {
  SENDING_STOP_LINE,
  NO_OPTOUT_LINK_RULE,
  OPT_OUT_LINK_PATTERN,
  hasOptOutLink,
  TEMPLATE_WARNING_CODES,
  type TemplateWarningCode,
};

export const TEMPLATE_SUBJECT_MAX_LENGTH = 160;
export const TEMPLATE_BODY_MAX_LENGTH = 4000;
export const TEMPLATE_MAX_WORDS = 89;
export const TEMPLATE_MAX_URLS = 1;

/**
 * Pricing and guarantee wording, which an approval warns about. Ordinary words that
 * merely describe a customer's own cost are not on this list: the warning is about
 * claims the sender makes, not about what the recipient already pays.
 */
export const TEMPLATE_FORBIDDEN_PHRASES: readonly string[] = Object.freeze([
  'guarantee', 'guaranteed', 'guarantees', 'warranty', 'pricing', 'price', 'priced', 'prices', 'discount',
  'free trial', 'risk-free', 'money back', 'refund', 'we promise', 'i promise', 'we will', 'we guarantee',
  'no obligation', 'roi',
]);

// Keep the server's public API stable while the renderer imports only the pure seam.
export * from './templateFooter.ts';

export interface TemplateText {
  readonly subject: string;
  readonly body: string;
}

export interface TemplateIdentity {
  readonly templateId: string;
  readonly version: number;
}

/**
 * The exact text the worker is allowed to send. The hash covers identity, version,
 * subject and body and nothing else, so two templates with the same words but
 * different versions hash differently and an approval cannot drift onto a new edit.
 */
export function templateContentHash(template: TemplateIdentity & TemplateText): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        kind: 'template_content',
        version: 1,
        templateId: template.templateId,
        templateVersion: template.version,
        subject: template.subject,
        body: template.body,
      }),
      'utf8',
    )
    .digest('hex');
}

const countWords = (value: string): number => (value.trim().length === 0 ? 0 : value.trim().split(/\s+/).length);
const countUrls = (value: string): number => (value.match(/https?:\/\//g) ?? []).length;
const placeholders = (value: string): string[] => (value.match(/\{[^{}]*\}/g) ?? []).map(match => match.slice(1, -1));

export interface TemplateRules {
  /** The workspace's footer. A postal address here is composed in; approvals never require one. */
  readonly footer: SendFooterConfiguration;
  /** The variable names a body or subject may name. Anything else is refused. */
  readonly allowedVariables: readonly string[];
  /** A sentence the approved body must contain, when the workspace requires one. */
  readonly requiredSentence?: string | undefined;
}

/**
 * Every rule an approved template must satisfy, as one refusal list. Each entry names
 * itself; the caller shows them all rather than only the first, because an author
 * fixing one at a time is a worse experience than fixing four at once.
 */
export function templateTextIssues(text: TemplateText, rules: TemplateRules): string[] {
  const issues: string[] = [];
  const { subject, body } = text;

  if (subject.trim().length === 0) issues.push('template_subject_empty');
  if (subject.length > TEMPLATE_SUBJECT_MAX_LENGTH) issues.push('template_subject_too_long');
  // eslint-disable-next-line no-control-regex -- control characters are exactly what this refuses
  if (/[\x00-\x1f\x7f]/.test(subject)) issues.push('template_subject_not_one_line');

  if (body.length > TEMPLATE_BODY_MAX_LENGTH) issues.push('template_body_too_long_in_characters');
  // eslint-disable-next-line no-control-regex -- control characters are exactly what this refuses
  if (/[\x00-\x08\x0b-\x1f\x7f]|\r/.test(body)) issues.push('template_body_not_plain_text');
  if (/<[a-z/!][^>]*>/i.test(body)) issues.push('template_body_markup');

  // What is left of 12.6 after 29 September 2026: no visible opt-out link. The word is
  // allowed — "just reply unsubscribe and I'll stop" is a sentence we want — and this is
  // the same rule migration 0024's CHECKs apply, so the save cannot offer an approval the
  // database would answer with a 500.
  //
  // The **sign-off** is checked here with the subject and the body, because it is not
  // part of either: `POST /templates` takes it as a field of its own, so an approval that
  // looked only at what the author typed would clear bytes that carry a link
  // (review of PR 311, P1-2). The composed bytes are checked again below.
  if (hasOptOutLink(subject) || hasOptOutLink(body) || hasOptOutLink(rules.footer.signOff)) {
    issues.push('template_optout_link');
  }

  // A sign-off that still carries the old stop sentence is refused before anything else
  // is said about the body: every send composed under it would carry a line this release
  // exists to remove, and `composeSendBody` refuses those bytes (review of PR 311, P1-3).
  const stopLine = rules.footer.stopLine ?? SENDING_STOP_LINE;
  const signOffRepeatsStopLine = rules.footer.signOff.includes(stopLine);
  if (signOffRepeatsStopLine) issues.push('template_sign_off_repeats_stop_line');

  // Since the footer is composed at send (lane W3-F), the rule is not "the body ends with
  // the block" but "the body can be given exactly one final block": **both shapes are
  // approvable**, the one with the block already inside the body — which desktop 1.0.11
  // requires before it will enable Approve — and the footerless one, which the desktop
  // after it writes. What is refused is a body whose trailing block this workspace's
  // records cannot account for, including one carrying the legacy stop line somewhere of
  // its own: composing it would mean guessing which words are the footer (review of PR
  // 296).
  // Composed under `APPROVAL_FOOTER_POLICY`, with no address and none recorded: an
  // approval may not turn on whether the workspace has configured one, nor on the
  // switch's position, nor on an address it might configure later. The address's own
  // length is checked again at send, where it is a handled hold.
  const composed = composeSendBody(
    body,
    { ...rules.footer, postalAddress: null, recordedAddresses: [] },
    APPROVAL_FOOTER_POLICY,
  );
  if (!composed.composed && !signOffRepeatsStopLine) {
    const issue =
      composed.reason === 'composed_body_too_long'
        ? 'template_body_too_long_in_characters'
        : composed.reason === 'optout_link'
          ? 'template_optout_link'
          : 'template_footer_missing';
    if (!issues.includes(issue)) issues.push(issue);
  }
  if (rules.requiredSentence !== undefined && !body.includes(rules.requiredSentence)) {
    issues.push('template_required_sentence_missing');
  }

  const allowed = new Set(rules.allowedVariables);
  const used = [...placeholders(subject), ...placeholders(body)];
  if (used.some(name => !allowed.has(name))) issues.push('template_unknown_variable');

  return issues;
}

/** The copy advice a template's text raises. None of it stops an approval. */
export function templateTextWarnings(text: TemplateText): TemplateWarningCode[] {
  const warnings: TemplateWarningCode[] = [];
  const { subject, body } = text;
  if (countWords(body) > TEMPLATE_MAX_WORDS) warnings.push('template_body_too_long');
  if (countUrls(body) > TEMPLATE_MAX_URLS) warnings.push('template_body_multiple_urls');
  if (countUrls(subject) > 0) warnings.push('template_subject_url');
  const lowered = `${subject}\n${body}`.toLowerCase();
  if (
    TEMPLATE_FORBIDDEN_PHRASES.some(phrase =>
      new RegExp(`(^|[^a-z])${phrase.replace(/[-.]/g, '\\$&')}([^a-z]|$)`).test(lowered),
    ) ||
    /[$€£]\s?\d|\d\s?%/.test(lowered)
  ) {
    warnings.push('template_pricing_or_guarantee_language');
  }
  return warnings;
}

export type TemplateApprovalDecision =
  | { readonly approved: true; readonly contentHash: string; readonly warnings: readonly TemplateWarningCode[] }
  | {
      readonly approved: false;
      readonly reason: 'template_unapproved';
      readonly issues: readonly string[];
      readonly warnings: readonly TemplateWarningCode[];
    };

/**
 * Whether a template may carry a standing approval. Approving is never sending; this
 * only decides whether a later send is permitted to use the text at all. The warnings
 * travel either way.
 */
export function decideTemplateApproval(
  template: TemplateIdentity & TemplateText,
  rules: TemplateRules,
): TemplateApprovalDecision {
  const issues = templateTextIssues(template, rules);
  const warnings = templateTextWarnings(template);
  return issues.length === 0
    ? { approved: true, contentHash: templateContentHash(template), warnings }
    : { approved: false, reason: 'template_unapproved', issues, warnings };
}

export type RenderDecision =
  | { readonly rendered: true; readonly subject: string; readonly body: string }
  | { readonly rendered: false; readonly reason: 'missing_variables'; readonly missing: readonly string[] };

/**
 * Substitute deterministic variables. A required variable with no eligible value holds
 * the step (`missing_variables`); it is never rendered as an empty string or a guess.
 */
export function renderTemplate(
  text: TemplateText,
  values: Readonly<Record<string, string>>,
): RenderDecision {
  const missing = new Set<string>();
  const substitute = (value: string): string =>
    value.replace(/\{([^{}]*)\}/g, (_match, name: string) => {
      const replacement = values[name];
      if (replacement === undefined || replacement.trim().length === 0) {
        missing.add(name);
        return '';
      }
      return replacement;
    });
  const subject = substitute(text.subject);
  const body = substitute(text.body);
  return missing.size === 0
    ? { rendered: true, subject, body }
    : { rendered: false, reason: 'missing_variables', missing: [...missing].sort() };
}
