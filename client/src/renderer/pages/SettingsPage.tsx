import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { US_STATE_NAMES } from '../../../../src/shared/contracts/territoryClearanceContract';
import {
  v1StateCodeSchema,
  type SetStatePostureCommand,
  type SettingsView,
  type StatePostureSummary,
  type StateReferenceText,
  type TodayView,
  type V1StateCode,
} from '../../../../src/shared/contracts/v1Contract';

/**
 * Settings, first slice (S1b): the States section, so David can record a calling posture per state before S5 ships
 * the rest of Settings. Without a posture the morning list is empty by design. One row per state that appears in the
 * pool (the postures the worker holds, the states the Today header names as without posture, and the states the
 * reference texts cover), plus a state code added by hand. Each row shows the current posture or none, the review
 * date, the state's reference text when the worker has one, and a form that sends `set_state_posture` with a fresh
 * UUID v4 commandId and re-reads. Recording a posture is David's decision, not a checkbox: the form asks for the
 * registration and do-not-call status he checked and the citation he read. Nothing here dials or sends.
 */
const REFRESH_MS = 60_000;
const REGISTRATION = [['registered', 'Registered'], ['exempt', 'Exempt'], ['none_required', 'None required'], ['unknown', 'Unknown']] as const;
const DNC = [['subscribed', 'Subscribed'], ['not_required', 'Not required'], ['unknown', 'Unknown']] as const;
const STATEMENT_LABELS: Record<string, string> = {
  businessToBusiness: 'Business to business', registrationStatusChecked: 'Registration status checked',
  stateDncSubscriptionChecked: 'State do-not-call subscription checked', consentRuleConfirmed: 'Consent rule',
};

type Reading = { settings: SettingsView; statesInPool: V1StateCode[]; fetchedAt: string };

/** The states the Today view names as without posture, whether or not a list was built. */
export const statesWithoutPostureOf = (view: TodayView): V1StateCode[] => view.list === null ? view.statesWithoutPosture : view.list.header.statesWithoutPosture;

/** Every state the section shows, sorted: postures held, states without posture, reference-text states, hand-added codes. */
export function statesToShow(settings: SettingsView, statesInPool: readonly V1StateCode[], added: readonly V1StateCode[]): V1StateCode[] {
  return [...new Set<V1StateCode>([...settings.postures.map(posture => posture.state), ...statesInPool, ...settings.referenceTexts.states.map(entry => entry.state), ...added])].sort();
}

