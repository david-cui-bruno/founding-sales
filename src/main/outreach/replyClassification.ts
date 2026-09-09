import type { MailMessage, ReplyClassification } from '../../shared/contracts/mailThreadContract';
/** Advisory only. Even scheduling is not permission to send or create an event. */
export function classifyReply(message: MailMessage): ReplyClassification {
  const raw = message.bodyParts.map(p => p.text).join('\n');
  // Explicit quote boundaries are evidence, not the current sender's intent.
  const lines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (/^\s*(?:On .+wrote:|[-_]{2,}\s*(?:Original|Forwarded) Message)/i.test(line)) break;
    if (!/^\s*>/.test(line)) lines.push(line);
  }
  const text = lines.join('\n').trim();
  // A conventional closing starts a signature, not a continuation of the request.
  // Keep inline/soft-wrapped sentence text together so mentions stay mentions.
  const closing = lines.findIndex((line, index) => index > 0 && lines.slice(0, index).some(part => part.trim().length > 0) && /^[ \t]*(?:thanks|thank you|best(?: regards)?|kind regards|regards|sincerely)[,.!]?[ \t]*$/i.test(line));
  const authored = closing > 0 ? lines.slice(0, closing).join('\n').trim() : text;
  const directOptOut = authored.replace(/\s+/g, ' ').split(/[.!]/).some(sentence => /^(?:please\s+)?(?:unsubscribe(?: me)?|stop (?:emailing|contacting|messaging) me|remove me(?: from (?:your|the) (?:list|mailing list))?|(?:do not|don't) contact me)\s*$/i.test(sentence.trim())
    || /,\s*but\s+(?:please\s+)?stop (?:emailing|contacting|messaging) me\s*$/i.test(sentence.trim()));
  let kind: ReplyClassification['kind'] = 'ambiguous';
  if (!message.bodyParts.some(part => part.truncated) && directOptOut) kind = 'opt_out';
  else if (/\b(out of (?:the )?office|automatic reply|on vacation)\b/i.test(text)) kind = 'out_of_office';
  else if (/\b(delivery (?:failed|failure)|undeliverable|address not found)\b/i.test(text)) kind = 'delivery_failure';
  else if (/\b(not interested|no thanks)\b/i.test(text)) kind = 'rejection';
  else {
    const scheduling = /\b(monday|tuesday|wednesday|thursday|friday|schedule|available|calendar)\b/i.test(text);
    const substantive = /[?]|\b(price|cost|integration|process|product|how|why)\b/i.test(text);
    if (scheduling && substantive) kind = 'mixed';
    else if (substantive) kind = 'substantive';
    else if (scheduling) kind = 'scheduling';
  }
  return { kind, evidence: [{ messageId: message.id, quote: raw.slice(0, 500) }], requiresApproval: true };
}
