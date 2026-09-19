import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type {
  CallPolicyView,
  DiagnosticsDevice,
  GoogleGrantView,
  PausedView,
  PhoneSetupView,
  ResearchView,
  SendingView,
  SettingsTemplate,
  V1Command,
  V1StateCode,
} from '../../../../src/shared/contracts/v1Contract';
import { v1StateCodeSchema } from '../../../../src/shared/contracts/v1Contract';
import type { ClientPhoneSetup } from '../../shared/clientContract';

/**
 * The Settings sections slice S5 adds, in the order the design lists them: Templates, Sending, Calls, Phone setup,
 * Google, Research, Devices and Pause/Resume. The States section is S1b's and stays in `SettingsPage.tsx`.
 *
 * Every control here follows the same three rules. A command is one fresh UUID v4 per click, minted at the moment
 * the button is pressed and never re-minted for the same click. Every answer is shown as it came back, refusals
 * included, with the worker's own closed reason. After every applied command the page re-reads Settings, so what
 * is on screen is what the worker holds and never what the page hoped for.
 *
 * Nothing in this file sends, dials or books. Approving a template is not sending; confirming the phone setup is
 * not dialing; narrowing the call hours is not permission to call.
 */

export type CommandRunner = (command: V1Command) => Promise<{ applied: boolean; sentence: string }>;

const minutes = (value: number): string => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
const parseMinutes = (value: string): number | null => {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const total = Number(match[1]) * 60 + Number(match[2]);
  return Number.isFinite(total) && total >= 0 && total <= 24 * 60 ? total : null;
};
const day = (value: string | null): string => (value === null ? 'never' : value.slice(0, 10));

/** One section: a heading, the sentence that says what the control is for, and its contents. */
export function Section({ id, title, lead, children }: { id: string; title: string; lead: string; children: ReactNode }) {
  return (
    <section className="settings__section" data-section={id} aria-label={title}>
      <h2>{title}</h2>
      <p className="page__tick">{lead}</p>
      {children}
    </section>
  );
}

/** The outcome line every control shows after a click: applied, refused with the worker's reason, or a failure. */
function Outcome({ value }: { value: { applied: boolean; sentence: string } | null }) {
  if (value === null) return null;
  return value.applied ? <p role="status" className="notice">{value.sentence}</p> : <p role="alert" className="error">{value.sentence}</p>;
}

