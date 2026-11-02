import { useEffect, useState, type JSX } from 'react';
import { z } from 'zod';
import { bookingLinkSettingSchema } from '@fss/contracts';
import type { BrowserClient } from './BrowserClient.ts';

const current = z.object({ current: z.object({ value: bookingLinkSettingSchema, version: z.number().int().min(0) }) });
const receipt = z.union([
  z.object({ status: z.literal('accepted') }),
  z.object({ status: z.literal('refused'), reason: z.string() }),
]);

/** The workspace booking link `{booking_link}` fills in outreach templates. Admin only; never a sending switch. */
export function BrowserBookingLink({ client }: { client: BrowserClient }): JSX.Element {
  const [saved, setSaved] = useState<string | null | undefined>(undefined);
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const epoch = client.epoch;
    let live = true;
    client.request('/settings/booking-link/read', current, {}).then(read => {
      if (!live || !client.isCurrent(epoch)) return;
      setSaved(read.current.value.url); setDraft(read.current.value.url ?? '');
    }, () => { if (live && client.isCurrent(epoch)) setNotice('Booking link unavailable. Refresh the page to try again.'); });
    return () => { live = false; };
  }, [client]);
  const save = async (url: string | null): Promise<void> => {
    const value = bookingLinkSettingSchema.safeParse({ url });
    if (!value.success) { setNotice('Use one public https link with no credentials, port or spaces.'); return; }
    const epoch = client.epoch;
    setBusy(true); setNotice('');
    try {
      const answer = await client.request('/settings/booking-link/update', receipt, { value: value.data, commandId: globalThis.crypto.randomUUID() });
      if (!client.isCurrent(epoch)) return;
      if (answer.status === 'refused') setNotice('That link was refused. Use one public https link.');
      else { setSaved(value.data.url); setDraft(value.data.url ?? ''); setNotice(value.data.url === null ? 'Booking link cleared.' : 'Booking link saved.'); }
    } catch { if (client.isCurrent(epoch)) setNotice('Booking link not confirmed. Refresh before trying again.'); }
    finally { if (client.isCurrent(epoch)) setBusy(false); }
  };
  return <section aria-label="Booking link" className="workspace-glass"><h2>Booking link</h2>
    <p>Templates that include <code>{'{booking_link}'}</code> use this link. Without one, those steps wait. Use a public https link; saving it never changes sending controls.</p>
    <label>Booking link URL<input aria-label="Booking link URL" type="url" inputMode="url" maxLength={500} value={draft} disabled={busy || saved === undefined} onChange={event => { setDraft(event.target.value); }} /></label>
    <div className="workspace-inline-actions">
      <button type="button" disabled={busy || saved === undefined || draft.trim() === (saved ?? '')} onClick={() => { void save(draft.trim() === '' ? null : draft.trim()); }}>Save booking link</button>
      <button type="button" disabled={busy || saved === undefined || saved === null} onClick={() => { void save(null); }}>Clear booking link</button>
    </div>
    {notice ? <p role="status">{notice}</p> : null}
  </section>;
}
