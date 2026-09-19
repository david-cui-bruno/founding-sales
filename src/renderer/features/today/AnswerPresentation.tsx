import type { FocusEvent } from 'react';
import { Mail, UserRound } from 'lucide-react';
import type { RequestedAnswerPresentation } from '../../../shared/contracts/dailyAnswerPresentationContract';

type Contact = NonNullable<RequestedAnswerPresentation['contact']>;
export function AnswerIdentity({ type, tag, company, fallback, contact }: { type: string; tag: string; company: string; fallback: string; contact?: Contact | null }) {
  const initials = contact?.displayName.trim().split(/\s+/u).filter(Boolean).map(part => Array.from(part)[0]).filter(Boolean);
  const monogram = initials?.length ? [initials[0], ...(initials.length > 1 ? [initials[initials.length - 1]] : [])].join('').toLocaleUpperCase() : null;
  return <header className="native-desk__identity">
    <div className="native-desk__identity-top"><span><Mail size={15} aria-hidden="true" />{type}</span><span className="native-desk__tag">{tag}</span></div>
    <div className="native-desk__identity-bar">
      <span className="native-desk__avatar" aria-hidden="true">{monogram ?? <UserRound size={20} />}</span>
      <div><h2>{contact?.displayName ?? fallback}</h2><div className="native-desk__company-role"><span>{company}</span>{contact?.role && <span>{contact.role.value}</span>}</div></div>
    </div>
  </header>;
}
export function OriginalCallContext({ context }: { context?: RequestedAnswerPresentation['callContext'] }) {
  return <section className="native-desk__call-context" aria-label="Original call context">
    <p className="native-desk__context-label">{context?.noteText ? 'Human-reported call note' : context ? 'Connected call recorded' : 'Original call context unavailable'}</p>
    {context?.noteText && <p className="native-desk__call-note">{context.noteText}</p>}
    {context && <p>Call outcome reported <time dateTime={context.observedAt}>{new Date(context.observedAt).toLocaleString(undefined, { timeZoneName: 'short' })}</time></p>}
    {context?.linkedContact && <p>Linked call contact: {context.linkedContact.displayName}</p>}
  </section>;
}
export type AnswerPresentation = RequestedAnswerPresentation;

/** Reveal focused fields in their own scrollport. Native textarea focus can
 * leave a nested flex scrollport unchanged even when the field is offscreen.
 * This is presentation-only: no caret, value, session or outer-page mutation. */
export function revealMessageFocus(event: FocusEvent<HTMLDivElement>) {
  const field = event.target;
  if (!(field instanceof HTMLElement) || !field.matches('input, textarea, select')) return;
  const owner = event.currentTarget;
  const viewport = owner.getBoundingClientRect(), bounds = field.getBoundingClientRect();
  if (bounds.top < viewport.top) owner.scrollTop += bounds.top - viewport.top;
  else if (bounds.bottom > viewport.bottom) owner.scrollTop += Math.min(bounds.bottom - viewport.bottom, bounds.top - viewport.top);
}