export function TemplatesSection({ templates, postalAddress, run }: { templates: SettingsTemplate[]; postalAddress: string | null; run: CommandRunner }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Section id="templates" title="Templates" lead="Your standing approval per template. Approving is never sending: the worker may send this exact text as a step, and any edit returns the template to draft.">
      <ul className="templates" aria-label="Templates">
        {templates.map((template) => (
          <li key={template.templateId} className="template" data-template={template.templateId}>
            <h3>{template.templateId} · {template.name}</h3>
            <p className="template__state">
              {template.approved ? 'Approved' : 'Not approved'} · footer {template.footerPresent ? 'present' : 'missing'}
              {template.approvedAt === null ? '' : ` · approved ${day(template.approvedAt)}`}
              {template.issues.length === 0 ? '' : ` · ${template.issues.join(', ')}`}
            </p>
            {open === template.templateId
              ? <TemplateForm template={template} postalAddress={postalAddress} run={run} onDone={() => setOpen(null)} />
              : <div className="page__controls"><button type="button" onClick={() => setOpen(template.templateId)}>Approve {template.templateId}</button></div>}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function TemplateForm({ template, postalAddress, run, onDone }: { template: SettingsTemplate; postalAddress: string | null; run: CommandRunner; onDone: () => void }) {
  const [subject, setSubject] = useState(template.subject);
  const [body, setBody] = useState(template.body);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ applied: boolean; sentence: string } | null>(null);
  const id = (field: string) => `template-${template.templateId}-${field}`;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const outcome = await run({ commandId: crypto.randomUUID(), kind: 'approve_template', templateId: template.templateId as 'T1',
        expectedRevision: template.revision, subject, body });
      setResult(outcome);
      if (outcome.applied) onDone();
    } finally { setBusy(false); }
  };
  return (
    <form className="template__form" aria-label={`Approve ${template.templateId}`} onSubmit={(event) => { void submit(event); }}>
      <div className="field">
        <label htmlFor={id('subject')}>Subject</label>
        <input id={id('subject')} type="text" maxLength={160} value={subject} onChange={(event) => setSubject(event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={id('body')}>Body</label>
        <textarea id={id('body')} rows={10} maxLength={4000} value={body} onChange={(event) => setBody(event.target.value)} />
      </div>
      <p className="page__stamp">
        {postalAddress === null
          ? 'No postal address is set, so no template can be approved. Set one under Sending first.'
          : 'The body must end with the footer block: the sign-off, the postal address and the stop line.'}
      </p>
      <div className="page__controls">
        <button type="submit" disabled={busy}>Approve</button>
        <button type="button" onClick={onDone}>Cancel</button>
      </div>
      <Outcome value={result} />
    </form>
  );
}

export function SendingSection({ sending, run }: { sending: SendingView; run: CommandRunner }) {
  const [dailyLimit, setDailyLimit] = useState(String(sending.dailyLimit));
  const [startPerDay, setStartPerDay] = useState(String(sending.ramp.startPerDay));
  const [stepPerDay, setStepPerDay] = useState(String(sending.ramp.stepPerDay));
  const [maxPerDay, setMaxPerDay] = useState(String(sending.ramp.maxPerDay));
  const [postalAddress, setPostalAddress] = useState(sending.postalAddress ?? '');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ applied: boolean; sentence: string } | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const numbers = [dailyLimit, startPerDay, stepPerDay, maxPerDay].map(Number);
    if (numbers.some((value) => !Number.isInteger(value) || value < 0)) { setResult({ applied: false, sentence: 'Every limit is a whole number, zero or more.' }); return; }
    setBusy(true);
    try {
      setResult(await run({ commandId: crypto.randomUUID(), kind: 'set_sending_limit', dailyLimit: numbers[0]!,
        ramp: { startPerDay: numbers[1]!, stepPerDay: numbers[2]!, maxPerDay: numbers[3]! },
        ...(postalAddress.trim() === '' ? {} : { postalAddress: postalAddress.trim() }) }));
    } finally { setBusy(false); }
  };
  return (
    <Section id="sending" title="Sending" lead="How few emails may go out. The ceiling is fixed in code and these numbers may only narrow it; saving a limit is never permission to send.">
      <p className="sending__cap">
        Cap today ({sending.capLine.date}): <strong>{sending.capLine.cap}</strong>, warm-up day {sending.capLine.day}, {sending.capLine.used} used, {sending.capLine.remaining} left.
      </p>
      <p className="sending__ceiling">
        Ceiling fixed in code: {sending.ceiling.dailyLimit} a day, ramp {sending.ceiling.startPerDay} plus {sending.ceiling.stepPerDay} to {sending.ceiling.maxPerDay}.
      </p>
      <form className="sending__form" aria-label="Sending limit" onSubmit={(event) => { void submit(event); }}>
        <div className="field"><label htmlFor="sending-daily">Daily limit</label><input id="sending-daily" type="number" min={0} value={dailyLimit} onChange={(event) => setDailyLimit(event.target.value)} /></div>
        <div className="field"><label htmlFor="sending-start">Ramp start per day</label><input id="sending-start" type="number" min={0} value={startPerDay} onChange={(event) => setStartPerDay(event.target.value)} /></div>
        <div className="field"><label htmlFor="sending-step">Ramp step per day</label><input id="sending-step" type="number" min={0} value={stepPerDay} onChange={(event) => setStepPerDay(event.target.value)} /></div>
        <div className="field"><label htmlFor="sending-max">Ramp maximum per day</label><input id="sending-max" type="number" min={0} value={maxPerDay} onChange={(event) => setMaxPerDay(event.target.value)} /></div>
        <div className="field"><label htmlFor="sending-postal">Postal address</label><input id="sending-postal" type="text" maxLength={200} value={postalAddress} onChange={(event) => setPostalAddress(event.target.value)} /></div>
        <div className="page__controls"><button type="submit" disabled={busy}>Save sending limit</button></div>
        <Outcome value={result} />
      </form>
    </Section>
  );
}

export function CallsSection({ calls, run }: { calls: CallPolicyView; run: CommandRunner }) {
  const [start, setStart] = useState(minutes(calls.window.startMinute));
  const [end, setEnd] = useState(minutes(calls.window.endMinute));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ applied: boolean; sentence: string } | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const startMinute = parseMinutes(start), endMinute = parseMinutes(end);
    if (startMinute === null || endMinute === null || startMinute >= endMinute) { setResult({ applied: false, sentence: 'Call hours are HH:MM to HH:MM, and the end is after the start.' }); return; }
    setBusy(true);
    try { setResult(await run({ commandId: crypto.randomUUID(), kind: 'set_call_policy', window: { startMinute, endMinute } })); }
    finally { setBusy(false); }
  };
  return (
    <Section id="calls" title="Calls" lead="The hours a firm may be dialed, on the firm's own clock. These may only narrow the hours fixed in code, never widen them.">
      <p className="calls__floor">
        Fixed in code: Monday to Friday, {minutes(calls.floor.window.startMinute)} to {minutes(calls.floor.window.endMinute)} local to the firm.
      </p>
      <p className="calls__window">
        Your hours: {minutes(calls.window.startMinute)} to {minutes(calls.window.endMinute)}
        {calls.byState.length === 0 ? '' : `, narrowed for ${calls.byState.map((entry) => entry.state).join(', ')}`}.
      </p>
      <form className="calls__form" aria-label="Call hours" onSubmit={(event) => { void submit(event); }}>
        <div className="field"><label htmlFor="calls-start">Start</label><input id="calls-start" type="time" value={start} onChange={(event) => setStart(event.target.value)} /></div>
        <div className="field"><label htmlFor="calls-end">End</label><input id="calls-end" type="time" value={end} onChange={(event) => setEnd(event.target.value)} /></div>
        <div className="page__controls"><button type="submit" disabled={busy}>Save call hours</button></div>
        <Outcome value={result} />
      </form>
    </Section>
  );
}

