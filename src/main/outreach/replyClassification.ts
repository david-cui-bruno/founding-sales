import type { MailMessage, ReplyClassification } from '../../shared/contracts/mailThreadContract';
/** Advisory only. Even scheduling is not permission to send or create an event. */
export function classifyReply(message: MailMessage): ReplyClassification {
  const text = message.bodyParts.map(p => p.text).join('\n');
  let kind: ReplyClassification['kind'] = 'ambiguous';
  if (/\b(unsubscribe|stop (?:emailing|contacting|messaging)|remove me|do not contact|don't contact)\b/i.test(text)) kind = 'opt_out';
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
  return { kind, evidence: [{ messageId: message.id, quote: text.slice(0, 500) }], requiresApproval: true };
}
