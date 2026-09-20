/**
 * Deterministic reply classification (specification 12.4).
 *
 * Ported from `src/main/outreach/replyClassification.ts`, keeping its quote-boundary
 * and signature-boundary handling — an "unsubscribe" inside a quoted earlier message
 * is evidence about that message, not this sender's intent — and remapped onto the
 * five classes of revision 3.
 *
 * This is the deterministic layer only. It never returns `human` on its own: a human
 * classification sets manual only through deterministic proof or salesperson
 * confirmation, so the only deterministic proof this layer recognises is an explicit
 * opt-out, and everything it cannot prove is `uncertain`. The LLM layer may label and
 * prioritise, but it cannot release a message as automated, close an opportunity,
 * create a suppression from ambiguous language, commit an extracted callback, or
 * resume automation.
 */

export const REPLY_CLASSES = ['human', 'uncertain', 'automated', 'bounce', 'opt_out'] as const;
export type ReplyClass = (typeof REPLY_CLASSES)[number];

/** The standard dispositions of specification 8.3. Advisory until a person confirms one. */
export const REPLY_DISPOSITIONS = [
  'interested',
  'referral_or_wrong_person',
  'follow_up_later',
  'not_interested',
  'opt_out',
  'other',
] as const;
export type ReplyDisposition = (typeof REPLY_DISPOSITIONS)[number];

export interface ReplyHeaders {
  /** RFC 3834. Any value other than `no` marks an automatic response. */
  readonly autoSubmitted?: string | undefined;
  /** RFC 2919. A list posting is not a reply from a prospect. */
  readonly listId?: string | undefined;
  /** RFC 3464 report type, as seen on a delivery status notification. */
  readonly contentType?: string | undefined;
  readonly from?: string | undefined;
  readonly subject?: string | undefined;
}

export interface ReplyBodyPart {
  readonly text: string;
  /** A body the fetch truncated cannot prove an opt-out: the sentence may continue. */
  readonly truncated?: boolean | undefined;
}

export interface ReplyMessage {
  readonly id: string;
  readonly headers: ReplyHeaders;
  readonly bodyParts: readonly ReplyBodyPart[];
}

export interface ReplySignal {
  readonly rule: string;
  readonly evidence: string;
}

export interface ReplyClassification {
  readonly class: ReplyClass;
  /** Advisory. A consequential action needs deterministic proof or confirmation. */
  readonly suggestedDisposition: ReplyDisposition | null;
  readonly signals: readonly ReplySignal[];
  /** Every possibly relevant incoming message holds automation before classification releases anything. */
  readonly requiresConfirmation: boolean;
  readonly messageId: string;
}

