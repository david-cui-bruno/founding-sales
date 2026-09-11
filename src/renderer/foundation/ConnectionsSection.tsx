import { useEffect, useRef, useState } from 'react';
import { configureOutreachSchema, outreachStatusSchema, type OutreachApi, type OutreachStatus } from '../../shared/contracts/outreachContract';
import { Button } from '../components/Button';

/** User-owned credentials. No connection, generation or send occurs on mount. */
export function ConnectionsSection({ api }: { api?: OutreachApi }) {
  const [status, setStatus] = useState<OutreachStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [sender, setSender] = useState('');
  const [postal, setPostal] = useState('');
  const active = useRef(true);
  const touched = useRef(new Set<string>());
  const pending = useRef(false);
  useEffect(() => {
    active.current = true; let current = true;
    if (api !== undefined) void api.status().then(value => {
      if (!current) return;
      const result = outreachStatusSchema.parse(value); setStatus(result);
      if (!touched.current.has('model')) setModel(result.modelName);
      if (!touched.current.has('sender')) setSender(result.senderName);
      if (!touched.current.has('postal')) setPostal(result.postalAddress);
    }).catch(() => { if (current) setError('Connection status unavailable. No connection was started.'); });
    return () => { current = false; active.current = false; };
  }, [api]);
  const run = async (command: () => Promise<OutreachStatus>, success: string) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null); setMessage(null);
    try {
      const result = outreachStatusSchema.parse(await command());
      if (active.current) { setStatus(result); setMessage(success); }
    } catch { if (active.current) setError('Connection change could not be completed. Check your setup and try again.'); }
    finally {
      pending.current = false;
      if (active.current) { setBusy(false); setApiKey(''); setClientSecret(''); }
    }
  };
  return <section className="settings__section settings-connections" aria-label="Connections">
    <h2 className="settings__section-title">Connections</h2>
    <p>Use your own OpenAI and Google Desktop OAuth credentials. Secrets are encrypted by macOS in the main process, never saved in browser storage.</p>
    <p>AI drafting shares supported portfolio facts and the playbook. Private local notes are not shared. Opening a draft never sends email.</p>
    {api === undefined && <p role="alert">Outreach setup is unavailable in this session.</p>}
    {status !== null && <p role="status">AI: {status.model}. Gmail: {status.gmail}{status.accountEmail ? ` (${status.accountEmail})` : ''}.</p>}
    {error !== null && <p role="alert">{error}</p>}
    {message !== null && <p role="status">{message}</p>}
    <form onSubmit={event => {
      event.preventDefault(); if (api === undefined || status === null) return;
      const input = configureOutreachSchema.safeParse({ ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), ...(model.trim() ? { model: model.trim() } : {}),
        ...(clientId.trim() ? { googleClientId: clientId.trim() } : {}), ...(clientSecret.trim() ? { googleClientSecret: clientSecret.trim() } : {}), senderName: sender.trim(), postalAddress: postal.trim() });
      if (!input.success) { setError('Check the model, credentials, sender name and postal address.'); return; }
      void run(() => api.configure(input.data), 'Connection settings saved.');
    }}>
      <label>OpenAI API key<input type="password" autoComplete="off" value={apiKey} disabled={busy} onChange={event => { touched.current.add('apiKey'); setApiKey(event.target.value); }} /></label>
      <label>OpenAI model<input value={model} disabled={busy} onChange={event => { touched.current.add('model'); setModel(event.target.value); }} /></label>
      <label>Google Desktop client ID<input autoComplete="off" value={clientId} disabled={busy} onChange={event => { touched.current.add('clientId'); setClientId(event.target.value); }} /></label>
      <label>Google Desktop client secret<input type="password" autoComplete="off" value={clientSecret} disabled={busy} onChange={event => { touched.current.add('clientSecret'); setClientSecret(event.target.value); }} /></label>
      <label>Sender name<input value={sender} disabled={busy} onChange={event => { touched.current.add('sender'); setSender(event.target.value); }} /></label>
      <label>Postal address<textarea value={postal} disabled={busy} onChange={event => { touched.current.add('postal'); setPostal(event.target.value); }} /></label>
      <Button type="submit" disabled={busy || api === undefined || status === null}>Save connections</Button>
    </form>
    <p>Save Google settings before connecting. Connect opens Google’s consent screen only when you click below.</p>
    <div className="settings__row-actions"><Button disabled={busy || api === undefined || status === null} onClick={() => { if (api) void run(() => api.connectGmail(), 'Gmail connection completed.'); }}>Connect Gmail</Button>
      <Button variant="quiet" disabled={busy || api === undefined || status === null} onClick={() => { if (api) void run(() => api.disconnectGmail(), 'Gmail disconnected.'); }}>Disconnect Gmail</Button></div>
    <p>Gmail access is send-only plus account identity. Review replies in Gmail and record opt-outs in FSS before further outreach. The app does not automatically read replies or unsubscribe people.</p>
    <p>Your sender identity, postal address and reply-opt-out footer are previewed in each email before explicit Send.</p>
  </section>;
}
