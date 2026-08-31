import type { ActivityKind } from './eventTypes';

/**
 * The minimal immutable Activity facts needed to decide whether a row
 * mechanically qualifies as founder-visible contact evidence. Person/Cycle
 * and timestamp ownership remain caller checks.
 */
export type ContactEvidenceFact = Readonly<{
  prospectId: string | null;
  kind: ActivityKind;
  direction: 'inbound' | 'outbound' | 'internal';
  observedOutcome: string | null;
}>;

const INBOUND_QUALIFYING_KINDS: readonly ActivityKind[] = ['call', 'text', 'email'];
const INBOUND_QUALIFYING_OUTCOMES: readonly string[] = ['answered', 'replied', 'accepted'];

/**
 * Exact shared product predicate for qualifying contact evidence, used by the
 * Task 9 lifecycle writer and Task 11 prioritization last-contact derivation.
 *
 * Qualifying evidence is exactly: outbound call/`answered`, outbound
 * voicemail/`voicemail_left`, outbound text or email/`accepted`, or an
 * exact-Prospect inbound call/text/email response with
 * `answered | replied | accepted`. A row for another/no Prospect,
 * delivered-only, opened, no-answer, failed, internal, resolver, or
 * unconfirmed Activity contributes nothing.
 */
export function qualifiesContactEvidence(
  activity: ContactEvidenceFact,
  expectedProspectId: string,
): boolean {
  if (activity.prospectId !== expectedProspectId) return false;
  if (activity.direction === 'inbound') {
    return INBOUND_QUALIFYING_KINDS.includes(activity.kind)
      && activity.observedOutcome !== null
      && INBOUND_QUALIFYING_OUTCOMES.includes(activity.observedOutcome);
  }
  if (activity.direction !== 'outbound') return false;
  if (activity.kind === 'call') return activity.observedOutcome === 'answered';
  if (activity.kind === 'voicemail') return activity.observedOutcome === 'voicemail_left';
  if (activity.kind === 'text' || activity.kind === 'email') {
    return activity.observedOutcome === 'accepted';
  }
  return false;
}
