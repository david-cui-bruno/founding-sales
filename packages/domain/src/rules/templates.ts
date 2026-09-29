import { createHash } from 'node:crypto';
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
 *     since migration 0023 is the sign-off (and the workspace's postal address when it
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
 * visible opt-out link** (`NO_OPTOUT_LINK_RULE`, `hasOptOutLink`, and migration 0023's
 * two `*_no_optout_link` CHECKs), and a stop request in ordinary language still
 * suppresses (`rules/replyClassification.ts`, untouched by that decision).
 *
 * **The footer is composed at send, before the fence freezes the bytes.** `composeSendBody`
 * is the one function that decides the final text: it removes a recognised footer block —
 * and nothing else, never the sign-off a second time — and appends the block the
 * workspace's configuration says now. A recognised block is one this workspace's records
 * can rebuild, in today's shape or in the pre-0023 shape that ends with the stop line, so
 * a template approved or a fence prepared before the decision loses the line at send
 * rather than keeping it forever.
 *
 * What does not survive from the old module is its hard-coded sign-off, which carried
 * a real name, phone number and site. The sign-off is workspace configuration here;
 * no repository file carries a real contact detail.
 */

/**
 * The legacy stop line: recognised so it can be removed, never appended. It lives in
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
 * What a *sent* body may be, which is not what a *template* body may be.
 *
 * Migration 0010's `outbound_messages_body_bounded` refuses a fence body over 4,000
 * characters, and the composed body is the template's words plus a footer the template
 * did not carry. The two limits are the same number and they are not the same rule: the
 * template limit is the API's, and this one is the database's answer about the bytes that
 * leave. A composed body over it is a handled hold, never an exception from the insert.
 */
export const SENT_BODY_MAX_LENGTH = 4000;


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

export interface FooterConfiguration {
  /** The workspace's approved sign-off block. Configuration; never a literal in this repository. */
  readonly signOff: string;
  /**
   * The legacy last line, recognised at the end of a body so it can be removed. Never
   * appended. Overridable only to test the rule; production uses SENDING_STOP_LINE.
   */
  readonly stopLine?: string | undefined;
}

/**
 * The footer configuration a *send* composes with: the workspace's sign-off and, when the
 * workspace has configured one, its postal address (`postal_address`, migration 0020).
 */
export interface SendFooterConfiguration extends FooterConfiguration {
  /** The `postal_address` setting in force, or null when none is configured. */
  readonly postalAddress?: string | null | undefined;
  /**
   * Every address this workspace has ever recorded — the `postal_address` setting's
   * superseded versions (`readRecordedPostalAddresses`).
   *
   * This is **provenance, not a guess** (review of PR 296). The composition replaces a
   * footer block only when it can rebuild that block from something the database
   * recorded: the sign-off the template version carries, and an address this workspace
   * actually configured. A body ending in a stop line the composition cannot account for
   * is held for review rather than edited, because the alternative is a line-counting
   * heuristic that would delete `Please call Tuesday.` from an approved body.
   */
  readonly recordedAddresses?: readonly string[] | undefined;
}

/** The block a send appends: the sign-off, and the address when there is one. Nothing else. */
export function sendFooterBlock(configuration: SendFooterConfiguration): string {
  const address = configuration.postalAddress?.trim() ?? '';
  return address.length === 0 ? configuration.signOff.trim() : `${configuration.signOff.trim()}\n${address}`;
}

/**
 * The one switch the owner flips to make the address compulsory.
 *
 * David's decision of 27 September 2026 (plan rev 3, "Sending across 0020"): an absent
 * address is **not** a refusal — the footer is the sign-off and the stop line, exactly
 * today's bytes, and sending continues, because a schema release must not stop sending.
 * The stricter alternative the reviewer asked for — refuse every send until the address
 * is configured — is this one boolean, and both positions are tested
 * (`packages/domain/test/domain/rules.test.ts`, `test/outbound/footerAtSend.test.ts`).
 */
export interface SendFooterPolicy {
  readonly postalAddressRequired: boolean;
}

export const SEND_FOOTER_POLICY: SendFooterPolicy = Object.freeze({ postalAddressRequired: false });

/** A policy that never demands an address: what an *approval* composes under, whatever the switch says. */
export const APPROVAL_FOOTER_POLICY: SendFooterPolicy = Object.freeze({ postalAddressRequired: false });

export const COMPOSE_SEND_BODY_REFUSALS = [
  /** The switch is on and the workspace has configured no address. */
  'postal_address_required',
  /**
   * The body carries the stop line and does not end with a block this workspace's own
   * records can account for: an address that was never configured here, a sign-off that
   * has since been edited, a stop line in the middle of the text. Nothing is removed and
   * nothing is appended — the body is held for a person to look at.
   */
  'footer_ambiguous',
  /** The composed body is longer than the fence's column allows. */
  'composed_body_too_long',
] as const;
export type ComposeSendBodyRefusal = (typeof COMPOSE_SEND_BODY_REFUSALS)[number];

export type ComposeSendBodyDecision =
  | {
      readonly composed: true;
      readonly body: string;
      /** False when the body already carried exactly these bytes: nothing to rewrite. */
      readonly changed: boolean;
      /** True when a legacy footer block was recognised and replaced. */
      readonly deduped: boolean;
    }
  | { readonly composed: false; readonly reason: ComposeSendBodyRefusal; readonly detail?: string | undefined };

/**
 * Every footer block this workspace's records can account for, longest first.
 *
 * Each candidate is a string rebuilt from something stored: the sign-off on the template
 * version, and either no address (the block main's approval rule required, since
 * migration 0015) or an address the `postal_address` setting recorded. Nothing here is
 * inferred from the shape of the body — that is the whole difference between replacing a
 * footer and deleting a sentence somebody wrote.
 *
 * Each block comes in two shapes: today's, which ends with the sign-off or the address,
 * and the pre-0023 one, which ends with the stop line. Both are recognised so that a
 * template approved or a fence prepared before 29 September 2026 has its footer
 * *replaced* — the stop line goes at the next send — instead of a second sign-off
 * appended underneath the first.
 */
function candidateFooterBlocks(configuration: SendFooterConfiguration): readonly string[] {
  const stopLine = configuration.stopLine ?? SENDING_STOP_LINE;
  const signOff = configuration.signOff.trim();
  const addresses = [configuration.postalAddress ?? '', ...(configuration.recordedAddresses ?? [])]
    .map(address => address.trim())
    .filter(address => address.length > 0);
  const heads = [signOff, ...addresses.map(address => `${signOff}\n${address}`)];
  const blocks = new Set<string>();
  for (const head of heads) {
    blocks.add(head);
    blocks.add(`${head}\n${stopLine}`);
  }
  // Longest first: when an address block and the bare block both end the body, the
  // address block is the one that was actually written there.
  return [...blocks].sort((left, right) => right.length - left.length);
}

/**
 * Where a recognised footer block starts inside `body`, or null.
 *
 * The block must be one of `candidateFooterBlocks`, at the very end of the body, and it
 * must start a line. The line boundary is the `Hi David` fix (review of PR 264): with the
 * sign-off `David`, the body `Hi David` before the stop line ends with the characters of
 * a block and is not one, so nothing of it is removed — and, since the review of PR 296,
 * nothing of it is *sent* either: a body like that is ambiguous and held.
 */
function footerBlockStart(body: string, configuration: SendFooterConfiguration): number | null {
  const signOff = configuration.signOff.trim();
  if (signOff.length === 0) return null;
  const stripped = body.replace(/\s+$/u, '');
  for (const block of candidateFooterBlocks(configuration)) {
    if (!stripped.endsWith(block)) continue;
    const start = stripped.length - block.length;
    if (start === 0 || stripped[start - 1] === '\n') return start;
  }
  return null;
}

/**
 * The exact bytes a send will carry: the rendered body with one final footer block.
 *
 * Called **before** the fence stores a body and its hash, so the fence freezes what will
 * actually be sent (`packages/domain/outbound/fence.ts`, `outbound/footer.ts`). It is
 * idempotent: composing a composed body returns the same bytes and `changed: false`, which
 * is what makes reconciling an already-current fence a no-op.
 *
 * Three things can stop it, and each is a handled hold at the caller rather than a
 * mangled send: the switch with no address; a body carrying the legacy stop line in a
 * place this workspace's records cannot account for (`footer_ambiguous` — nothing is
 * removed, a person looks at it); and a composed body the fence's column would refuse.
 */
export function composeSendBody(
  body: string,
  configuration: SendFooterConfiguration,
  policy: SendFooterPolicy = SEND_FOOTER_POLICY,
): ComposeSendBodyDecision {
  const stopLine = configuration.stopLine ?? SENDING_STOP_LINE;
  const address = configuration.postalAddress?.trim() ?? '';
  if (policy.postalAddressRequired && address.length === 0) {
    return { composed: false, reason: 'postal_address_required' };
  }

  const blockStart = footerBlockStart(body, configuration);
  const stripped = body.replace(/\s+$/u, '');
  // No recognised block, but the legacy stop line is in there somewhere: the body is
  // ambiguous and this function does not guess which words are the footer.
  if (blockStart === null && stripped.includes(stopLine)) {
    return { composed: false, reason: 'footer_ambiguous' };
  }
  const head = body.slice(0, blockStart ?? stripped.length);
  const footer = sendFooterBlock(configuration);
  const composedBody = head.trim().length === 0 ? footer : `${head.replace(/\s+$/u, '')}\n\n${footer}`;

  if (sendBodyIssue(composedBody) === 'body_too_long') {
    return { composed: false, reason: 'composed_body_too_long', detail: String(composedBody.length) };
  }
  return { composed: true, body: composedBody, changed: composedBody !== body, deduped: blockStart !== null };
}

/**
 * What is wrong with a body about to be frozen on a fence, or null when nothing is.
 *
 * The fence's own guard (`prepareOutboundMessage`), so that no path — a caller that
 * forgot to compose, a fence prepared by an older release — can store bytes the fence's
 * column would refuse. It asks about the bytes and nothing else, and since migration
 * 0023 removed the mandatory last line there is exactly one such question left: the
 * length. Whether the *footer* is right is a question about the workspace's sign-off,
 * which this function is not given and never guessed at (`composeSendBody`).
 */
export function sendBodyIssue(body: string): 'body_too_long' | null {
  return body.length > SENT_BODY_MAX_LENGTH ? 'body_too_long' : null;
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
  // the same shape migration 0023's CHECKs refuse, so the save cannot offer an approval
  // the database would answer with a 500.
  if (hasOptOutLink(subject) || hasOptOutLink(body)) issues.push('template_optout_link');

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
  if (!composed.composed) {
    const issue =
      composed.reason === 'composed_body_too_long' ? 'template_body_too_long_in_characters' : 'template_footer_missing';
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