/**
 * Phone setup. Two facts, kept apart on purpose: what this Mac holds (the proof file, which never leaves it) and
 * what the worker records (David's confirmation and the digest of the proof). Confirming does both, in that order,
 * because the worker should never claim a proof this Mac does not have.
 */
export function PhoneSection({ phone, local, run, onLocalChange }: {
  phone: PhoneSetupView;
  local: ClientPhoneSetup | null;
  run: CommandRunner;
  onLocalChange: (action: 'confirm' | 'clear') => Promise<ClientPhoneSetup | null>;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ applied: boolean; sentence: string } | null>(null);
  const act = async (action: 'confirm' | 'clear') => {
    if (busy) return;
    setBusy(true);
    try {
      const after = await onLocalChange(action);
      if (after === null) { setResult({ applied: false, sentence: 'This Mac could not read its own phone setup proof.' }); return; }
      if (action === 'confirm' && (after.state !== 'configured' || after.proofDigest === null)) { setResult({ applied: false, sentence: after.sentence }); return; }
      setResult(await run(action === 'confirm'
        ? { commandId: crypto.randomUUID(), kind: 'confirm_phone_setup', proofDigest: after.proofDigest! }
        : { commandId: crypto.randomUUID(), kind: 'clear_phone_setup' }));
    } finally { setBusy(false); }
  };
  return (
    <Section id="phone" title="Phone setup" lead="The Phone.app handoff needs a setup proof on this Mac. The proof file stays here; the worker records only that you confirmed it and the digest of what you confirmed.">
      <p className="phone__worker">Worker: {phone.status === 'confirmed' ? `confirmed ${day(phone.confirmedAt)}${phone.confirmedBy === null ? '' : ` on ${phone.confirmedBy}`}` : 'not confirmed'}.</p>
      <p className="phone__local">This Mac: {local === null ? 'not read yet.' : local.sentence}</p>
      <div className="page__controls">
        <button type="button" disabled={busy || local === null || local.state === 'unavailable'} onClick={() => { void act('confirm'); }}>Confirm phone setup</button>
        <button type="button" disabled={busy} onClick={() => { void act('clear'); }}>Clear phone setup</button>
      </div>
      <Outcome value={result} />
    </Section>
  );
}

export function GoogleSection({ google }: { google: GoogleGrantView }) {
  return (
    <Section id="google" title="Google" lead="The mailbox grant, as the worker holds it. This is a status only: connecting is a separate step, and the grant is replaced by a fresh consent at cutover.">
      <p className="google__status">Status: <strong>{google.status.replace(/_/g, ' ')}</strong>{google.email === null ? '' : ` · ${google.email}`}.</p>
      <p className="page__tick">{google.note}</p>
    </Section>
  );
}

/**
 * Research. The one thing here David has to keep current is the descriptor window: research stops when it expires,
 * so the date is shown plainly and an expired or unrecorded window says what that means rather than only naming a
 * status. The queries and the budget are the research slice's to change; this section reports them.
 */
