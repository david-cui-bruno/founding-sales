import { SENDING_STOP_LINE, hasOptOutLink } from '@fss/contracts';

/** Browser-safe footer composition shared by server validation and desktop readiness. */

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
  return [configuration.signOff.trim(),address].filter(part=>part.length>0).join('\n');
}

/**
 * The one switch the owner flips to make the address compulsory.
 *
 * David's decision of 27 September 2026 (plan rev 3, "Sending across 0020"): an absent
 * address is **not** a refusal — the footer is then the sign-off alone, and sending
 * continues, because a schema release must not stop sending.
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
   * The body is signed — it carries the legacy stop line, or the sign-off starting a
   * line — and does not *end* with a block this workspace's own records can account for:
   * an address that was never configured here, a sign-off that has since been edited, a
   * postscript under the footer. Nothing is removed and nothing is appended — the body is
   * held for a person to look at.
   */
  'footer_ambiguous',
  /** The composed body is longer than the fence's column allows. */
  'composed_body_too_long',
  /**
   * The composed bytes carry a visible opt-out link — from the sign-off, or from a
   * variable's value, neither of which the approval saw
   * (`apps/api/src/routes/templates.ts` takes `footerSignOff` on its own; a
   * `{firm_website}` can be anything the CRM holds). The database refuses those bytes
   * too (`outbound_messages_no_optout_link`), and this is what makes that refusal a
   * handled hold instead of an exception out of the insert.
   */
  'optout_link',
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
 * and the pre-0024 one, which ends with the stop line. Both are recognised so that a
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
  const heads = signOff.length===0 ? addresses : [signOff, ...addresses.map(address => `${signOff}\n${address}`)];
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
 * must be a **complete separate block**: whole lines, with a blank line before them or
 * the start of the body. A line of spaces or tabs is a blank line (`^[ \t]*$`), because
 * an editor that left one behind must not turn a good footer into a hold. Never a line prefix and never a word suffix — with the sign-off
 * `David`, the body `Hi David` ends with the characters of a block and is not one
 * (the `Hi David` fix, review of PR 264), and `Hello.\nDavid` is a second line of prose
 * as far as anything here can tell (review of PR 311). Nothing of either is removed.
 */
function footerBlockStart(body: string, configuration: SendFooterConfiguration): number | null {
  const stripped = body.replace(/\s+$/u, '');
  for (const block of candidateFooterBlocks(configuration)) {
    if (!stripped.endsWith(block)) continue;
    const start = stripped.length - block.length;
    if (start === 0 || /\n[ \t]*\n$/u.test(stripped.slice(0, start))) return start;
  }
  return null;
}

/**
 * Whether the sign-off stands in this body as whole lines of its own.
 *
 * The ambiguity test, and the reason it is written line by line rather than as a
 * substring search: with the sign-off `Sam`, the body `Hello.\nSam discussed repairs.`
 * mentions the name and is not signed, and holding it would be a false refusal of a
 * perfectly good footerless body (review of PR 311). `Hello.\n\nSam\n\nP.S. call me`
 * *is* signed, and is held.
 */
function signOffStandsAlone(body: string, rawSignOff: string): boolean {
  const signOff = rawSignOff.trim();
  if (signOff.length === 0) return false;
  // Trailing spaces on a line are not a different line: the same tolerance the blank
  // separator gets, so the two halves of the recognition agree about whitespace.
  const trimEnd = (line: string): string => line.replace(/[ \t]+$/u, '');
  const lines = body.split('\n').map(trimEnd);
  const block = signOff.split('\n').map(trimEnd);
  for (let start = 0; start + block.length <= lines.length; start += 1) {
    if (block.every((line, offset) => lines[start + offset] === line)) return true;
  }
  return false;
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
  // No recognised block, but the body is signed all the same: the legacy stop line is in
  // there somewhere, or the sign-off stands as whole lines of its own — an address this
  // workspace never recorded under it, a postscript after it, a sign-off since edited.
  // Appending the block would send the sign-off twice and removing anything would mean
  // guessing which words are the footer, so the body is held for a person to look at.
  if (blockStart === null && (stripped.includes(stopLine) || signOffStandsAlone(stripped, configuration.signOff))) {
    return { composed: false, reason: 'footer_ambiguous' };
  }
  const head = body.slice(0, blockStart ?? stripped.length);
  const footer = sendFooterBlock(configuration);
  const composedBody = head.trim().length === 0 ? footer : `${head.replace(/\s+$/u, '')}\n\n${footer}`;

  // Its own output, checked before it is returned (the P0 of the review of PR 296, kept
  // under the new rule). A legacy stop line anywhere in the bytes that would leave — in
  // the head above a block that was recognised, or inside a sign-off that still carries
  // the old sentence — is a body nobody may compose: the line is exactly what this
  // release removes, and which words are the footer is not a thing to guess at.
  if (composedBody.includes(stopLine)) return { composed: false, reason: 'footer_ambiguous' };
  if (sendBodyIssue(composedBody) === 'body_too_long') {
    return { composed: false, reason: 'composed_body_too_long', detail: String(composedBody.length) };
  }
  // The sign-off is not part of an approved body and a variable's value is not either,
  // so this is the first place the *final* bytes are seen (review of PR 311, P1-2).
  if (hasOptOutLink(composedBody)) return { composed: false, reason: 'optout_link' };
  return { composed: true, body: composedBody, changed: composedBody !== body, deduped: blockStart !== null };
}

/**
 * What is wrong with a body about to be frozen on a fence, or null when nothing is.
 *
 * The fence's own guard (`prepareOutboundMessage`), so that no path — a caller that
 * forgot to compose, a fence prepared by an older release — can store bytes the fence's
 * column would refuse. It asks about the bytes and nothing else, and since migration
 * 0024 removed the mandatory last line there is exactly one such question left: the
 * length. Whether the *footer* is right is a question about the workspace's sign-off,
 * which this function is not given and never guessed at (`composeSendBody`).
 */
export function sendBodyIssue(body: string): 'body_too_long' | null {
  return body.length > SENT_BODY_MAX_LENGTH ? 'body_too_long' : null;
}
