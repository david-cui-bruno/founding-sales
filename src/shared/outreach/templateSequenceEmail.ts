import { z } from 'zod';

import { accountIdSchema } from '../contracts/accountContract';
import { REPLY_TEMPLATE_IDS, type ReplyTemplateId, type ReplyTemplateValues } from '../contracts/replyTemplateContract';
import { sha256Utf8 } from '../crypto/sha256';

/**
 * The identities and the values of one territory sequence email step (D13, lane 40).
 *
 * Everything here is pure and derived. The worker mints the command id, the action id and the
 * permission id from the same three facts — the firm, the template and the sequence step — so a
 * retried tick reaches exactly the records the first tick made instead of sending a second email.
 * Deriving an identity is not a permission: the send still needs the standing approval, the cited
 * business email claim, the recorded permission and its own reservation.
 *
 * The action id carries the template id in plain text, because the desktop has to be able to say
 * "Sent T4 to {firm}" from the one record the worker's `action.outcome` event actually leaves on
 * this Mac (`delegated_action_outcomes`), and that row carries the action id and nothing else that
 * names a template. The id is worker-minted and the row is append-only and immutable, so reading
 * the template id off it is exactly as trustworthy as the outcome row itself. Nothing is read from
 * the text that went out, and an action id that is not this shape reads as no template at all.
 */
const identity = z.strictObject({ accountId: accountIdSchema, templateId: z.enum(REPLY_TEMPLATE_IDS), stepId: accountIdSchema });
export type TemplateSequenceEmailIdentity = z.infer<typeof identity>;

const derive = (kind: string, input: TemplateSequenceEmailIdentity): string =>
  sha256Utf8(JSON.stringify({ kind, version: 1, accountId: input.accountId, templateId: input.templateId, stepId: input.stepId }));

/** The prefix every template sequence action id carries, so the desktop recognizes one without reversing a hash. */
export const TEMPLATE_SEQUENCE_ACTION_PREFIX = 'template-email';
const ACTION_ID = new RegExp(`^${TEMPLATE_SEQUENCE_ACTION_PREFIX}-(${REPLY_TEMPLATE_IDS.join('|')})-([a-f0-9]{32})$`);

/** One action per (firm, template, step). A replayed tick prepares the same action instead of a second one. */
export function templateSequenceEmailActionId(input: TemplateSequenceEmailIdentity): string {
  const parsed = identity.parse(input);
  return `${TEMPLATE_SEQUENCE_ACTION_PREFIX}-${parsed.templateId}-${derive('template_sequence_email_action', parsed).slice(0, 32)}`;
}

/** The template a worker-minted action id names, or null for any id that is not one. Never inferred from a message body. */
export function templateSequenceEmailTemplateId(actionId: unknown): ReplyTemplateId | null {
  if (typeof actionId !== 'string') return null;
  const match = ACTION_ID.exec(actionId);
  return match ? (match[1] as ReplyTemplateId) : null;
}

/** The command id the dispatch intent and the frozen message share. UUID-shaped, so every existing schema accepts it. */
export function templateSequenceEmailCommandId(input: TemplateSequenceEmailIdentity): string {
  const digest = derive('template_sequence_email_command', identity.parse(input));
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/** The recorded permission to write to this firm's published inbox for this step. One per (firm, template, step). */
export function templateSequenceEmailPermissionId(input: TemplateSequenceEmailIdentity): string {
  return `template-permission-${derive('template_sequence_email_permission', identity.parse(input)).slice(0, 32)}`;
}

/**
 * The city a firm's own saved Google Places listing states, read from the excerpt the worker stored
 * and from nothing else. Pure and total: an excerpt that is not that listing, or a formatted address
 * with no state token, yields null rather than a guess. A street is never read as a city, because
 * without the state token nothing says which part of the address is which.
 */
const COUNTRY_WORDS = new Set(['usa', 'us', 'united states', 'united states of america']);
const STATE_TOKEN = /^([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?$/;
export function templateSequenceListingCity(excerpt: string): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(excerpt); } catch { return null; }
  if (parsed === null || typeof parsed !== 'object') return null;
  const address = (parsed as { formattedAddress?: unknown }).formattedAddress;
  if (typeof address !== 'string' || address.trim().length === 0) return null;
  const parts = address.split(',').map(part => part.trim()).filter(part => part.length > 0);
  const last = parts.length > 0 ? parts[parts.length - 1] : undefined;
  if (last !== undefined && COUNTRY_WORDS.has(last.toLowerCase())) parts.pop();
  const tail = parts.length > 0 ? STATE_TOKEN.exec(parts[parts.length - 1]!) : null;
  return tail && parts.length >= 2 ? parts[parts.length - 2]! : null;
}

/**
 * The values a sequence email step may fill for one firm, from records the firm's own account row
 * already carries: the name the account is stored under, and the city its saved Places listing
 * states. Nothing is invented and nothing is defaulted — a value this cannot find is left absent, so
 * the template decision holds the step with `template_variable_missing` instead of sending a gap.
 */
export function templateSequenceEmailValues(input: { name: string; sources: readonly { excerpt: string }[] }): ReplyTemplateValues {
  const firm = input.name.trim();
  let city: string | null = null;
  for (const source of input.sources) {
    city = templateSequenceListingCity(source.excerpt);
    if (city !== null) break;
  }
  return { ...(firm.length ? { firm } : {}), ...(city !== null ? { city } : {}) };
}
