import { useEffect, useRef, useState } from 'react';
import type { CalliePreloadApi } from '../../shared/preload';
import { suppressionListSchema, type SuppressionEntry, type SuppressionList } from '../../shared/contracts/replyFirstDraftContract';

type Api = Partial<Pick<CalliePreloadApi['delegation'], 'readSuppression'>>;

export const SUPPRESSION_PERMANENCE = 'A suppression is permanent by design. There is no undo here and no undo anywhere else: nothing on this screen can put a firm, a number or an address back into reach.';
export const SUPPRESSION_PURPOSE = 'Everything this application will not contact, and why. A hold on Today usually has its reason here.';
export const SUPPRESSION_KIND_LABELS: Readonly<Record<SuppressionEntry['kind'], string>> = Object.freeze({
  never_call: 'Never call',
  account_opt_out: 'Firm opted out',
  handle_opt_out: 'Address or number opted out',
  person_opt_out: 'Person opted out',
  retired_route: 'Retired route',
});
export const SUPPRESSION_EMPTY = 'Nothing is suppressed yet.';
export const SUPPRESSION_UNAVAILABLE = 'The suppression list could not be read. That is unknown, not empty: treat every existing hold as still in force.';
export const SUPPRESSION_TRUNCATED = 'Only the 200 most recent suppressions are shown. Older ones are still in force.';

/**
 * Settings → Suppressed (D9). A read-only list of every opt-out, never-call tombstone and
 * retired route, with when and why, so the holds on Today are explainable. It offers no undo,
 * because a suppression is permanent: the tombstone tables are append-only and route versions
 * are immutable. Reading it writes nothing, queues no command, dials nothing and sends nothing.
 */
export function SuppressionSection({ api }: { api?: Api }) {
  const usable = typeof api?.readSuppression === 'function' ? api.readSuppression : undefined;
  const [list, setList] = useState<SuppressionList | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [pending, setPending] = useState(false);
  const generation = useRef(0);

  const read = async () => {
    if (!usable) return;
    const request = ++generation.current;
    setPending(true);
    try {
      const value = suppressionListSchema.parse(await usable());
      if (request !== generation.current) return;
      setList(value); setUnavailable(false);
    } catch {
      if (request !== generation.current) return;
      // Unknown is never presented as an empty list: the last known read is kept.
      setUnavailable(true);
    } finally { if (request === generation.current) setPending(false); }
  };
  useEffect(() => { void read(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [usable]);

  return <section id="settings-suppressed" className="settings__section" aria-label="Suppressed">
    <h2 className="settings__section-title">Suppressed</h2>
    <p>{SUPPRESSION_PURPOSE}</p>
    <p>{SUPPRESSION_PERMANENCE}</p>
    {!usable
      ? <p className="settings__quiet">Available once the workspace bridge is ready.</p>
      : <>
        <button type="button" className="settings__action" disabled={pending} onClick={() => void read()}>Refresh suppression list</button>
        {unavailable && <p role="alert">{SUPPRESSION_UNAVAILABLE}</p>}
        {list && (list.entries.length === 0
          ? <p>{SUPPRESSION_EMPTY}</p>
          : <>
            {list.truncated && <p>{SUPPRESSION_TRUNCATED}</p>}
            <table className="settings__suppression">
              <thead><tr>
                <th scope="col">Kind</th><th scope="col">Who or what</th><th scope="col">When</th><th scope="col">Why</th>
              </tr></thead>
              <tbody>
                {list.entries.map(entry => <tr key={`${entry.kind}:${entry.subject}:${entry.observedAt}`}>
                  <td>{SUPPRESSION_KIND_LABELS[entry.kind]}</td>
                  <th scope="row">{entry.subject}</th>
                  <td><time dateTime={entry.observedAt}>{entry.observedAt}</time></td>
                  <td>{entry.why}{entry.evidenceRef !== null && <> <span className="settings__quiet">Evidence {entry.evidenceRef}</span></>}</td>
                </tr>)}
              </tbody>
            </table>
            <p className="settings__quiet">Read at {list.generatedAt}.</p>
          </>)}
      </>}
  </section>;
}