/** A vacation or out-of-office body is not retained (specification 12.4); only the fact is. */
const VACATION_PATTERN = /\b(out of (?:the )?office|automatic reply|autoreply|on vacation|annual leave)\b/i;
const TICKET_ACKNOWLEDGEMENT_PATTERN =
  /\b(ticket (?:#|number|id)|case (?:#|number)|your request has been received|we have received your (?:request|message))\b/i;
const DELIVERY_FAILURE_PATTERN =
  /\b(delivery (?:has )?failed|delivery status notification|undeliverable|address not found|mailbox (?:is )?full|recipient address rejected)\b/i;
const DELIVERY_REPORT_CONTENT_TYPES = /(multipart\/report|message\/delivery-status|report-type=delivery-status)/i;

/** The authored part of a reply: above the quote boundary and above the signature. */
export function authoredText(raw: string): string {
  const lines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (/^\s*(?:On .+wrote:|[-_]{2,}\s*(?:Original|Forwarded) Message)/i.test(line)) break;
    if (!/^\s*>/.test(line)) lines.push(line);
  }
  const closing = lines.findIndex(
    (line, index) =>
      index > 0 &&
      lines.slice(0, index).some(part => part.trim().length > 0) &&
      /^[ \t]*(?:thanks|thank you|best(?: regards)?|kind regards|regards|sincerely)[,.!]?[ \t]*$/i.test(line),
  );
  return (closing > 0 ? lines.slice(0, closing).join('\n') : lines.join('\n')).trim();
}

/**
 * An explicit, unambiguous instruction to stop. The sentence must be the whole
 * request: "please unsubscribe me" is an opt-out, "someone told me to unsubscribe
 * from their newsletter" is not, and ambiguous wording stays held for confirmation.
 */
export function hasExplicitOptOut(authored: string): boolean {
  const sentences = authored.replace(/\s+/g, ' ').split(/[.!]/);
  return sentences.some(sentence => {
    const trimmed = sentence.trim();
    return (
      /^(?:please\s+)?(?:unsubscribe(?: me)?|stop (?:emailing|contacting|messaging) me|remove me(?: from (?:your|the) (?:list|mailing list))?|(?:do not|don't) contact me)\s*$/i.test(
        trimmed,
      ) || /,\s*but\s+(?:please\s+)?stop (?:emailing|contacting|messaging) me\s*$/i.test(trimmed)
    );
  });
}

export interface ClassifyReplyOptions {
  /**
   * A salesperson's confirmation. This is the only way the deterministic layer
   * returns `human`: confirmation, or deterministic proof, and nothing else.
   */
  readonly confirmedByUser?:
    | { readonly userId: string; readonly disposition: ReplyDisposition }
    | undefined;
}

export function classifyReply(message: ReplyMessage, options: ClassifyReplyOptions = {}): ReplyClassification {
  const signals: ReplySignal[] = [];
  const raw = message.bodyParts.map(part => part.text).join('\n');
  const authored = authoredText(raw);
  const truncated = message.bodyParts.some(part => part.truncated === true);

  const confirmation = options.confirmedByUser;
  if (confirmation !== undefined) {
    signals.push({ rule: 'salesperson_confirmation', evidence: confirmation.userId });
    return {
      class: confirmation.disposition === 'opt_out' ? 'opt_out' : 'human',
      suggestedDisposition: confirmation.disposition,
      signals,
      requiresConfirmation: false,
      messageId: message.id,
    };
  }

  // 1. Explicit opt-out language. Deterministic proof, and it suppresses immediately.
  //    A truncated body is never proof: the sentence may continue past the cut.
  if (!truncated && hasExplicitOptOut(authored)) {
    signals.push({ rule: 'explicit_opt_out', evidence: authored.slice(0, 200) });
    return {
      class: 'opt_out',
      suggestedDisposition: 'opt_out',
      signals,
      requiresConfirmation: false,
      messageId: message.id,
    };
  }

  // 2. Delivery status notifications. A bounce invalidates the prospect route frozen
  //    on the originating fence, never the reporting daemon's address.
  const contentType = message.headers.contentType ?? '';
  if (DELIVERY_REPORT_CONTENT_TYPES.test(contentType) || DELIVERY_FAILURE_PATTERN.test(raw)) {
    signals.push({ rule: 'delivery_status_notification', evidence: contentType || 'body' });
    return { class: 'bounce', suggestedDisposition: null, signals, requiresConfirmation: true, messageId: message.id };
  }

  // 3. RFC headers, recognised vacation patterns, known ticket acknowledgements.
  const autoSubmitted = message.headers.autoSubmitted;
  if (autoSubmitted !== undefined && autoSubmitted.trim().toLowerCase() !== 'no') {
    signals.push({ rule: 'auto_submitted_header', evidence: autoSubmitted });
    return {
      class: 'automated',
      suggestedDisposition: null,
      signals,
      requiresConfirmation: true,
      messageId: message.id,
    };
  }
  if (message.headers.listId !== undefined && message.headers.listId.trim().length > 0) {
    signals.push({ rule: 'list_id_header', evidence: message.headers.listId });
    return {
      class: 'automated',
      suggestedDisposition: null,
      signals,
      requiresConfirmation: true,
      messageId: message.id,
    };
  }
  if (VACATION_PATTERN.test(raw)) {
    // The body of an out-of-office is not retained; the rule that fired is.
    signals.push({ rule: 'vacation_pattern', evidence: 'matched' });
    return {
      class: 'automated',
      suggestedDisposition: null,
      signals,
      requiresConfirmation: true,
      messageId: message.id,
    };
  }
  if (TICKET_ACKNOWLEDGEMENT_PATTERN.test(raw)) {
    signals.push({ rule: 'ticket_acknowledgement', evidence: 'matched' });
    return {
      class: 'automated',
      suggestedDisposition: null,
      signals,
      requiresConfirmation: true,
      messageId: message.id,
    };
  }

  // 4. Nothing proved. Uncertain is the default, and it holds every automated action
  //    for the firm's open opportunity until a person or deterministic proof says more.
  if (/\b(not interested|no thanks|no thank you)\b/i.test(authored)) {
    signals.push({ rule: 'rejection_language', evidence: 'matched' });
    return {
      class: 'uncertain',
      suggestedDisposition: 'not_interested',
      signals,
      requiresConfirmation: true,
      messageId: message.id,
    };
  }
  const scheduling = /\b(monday|tuesday|wednesday|thursday|friday|schedule|available|calendar)\b/i.test(authored);
  const substantive = /[?]|\b(cost|integration|process|product|how|why|pricing)\b/i.test(authored);
  if (scheduling) signals.push({ rule: 'scheduling_language', evidence: 'matched' });
  if (substantive) signals.push({ rule: 'substantive_language', evidence: 'matched' });

  return {
    class: 'uncertain',
    suggestedDisposition: scheduling || substantive ? 'interested' : null,
    signals,
    requiresConfirmation: true,
    messageId: message.id,
  };
}

/**
 * What an LLM suggestion is allowed to do to a deterministic classification
 * (specification 12.4). The answer is: label and prioritise, and nothing else.
 * A malformed suggestion becomes `uncertain`; a confident "automated" never
 * overrides a deterministic human or opt-out signal.
 */
export function applyModelSuggestion(
  deterministic: ReplyClassification,
  suggestion: { readonly class?: string; readonly disposition?: string; readonly confidence?: number } | null,
): ReplyClassification {
  if (deterministic.class !== 'uncertain') return deterministic;
  if (suggestion === null) return deterministic;

  const disposition = REPLY_DISPOSITIONS.find(value => value === suggestion.disposition) ?? null;
  const suggested = REPLY_CLASSES.find(value => value === suggestion.class);
  const confidence = typeof suggestion.confidence === 'number' ? suggestion.confidence : 0;

  // The model changes no class at all. It may not release a message as automated, may
  // not create a suppression by calling something an opt-out, and may not assert a
  // human reply. The class stays uncertain; only the label and the signal are added.
  return {
    ...deterministic,
    class: 'uncertain',
    suggestedDisposition: disposition ?? deterministic.suggestedDisposition,
    signals: [
      ...deterministic.signals,
      { rule: 'model_suggestion', evidence: `${suggested ?? 'unreadable'}@${confidence.toFixed(2)}` },
    ],
    requiresConfirmation: true,
  };
}