export function ResearchSection({ research }: { research: ResearchView }) {
  const descriptor = research.descriptor;
  return (
    <Section id="research" title="Research" lead="How firms are found, what that may cost a day, and when your operator review runs out.">
      <p className="research__descriptor" data-descriptor={descriptor === null ? 'none' : descriptor.status}>
        {descriptor === null
          ? 'Operator review: not recorded. Research is held until it is.'
          : descriptor.status === 'expired'
            ? `Operator review: expired ${day(descriptor.expiresAt)}. Research is held until it is renewed.`
            : `Operator review: valid until ${day(descriptor.expiresAt)}, reviewed ${day(descriptor.reviewedAt)}.`}
      </p>
      <p className="research__budget">
        Today ({research.todaySpend.date}): {research.todaySpend.spent} of {research.todaySpend.budget} used, {research.todaySpend.remaining} left.
        Daily budget {research.dailyBudget}, ceiling fixed in code {research.budgetCeiling}.
      </p>
      <p className="research__queries">{research.queries.length} {research.queries.length === 1 ? 'query' : 'queries'} in the grid · revision {research.revision}.</p>
    </Section>
  );
}

export function DevicesSection({ devices, run }: { devices: DiagnosticsDevice[]; run: CommandRunner }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ applied: boolean; sentence: string } | null>(null);
  const revoke = async (deviceId: string) => {
    if (busy !== null) return;
    setBusy(deviceId);
    try { setResult(await run({ commandId: crypto.randomUUID(), kind: 'revoke_device', deviceId })); }
    finally { setBusy(null); }
  };
  return (
    <Section id="devices" title="Devices" lead="Every Mac paired with this workspace. Revoking one stops it reading and commanding; only Pause stops sending.">
      <ul className="devices" aria-label="Devices">
        {devices.map((device) => (
          <li key={device.deviceId} className="device" data-device={device.deviceId}>
            <span className="device__label">{device.label}</span>
            <span className="device__dates"> · paired {day(device.createdAt)} · expires {day(device.expiresAt)}{device.revokedAt === null ? '' : ` · revoked ${day(device.revokedAt)}`}</span>
            {device.revokedAt === null && (
              <button type="button" disabled={busy !== null} onClick={() => { void revoke(device.deviceId); }}>Revoke {device.label}</button>
            )}
          </li>
        ))}
      </ul>
      <Outcome value={result} />
    </Section>
  );
}

export function PauseSection({ paused, run }: { paused: PausedView; run: CommandRunner }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ applied: boolean; sentence: string } | null>(null);
  const act = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const trimmed = reason.trim();
    if (trimmed === '') { setResult({ applied: false, sentence: 'Say why, in one line. It is the sentence every page shows while this is paused.' }); return; }
    setBusy(true);
    try {
      setResult(await run(paused.paused
        ? { commandId: crypto.randomUUID(), kind: 'resume', reason: trimmed }
        : { commandId: crypto.randomUUID(), kind: 'pause', reason: trimmed }));
    } finally { setBusy(false); }
  };
  return (
    <Section id="paused" title={paused.paused ? 'Resume' : 'Pause'} lead="Pause stops every send and every mailbox poll until you resume. It does not stop you dialing, and it does not revoke anything.">
      <p className="paused__state">
        {paused.paused ? `Paused: ${paused.reason ?? 'no reason recorded'}` : 'Not paused.'}
        {paused.at === null ? '' : ` · ${day(paused.at)}${paused.by === null ? '' : ` by ${paused.by}`}`}
      </p>
      <form className="paused__form" aria-label={paused.paused ? 'Resume' : 'Pause'} onSubmit={(event) => { void act(event); }}>
        <div className="field">
          <label htmlFor="paused-reason">Reason</label>
          <input id="paused-reason" type="text" maxLength={200} value={reason} onChange={(event) => setReason(event.target.value)} />
        </div>
        <div className="page__controls"><button type="submit" disabled={busy}>{paused.paused ? 'Resume' : 'Pause'}</button></div>
        <Outcome value={result} />
      </form>
    </Section>
  );
}

/** The local proof, read once when the page mounts and again after every confirm or clear. Never on a timer. */
export function useLocalPhoneSetup(): { local: ClientPhoneSetup | null; act: (action: 'confirm' | 'clear') => Promise<ClientPhoneSetup | null> } {
  const [local, setLocal] = useState<ClientPhoneSetup | null>(null);
  useEffect(() => {
    let live = true;
    void window.callie.phoneSetup({ action: 'read' }).then((value) => { if (live) setLocal(value); }).catch(() => { if (live) setLocal(null); });
    return () => { live = false; };
  }, []);
  const act = useCallback(async (action: 'confirm' | 'clear') => {
    try {
      const value = await window.callie.phoneSetup({ action });
      setLocal(value);
      return value;
    } catch { setLocal(null); return null; }
  }, []);
  return { local, act };
}

/** A state code typed by hand, for the States section's add form. Exported here so the page keeps one parser. */
export const parseStateCode = (value: string): V1StateCode | null => {
  const parsed = v1StateCodeSchema.safeParse(value.trim().toUpperCase());
  return parsed.success ? parsed.data : null;
};