function PostureForm({ state, revision, current, onRecorded }: { state: V1StateCode; revision: number; current: StatePostureSummary | null; onRecorded: () => Promise<void> }) {
  const [posture, setPosture] = useState<'calling' | 'not_calling'>(current?.posture ?? 'calling');
  const [registration, setRegistration] = useState<SetStatePostureCommand['registration']['status']>('unknown');
  const [registrationCitation, setRegistrationCitation] = useState('');
  const [dnc, setDnc] = useState<SetStatePostureCommand['dncList']['status']>('unknown');
  const [dncCitation, setDncCitation] = useState('');
  const [counselName, setCounselName] = useState('');
  const [counselDate, setCounselDate] = useState('');
  const [counselMemo, setCounselMemo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const id = (field: string) => `posture-${state}-${field}`;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    if (counselName.trim() !== '' && counselDate === '') { setError('Counsel needs the date of the advice.'); return; }
    setBusy(true); setError(null); setNotice(null);
    try {
      // A fresh UUID v4 per click; a retry inside the main process reuses it, this form never mints twice for one click.
      const command: SetStatePostureCommand = {
        commandId: crypto.randomUUID(), kind: 'set_state_posture', state, posture,
        registration: { status: registration, citation: registrationCitation.trim() },
        dncList: { status: dnc, citation: dncCitation.trim() },
        ...(counselName.trim() === '' ? {} : { counsel: { name: counselName.trim(), date: counselDate, memoRef: counselMemo.trim() } }),
        referenceTextRevision: revision,
      };
      const result = await window.callie.command(command);
      if (result.outcome === 'ok') {
        setNotice(`Recorded for ${state}: ${result.receipt.outcome}${result.receipt.reason === null ? '' : ` (${result.receipt.reason})`}.`);
        await onRecorded();
      } else {
        setError(result.sentence);
      }
    } catch {
      setError('The client could not send the posture to the worker.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="state__form" aria-label={`Posture for ${state}`} onSubmit={(event) => { void submit(event); }}>
      <div className="field">
        <label htmlFor={id('posture')}>Posture</label>
        <select id={id('posture')} value={posture} onChange={(event) => setPosture(event.target.value as 'calling' | 'not_calling')}>
          <option value="calling">Calling</option>
          <option value="not_calling">Not calling</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor={id('registration')}>Registration status</label>
        <select id={id('registration')} value={registration} onChange={(event) => setRegistration(event.target.value as typeof registration)}>
          {REGISTRATION.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor={id('registration-citation')}>Registration citation</label>
        <textarea id={id('registration-citation')} rows={2} maxLength={400} value={registrationCitation} onChange={(event) => setRegistrationCitation(event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={id('dnc')}>Do-not-call list status</label>
        <select id={id('dnc')} value={dnc} onChange={(event) => setDnc(event.target.value as typeof dnc)}>
          {DNC.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor={id('dnc-citation')}>Do-not-call citation</label>
        <textarea id={id('dnc-citation')} rows={2} maxLength={400} value={dncCitation} onChange={(event) => setDncCitation(event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={id('counsel-name')}>Counsel name (optional)</label>
        <input id={id('counsel-name')} type="text" maxLength={120} value={counselName} onChange={(event) => setCounselName(event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={id('counsel-date')}>Counsel date</label>
        <input id={id('counsel-date')} type="date" value={counselDate} onChange={(event) => setCounselDate(event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={id('counsel-memo')}>Counsel memo reference</label>
        <input id={id('counsel-memo')} type="text" maxLength={200} value={counselMemo} onChange={(event) => setCounselMemo(event.target.value)} />
      </div>
      <div className="page__controls">
        <button type="submit" disabled={busy}>Record</button>
        <span className="page__stamp">Reference text revision {revision} is recorded with the decision.</span>
      </div>
      {error && <p role="alert" className="error">{error}</p>}
      {notice && <p role="status" className="notice">{notice}</p>}
    </form>
  );
}

function ReferenceText({ text }: { text: StateReferenceText }) {
  return (
    <aside className="state__reference" aria-label={`Reference text for ${text.state}`}>
      <p>{text.summary}</p>
      <p><strong>{text.citation.title}</strong></p>
      <p><q>{text.citation.quote}</q></p>
      <p><cite>{text.citation.url}</cite></p>
      {text.furtherCitations.map((citation) => (
        <p key={citation.url}><strong>{citation.title}</strong> <cite>{citation.url}</cite></p>
      ))}
    </aside>
  );
}

export function SettingsPage() {
  const [reading, setReading] = useState<Reading | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [added, setAdded] = useState<V1StateCode[]>([]);
  const [open, setOpen] = useState<V1StateCode | null>(null);
  const [newCode, setNewCode] = useState('');
  const [addError, setAddError] = useState<string | null>(null);

  const read = useCallback(async () => {
    try {
      const [settings, today] = await Promise.all([window.callie.get({ view: '/v1/settings' }), window.callie.get({ view: '/v1/today' })]);
      if (settings.outcome !== 'ok') { setProblem(settings.sentence); return; }
      // The Today read only names the states in the pool; when it is not available the section still shows what the worker holds.
      const statesInPool = today.outcome === 'ok' ? statesWithoutPostureOf(today.view) : [];
      setReading({ settings: settings.view, statesInPool, fetchedAt: settings.fetchedAt });
      setProblem(null);
    } catch {
      setProblem('The client could not read Settings.');
    }
  }, []);

  useEffect(() => {
    void read();
    const timer = window.setInterval(() => { void read(); }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [read]);

  const addState = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = v1StateCodeSchema.safeParse(newCode.trim().toUpperCase());
    if (!parsed.success) { setAddError(`"${newCode.trim().toUpperCase()}" is not a United States postal code.`); return; }
    setAdded((current) => (current.includes(parsed.data) ? current : [...current, parsed.data]));
    setOpen(parsed.data); setNewCode(''); setAddError(null);
  };

  const settings = reading?.settings ?? null;
  const states = settings ? statesToShow(settings, reading!.statesInPool, added) : [];
  return (
    <section className="page page--settings">
      <header className="page__header">
        <h1>Settings</h1>
        <p className="page__stamp">
          {reading === null ? 'Not read yet.' : <>read at <time dateTime={reading.fetchedAt}>{reading.fetchedAt}</time></>}
        </p>
        <div className="page__controls"><button type="button" onClick={() => { void read(); }}>Refresh</button></div>
      </header>
      {problem && <p role="alert" className="error">{problem}</p>}
      {settings && (
        <>
          <h2>States</h2>
          <p className="page__tick">Your calling posture per state. Without a posture of calling, firms in that state are held and the morning list leaves them out.</p>
          <p className="page__tick">Reference statements, revision {settings.referenceTexts.revision}:</p>
          <ul className="statements" aria-label="Reference statements">
            {Object.entries(settings.referenceTexts.statements).map(([key, text]) => (
              <li key={key}><strong>{STATEMENT_LABELS[key] ?? key}.</strong> {text}</li>
            ))}
          </ul>
          <form className="add-state" onSubmit={addState} aria-label="Add a state">
            <label htmlFor="add-state-code">State code</label>
            <input id="add-state-code" type="text" maxLength={2} autoComplete="off" spellCheck={false} value={newCode} onChange={(event) => setNewCode(event.target.value)} />
            <button type="submit" disabled={newCode.trim() === ''}>Add state</button>
          </form>
          {addError && <p role="alert" className="error">{addError}</p>}
          <ul className="states" aria-label="States">
            {states.map((state) => {
              const posture = settings.postures.find((entry) => entry.state === state) ?? null;
              const text = settings.referenceTexts.states.find((entry) => entry.state === state) ?? null;
              return (
                <li key={state} className="state" data-state={state}>
                  <h3>{state} · {US_STATE_NAMES[state]}</h3>
                  <p className="state__posture">
                    {posture === null ? 'No posture recorded.' : (
                      <>Posture: <strong>{posture.posture === 'calling' ? 'calling' : 'not calling'}</strong>, decided <time dateTime={posture.decidedAt}>{posture.decidedAt.slice(0, 10)}</time> by {posture.decidedBy}; review due <time dateTime={posture.reviewAt}>{posture.reviewAt.slice(0, 10)}</time>{posture.reviewOverdue ? ' (overdue)' : ''}.</>
                    )}
                  </p>
                  {text ? <ReferenceText text={text} /> : <p className="page__tick">No reference text for this state in this build; record what you checked in the citations.</p>}
                  {open === state ? (
                    <PostureForm state={state} revision={settings.referenceTexts.revision} current={posture} onRecorded={read} />
                  ) : (
                    <div className="page__controls"><button type="button" onClick={() => setOpen(state)}>{posture === null ? `Record posture for ${state}` : `Change posture for ${state}`}</button></div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
