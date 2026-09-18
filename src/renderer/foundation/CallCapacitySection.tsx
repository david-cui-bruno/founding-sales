import { useEffect, useRef, useState } from 'react';
import { callSettingsUpdateReplySchema, meetingFirstAccountCallSettingsSchema, updateCallSettingsRequestSchema, type LocalWorkspaceApi, type MeetingFirstAccountCallSettings } from '../../shared/contracts/localWorkspaceContract';
import { DEFAULT_NEW_CALL_SLOTS_COPY } from '../features/today/todayCopy';

type Api = Pick<LocalWorkspaceApi, 'getCallSettings' | 'updateCallSettings'>;
type Field = { configured: boolean; text: string };
const field = (value: number | null): Field => ({ configured: value !== null, text: value === null ? '' : String(value) });
const value = (input: Field) => {
  if (!input.configured) return null;
  if (!/^\d+$/.test(input.text)) throw new Error('Invalid capacity');
  return Number(input.text);
};

/** A failed response cannot establish whether the CAS committed. Readback is review, not a receipt. */
export function CallCapacitySection({ api, onSaved }: { api?: Api; onSaved(): void }) {
  const [snapshot, setSnapshot] = useState<MeetingFirstAccountCallSettings | null>(null);
  const [latest, setLatest] = useState<MeetingFirstAccountCallSettings | null>(null);
  const [slots, setSlots] = useState<Field>(field(null));
  const [capacity, setCapacity] = useState<Field>(field(null));
  const [pending, setPending] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [message, setMessage] = useState('');
  const generation = useRef(0);
  const busy = useRef(false);
  const owner = useRef(api);
  const current = owner.current === api;
  useEffect(() => {
    const request = ++generation.current;
    owner.current = api;
    busy.current = !!api;
    setPending(!!api);
    setSnapshot(null);
    setLatest(null);
    setUnknown(false);
    setSlots(field(null));
    setCapacity(field(null));
    setMessage(api ? 'Loading call capacity…' : 'Call capacity is unavailable.');
    if (api) void (async () => {
      try {
        const result = meetingFirstAccountCallSettingsSchema.parse(await api.getCallSettings());
        if (request !== generation.current) return;
        setSnapshot(result);
        setSlots(field(result.newCallSlots));
        setCapacity(field(result.totalCallCapacity));
        setMessage('');
      } catch {
        if (request === generation.current) setMessage('Call capacity is unavailable.');
      } finally {
        if (request === generation.current) { busy.current = false; setPending(false); }
      }
    })();
    return () => { generation.current++; };
  }, [api]);
  const readForReview = async () => {
    if (!api || busy.current || !current) return;
    const request = generation.current;
    busy.current = true;
    setPending(true);
    try {
      const result = meetingFirstAccountCallSettingsSchema.parse(await api.getCallSettings());
      if (request === generation.current) setLatest(result);
    } catch {
      if (request === generation.current) setLatest(null);
    } finally {
      if (request === generation.current) { busy.current = false; setPending(false); }
    }
  };
  const save = async () => {
    if (!api || !snapshot || !current || busy.current || unknown) return;
    let input;
    try {
      input = Object.freeze(updateCallSettingsRequestSchema.parse({ expectedRevision: snapshot.revision,
        newCallSlots: value(slots), totalCallCapacity: value(capacity) }));
    } catch { setMessage('Enter a nonnegative safe whole number, or choose Not configured.'); return; }
    const request = generation.current;
    busy.current = true;
    setPending(true);
    setMessage('Saving…');
    try {
      const result = callSettingsUpdateReplySchema(input).parse(await api.updateCallSettings(input));
      if (request !== generation.current) return;
      setSnapshot(result);
      setMessage('Call capacity saved.');
    } catch {
      if (request !== generation.current) return;
      setUnknown(true);
      setLatest(null);
      setMessage('Save outcome unknown. Your edits are retained. Review current settings before another save.');
      busy.current = false;
      setPending(false);
      await readForReview();
      return;
    } finally {
      if (request === generation.current) { busy.current = false; setPending(false); }
    }
    // Notification failure does not make a confirmed database write uncertain.
    try { onSaved(); } catch { /* The save is already confirmed. */ }
  };
  const control = (label: string, input: Field, set: (next: Field) => void) => <fieldset disabled={pending || !snapshot || !current}>
    <legend>{label}</legend>
    <label>{label} configuration<select aria-label={`${label} configuration`} value={input.configured ? 'number' : 'none'}
      onChange={event => set({ ...input, configured: event.target.value === 'number' })}>
      <option value="none">Not configured</option><option value="number">Set number</option>
    </select></label>
    {input.configured && <label>{label}<input aria-label={label} inputMode="numeric" value={input.text}
      onChange={event => set({ ...input, text: event.target.value })} /></label>}
  </fieldset>;
  return <section className="settings__section" aria-label="Call capacity">
    <h2 className="settings__section-title">Call capacity</h2>
    <p>New call slots are how many new firms Today lists each morning after the firms whose sequence step is due. Not configured means the {DEFAULT_NEW_CALL_SLOTS_COPY}. Total capacity flags workload conflicts and never removes due calls. These settings do not grant call permission.</p>
    {snapshot && <p data-testid="effective-allocation">{snapshot.newCallSlots === null ? `Today lists 30 new firms a day (${DEFAULT_NEW_CALL_SLOTS_COPY}). Set a number to change it.` : `Today lists ${snapshot.newCallSlots} new firm${snapshot.newCallSlots === 1 ? '' : 's'} a day (configured).`}</p>}
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      {control('New call slots', slots, setSlots)}
      {control('Total call capacity', capacity, setCapacity)}
      <button type="submit" disabled={!current || !snapshot || pending || unknown}>Save call capacity</button>
    </form>
    <p role="status">{message}</p>
    {unknown && <div>
      {latest && <p>Current stored settings (revision {latest.revision}): new call slots {latest.newCallSlots ?? 'Not configured'}, total call capacity {latest.totalCallCapacity ?? 'Not configured'}.</p>}
      <button type="button" disabled={pending} onClick={() => void readForReview()}>Read current settings</button>
      <button type="button" disabled={pending || !latest} onClick={() => {
        if (!latest || busy.current) return;
        setSnapshot(latest);
        setUnknown(false);
        setMessage('Current revision reviewed. Your edits are unchanged. Save deliberately to apply them.');
      }}>I reviewed current settings</button>
    </div>}
  </section>;
}
