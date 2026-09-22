import { createHash } from 'node:crypto';
import { SENDING_STOP_LINE } from '@fss/contracts';

/**
 * Template content hash and footer block (specification 11.1, 12.6).
 *
 * Ported from `src/shared/contracts/replyTemplateContract.ts` and
 * `cloud/lambdas/delegated-worker/src/v1/templates.ts`. Two rules survive unchanged:
 *
 *   * the content hash covers the exact text that may be sent — identity, version,
 *     subject and body — so an approval is bound to bytes rather than to a name, and
 *     an edit leaves the approval behind;
 *   * a body may not be approved unless it ends with the footer block.
 *
 * The block is the sign-off and then the stop line. It carried a postal address
 * between the two until 22 September 2026;
 * `docs/decisions/g20-automated-email-carries-no-postal-address.md` records David's
 * decision that it does not, and the three specification lines that deviates from.
 * The stop line stays, so 12.6 still holds in full: every automated template explains
 * how to stop by replying, and no web unsubscribe link is included.
 *
 * What does not survive from the old module is its hard-coded sign-off, which carried
 * a real name, phone number and site. The sign-off is workspace configuration here;
 * no repository file carries a real contact detail.
 */

/** The one stop line every approved body ends with. It lives in `@fss/contracts` so the Mac reads the same bytes. */
export { SENDING_STOP_LINE };

export const TEMPLATE_SUBJECT_MAX_LENGTH = 160;
export const TEMPLATE_BODY_MAX_LENGTH = 4000;
export const TEMPLATE_MAX_WORDS = 89;
export const TEMPLATE_MAX_URLS = 1;

/**
 * No pricing and no guarantees. Ordinary words that merely describe a customer's own
 * cost are not on this list: the refusal is about claims the sender makes, not about
 * what the recipient already pays.
 */
export const TEMPLATE_FORBIDDEN_PHRASES: readonly string[] = Object.freeze([
  'guarantee', 'guaranteed', 'guarantees', 'warranty', 'pricing', 'price', 'priced', 'prices', 'discount',
  'free trial', 'risk-free', 'money back', 'refund', 'we promise', 'i promise', 'we will', 'we guarantee',
  'no obligation', 'roi',
]);

export interface FooterConfiguration {
  /** The workspace's approved sign-off block. Configuration; never a literal in this repository. */
  readonly signOff: string;
  /** Overridable only to test the rule; production uses SENDING_STOP_LINE. */
  readonly stopLine?: string | undefined;
}

/** The footer block a body must end with: the sign-off, then the stop line. Nothing between them. */
export function footerBlock(configuration: FooterConfiguration): string {
  return `${configuration.signOff.trim()}\n${configuration.stopLine ?? SENDING_STOP_LINE}`;
}

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
  readonly footer: FooterConfiguration;
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
  if (countUrls(subject) > 0) issues.push('template_subject_url');

  if (body.length > TEMPLATE_BODY_MAX_LENGTH) issues.push('template_body_too_long_in_characters');
  // eslint-disable-next-line no-control-regex -- control characters are exactly what this refuses
  if (/[\x00-\x08\x0b-\x1f\x7f]|\r/.test(body)) issues.push('template_body_not_plain_text');
  if (/<[a-z/!][^>]*>/i.test(body)) issues.push('template_body_markup');
  if (countWords(body) > TEMPLATE_MAX_WORDS) issues.push('template_body_too_long');
  if (countUrls(body) > TEMPLATE_MAX_URLS) issues.push('template_body_multiple_urls');

  // 12.6: the body ends with the sign-off and then the stop line, so the sentence that
  // says how to stop is the last thing a prospect reads. `endsWith`, not `includes`:
  // a stop line buried mid-body is not a footer.
  const footer = footerBlock(rules.footer);
  if (!body.endsWith(footer)) issues.push('template_footer_missing');
  if (rules.requiredSentence !== undefined && !body.includes(rules.requiredSentence)) {
    issues.push('template_required_sentence_missing');
  }

  const lowered = `${subject}\n${body}`.toLowerCase();
  if (
    TEMPLATE_FORBIDDEN_PHRASES.some(phrase =>
      new RegExp(`(^|[^a-z])${phrase.replace(/[-.]/g, '\\$&')}([^a-z]|$)`).test(lowered),
    ) ||
    /[$€£]\s?\d|\d\s?%/.test(lowered)
  ) {
    issues.push('template_pricing_or_guarantee_language');
  }

  const allowed = new Set(rules.allowedVariables);
  const used = [...placeholders(subject), ...placeholders(body)];
  if (used.some(name => !allowed.has(name))) issues.push('template_unknown_variable');

  return issues;
}

export type TemplateApprovalDecision =
  | { readonly approved: true; readonly contentHash: string }
  | { readonly approved: false; readonly reason: 'template_unapproved'; readonly issues: readonly string[] };

/**
 * Whether a template may carry a standing approval. Approving is never sending; this
 * only decides whether a later send is permitted to use the text at all.
 */
export function decideTemplateApproval(
  template: TemplateIdentity & TemplateText,
  rules: TemplateRules,
): TemplateApprovalDecision {
  const issues = templateTextIssues(template, rules);
  return issues.length === 0
    ? { approved: true, contentHash: templateContentHash(template) }
    : { approved: false, reason: 'template_unapproved', issues };
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
