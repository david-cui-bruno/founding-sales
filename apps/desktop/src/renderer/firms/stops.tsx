import type { FirmStopsDto } from '@fss/contracts';
import type { JSX } from 'react';
import { Tag } from '../ui/layout.tsx';

/**
 * The stop badges (migration 0037, David's P2: "the CRM shows 'Email stopped' on the
 * contact"). The firm page read says which channels are stopped; this says it in words.
 *
 * One of three, never two side by side: e-mail and calls both stopped is "All contact
 * stopped", whichever stops made it so.
 */
export type StopLabel = 'Email stopped' | 'Calls stopped' | 'All contact stopped';

export function stopLabelOf(email: boolean, phone: boolean): StopLabel | null {
  if (email && phone) return 'All contact stopped';
  if (email) return 'Email stopped';
  if (phone) return 'Calls stopped';
  return null;
}

/** The firm's own stop, from the channels its effective stops carry. */
export function firmStopLabel(stops: FirmStopsDto | undefined): StopLabel | null {
  if (stops === undefined) return null;
  const all = stops.firm.includes('all');
  return stopLabelOf(all || stops.firm.includes('email'), all || stops.firm.includes('phone'));
}

/** One contact's stop, from the handles they hold. A firm stop is said once, on the firm. */
export function contactStopLabel(stops: FirmStopsDto | undefined, contactId: string): StopLabel | null {
  const entry = stops?.contacts.find(contact => contact.contactId === contactId);
  return entry === undefined ? null : stopLabelOf(entry.email, entry.phone);
}

export function StopBadge({ label, testId }: { readonly label: StopLabel | null; readonly testId: string }): JSX.Element | null {
  if (label === null) return null;
  return (
    <Tag data-testid={testId} tone="warn">
      {label}
    </Tag>
  );
}
