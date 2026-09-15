import { useEffect, useRef, useState } from 'react';
import { companyResearchSettingsSchema, companyResearchSettingsUpdateReplySchema, updateCompanyResearchSettingsRequestSchema, type CompanyResearchSettings, type LocalWorkspaceApi, type UpdateCompanyResearchSettingsRequest } from '../../shared/contracts/localWorkspaceContract';
import { outreachStatusSchema, type OutreachApi, type OutreachStatus } from '../../shared/contracts/outreachContract';
import { Button } from '../components/Button';

type Api = Pick<LocalWorkspaceApi, 'getCompanyResearchSettings' | 'updateCompanyResearchSettings'>;
type Draft = { sources: string; dollars: string; profileId: string; snapshot: CompanyResearchSettings | null; unknown: boolean; attempted?: UpdateCompanyResearchSettingsRequest; observed?: CompanyResearchSettings };
// Volatile, API-owner-bound edits survive Settings navigation. No browser storage or credentials.
const retained = new WeakMap<Api, Draft>();
const empty = (): Draft => ({ sources: '', dollars: '', profileId: '', snapshot: null, unknown: false });
const money = (micros: number) => {
  const value = BigInt(micros);
  const fraction = (value % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${value / 1000000n}.${fraction || '00'}`;
};
function budget(text: string) {
  if (!/^\d+(?:\.\d{1,6})?$/.test(text)) throw Error('Invalid dollars');
  const [whole, fraction = ''] = text.split('.');
  const micros = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
  if (micros <= 0n || micros > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('Invalid dollars');
  return Number(micros);
}

/** Local settings only. Execution remains the existing selected-company Research action. */
export function LocalCompanyResearchSection({ api, outreachApi, connectionRevision = 0 }: {
  api?: Api; outreachApi?: Pick<OutreachApi, 'status'>; connectionRevision?: number;
}) {
  const [draft, setDraft] = useState<Draft>(() => api ? retained.get(api) ?? empty() : empty());
  const [pending, setPending] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [latest, setLatest] = useState<CompanyResearchSettings | null>(null);
  const [message, setMessage] = useState('');
  const [model, setModel] = useState<OutreachStatus | null>(null);
  const generation = useRef(0);
  const busy = useRef(false);
  const owner = useRef(api);
  const draftRef = useRef(draft);
  const dirty = useRef(false);
  const update = (patch: Partial<Draft>) => { const next = { ...draftRef.current, ...patch }; draftRef.current = next; setDraft(next); };
  const current = owner.current === api;
  useEffect(() => {
    const sequence = ++generation.current;
    owner.current = api;
    const saved = api ? retained.get(api) : undefined;
    const initial = saved ? { ...saved, unknown: true } : empty();
    draftRef.current = initial; setDraft(initial); setReviewed(false); setLatest(null);
    busy.current = false; setPending(false);
    dirty.current = !!saved;
    const detach = () => {
      if (api && (dirty.current || !!draftRef.current.snapshot && busy.current || draftRef.current.unknown)) retained.set(api, { ...draftRef.current, unknown: true });
      else if (api) retained.delete(api);
      generation.current++;
    };
    if (saved) { setMessage('Retained edits. Refresh current settings and review before saving.'); return detach; }
    setMessage(api ? 'Loading local research settings…' : 'Local research settings are unavailable.');
    if (api) {
      busy.current = true; setPending(true);
      void (async () => {
        try {
          const value = companyResearchSettingsSchema.parse(await api.getCompanyResearchSettings());
          if (sequence !== generation.current) return;
          update({ snapshot: value, observed: value, sources: value.configuration?.permittedSources.join('\n') ?? '', dollars: value.configuration ? money(value.configuration.maxAccountBudgetMicros) : '', profileId: value.configuration?.profileId ?? value.profiles[0]?.id ?? '' });
          setMessage('');
        } catch { if (sequence === generation.current) setMessage('Local research settings are unavailable. Refresh explicitly to try again.'); }
        finally { if (sequence === generation.current) { busy.current = false; setPending(false); } }
      })();
    }
    return detach;
  }, [api]);
  useEffect(() => {
    let attached = true; setModel(null);
    if (outreachApi) void outreachApi.status().then(value => { if (attached) setModel(outreachStatusSchema.parse(value)); }).catch(() => { if (attached) setModel(null); });
    return () => { attached = false; };
  }, [outreachApi, connectionRevision]);
  const refresh = async () => {
    if (!api || !current || busy.current) return;
    const sequence = generation.current; busy.current = true; setPending(true); setLatest(null); setReviewed(false);
    if (draftRef.current.snapshot) update({ unknown: true });
    try {
      const value = companyResearchSettingsSchema.parse(await api.getCompanyResearchSettings());
      if (sequence !== generation.current) return;
      const known = draftRef.current.observed ?? draftRef.current.snapshot;
      if (known && (value.revision < known.revision || value.revision === known.revision
        && JSON.stringify(value.configuration) !== JSON.stringify(known.configuration))) throw Error('Unreconciled settings');
      if (!known) {
        update({ snapshot: value, observed: value, unknown: false, profileId: value.configuration?.profileId ?? value.profiles[0]?.id ?? '', sources: dirty.current ? draftRef.current.sources : value.configuration?.permittedSources.join('\n') ?? '', dollars: dirty.current ? draftRef.current.dollars : value.configuration ? money(value.configuration.maxAccountBudgetMicros) : '' });
        setMessage('Current settings loaded. Review before saving.');
      } else { setLatest(value); update({ unknown: true, observed: value }); setMessage('Current settings read. Your edits are unchanged. Review the stored record below.'); }
    } catch { if (sequence === generation.current) setMessage('Current settings unavailable. Your edits are retained. No save was retried.'); }
    finally { if (sequence === generation.current) { busy.current = false; setPending(false); } }
  };
  const snapshot = draft.snapshot;
  const profile = snapshot?.profiles.find(item => item.id === draft.profileId);
  const limits = profile?.researchLimits;
  const extraction = limits?.knownCompanyExtraction;
  const save = async (pause: boolean) => {
    if (!api || !current || busy.current || !snapshot || draft.unknown || latest) return;
    let input: UpdateCompanyResearchSettingsRequest;
    try {
      if (pause) {
        if (snapshot.configuration?.state !== 'active') return;
        input = updateCompanyResearchSettingsRequestSchema.parse({ expectedRevision: snapshot.revision, reviewed: false, configuration: { ...snapshot.configuration, state: 'paused' } });
      } else {
        if (!reviewed || !profile || !extraction || snapshot.blockedReason) return;
        const sources = draft.sources.split(/\r?\n/).map(url => url.trim()).filter(Boolean);
        if (!sources.length || sources.some(source => { const url = new URL(source); return url.protocol !== 'https:' || !!url.username || !!url.password || !!url.hash; })) throw Error('Invalid URLs');
        input = updateCompanyResearchSettingsRequestSchema.parse({ expectedRevision: snapshot.revision, reviewed: true, configuration: { version: 1, mode: 'known_company', state: 'active', profileId: profile.id, researchLimits: profile.researchLimits, maxAccountBudgetMicros: budget(draft.dollars), permittedSources: sources } });
      }
    } catch { setMessage('Enter explicit HTTPS page URLs and a positive USD ceiling with at most six decimal places.'); return; }
    const sequence = generation.current; update({ attempted: input }); busy.current = true; setPending(true); setMessage('Saving locally…');
    try {
      const result = companyResearchSettingsUpdateReplySchema(input).parse(await api.updateCompanyResearchSettings(input));
      if (sequence !== generation.current) return;
      update({ snapshot: result, observed: result, unknown: false }); setReviewed(false); if (!pause) dirty.current = false; retained.delete(api);
      setMessage(pause ? 'Local research paused. Reviewed settings and accounting are retained.' : 'Saved locally. Research has not started.');
    } catch {
      if (sequence !== generation.current) return;
      update({ unknown: true }); setLatest(null); setReviewed(false);
      setMessage('Save outcome unknown. Your edits are retained. Refresh current settings before another save.');
    } finally { if (sequence === generation.current) { busy.current = false; setPending(false); } }
  };
  const edit = (patch: Partial<Draft>) => { dirty.current = true; update(patch); setReviewed(false); };
  return <section className="settings__section settings-local-research" aria-label="Local company research">
    <div className="settings-local-research__header"><h2 className="settings__section-title">Local company research</h2><span>{snapshot?.configuration?.state === 'active' ? 'Configured locally' : snapshot?.configuration?.state === 'paused' ? 'Paused' : 'Not configured'}</span></div>
    <p>Set bounds here. Start research separately from the selected company in Accounts. Gmail and Worker connection are not needed.</p>
    {snapshot?.blockedReason && <p role="status">Paired research is present. Local activation is held. You may pause existing local research without changing its reviewed fields.</p>}
    {snapshot?.configuration?.state === 'paused' && <p>Local research is paused. Saving an acknowledged setup enables only a later explicit Research request.</p>}
    <p>{!model || model.model !== 'ready' ? 'Model storage is unavailable or not configured. Review the existing Connections form.' : model.modelName !== extraction?.model ? `Stored model does not match the reviewed profile (${model.modelName}). Review the existing Connections form.` : 'Stored model matches the reviewed profile.'} Stored configuration is not provider qualification or billing proof.</p>
    <form onSubmit={event => { event.preventDefault(); void save(false); }}>
      <div className="settings-local-research__fields">
        <div><label htmlFor="local-research-sources">Explicit HTTPS source URLs</label><textarea id="local-research-sources" spellCheck={false} autoComplete="off" value={draft.sources} disabled={pending || !current} onChange={event => edit({ sources: event.target.value })} aria-describedby="local-research-source-help" /><p id="local-research-source-help">One exact page per line. Exact selected-company hostname only. No crawling, guessed paths or automatic www matching.</p></div>
        <div><label htmlFor="local-research-ceiling">Cumulative local ceiling (USD)</label><div className="settings-local-research__dollars"><span>USD $</span><input id="local-research-ceiling" inputMode="decimal" value={draft.dollars} disabled={pending || !current} onChange={event => edit({ dollars: event.target.value })} aria-describedby="local-research-budget-help" /></div><p id="local-research-budget-help">Across local research jobs, not a fresh per-company allowance. Saving never resets spend.</p><p>Reserved or known spend: {snapshot ? `$${money(snapshot.reservedOrSpentMicros)} USD` : 'Unavailable'}. Not invoice spend.</p></div>
      </div>
      <section className="settings-local-research__profile" aria-label="Read-only reviewed request profile">
        <strong>Reviewed request profile</strong>
        {snapshot && snapshot.profiles.length > 1 && <label>Request profile<select value={draft.profileId} disabled={pending} onChange={event => edit({ profileId: event.target.value })}>{snapshot.profiles.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>}
        {snapshot?.configuration && profile && JSON.stringify(snapshot.configuration.researchLimits) !== JSON.stringify(profile.researchLimits) && <p>The saved limits differ from this supported profile. Saving requires a fresh review. Pausing preserves the saved limits.</p>}
        {profile && extraction && limits ? <><p>{profile.label} · Reviewed {profile.reviewedAt}</p>
          <div className="settings-local-research__profile-grid"><div><span>Exact model</span><strong>{extraction.model}</strong></div><div><span>Per-attempt reservation cap</span><strong>${money(limits.maxCostMicros)} USD</strong></div><div><span>Scope</span><strong>{limits.maxCompanies} selected company</strong></div></div>
          <details><summary>Advanced limits &amp; rate assumptions · read-only</summary><dl><dt>Published pages</dt><dd>{limits.maxPages}</dd><dt>Total source bytes</dt><dd>{limits.maxBytes.toLocaleString('en-US')}</dd><dt>Model input / output</dt><dd>{extraction.maxInputBytes.toLocaleString('en-US')} bytes / {extraction.maxOutputTokens.toLocaleString('en-US')} tokens</dd><dt>Reviewed input rate</dt><dd>${money(extraction.inputMicrosPerMillionTokens)} / 1M tokens</dd><dt>Reviewed output rate</dt><dd>${money(extraction.outputMicrosPerMillionTokens)} / 1M tokens</dd><dt>Job / extraction ceiling</dt><dd>${money(limits.maxCostMicros)} / ${money(extraction.maxCostMicros)}</dd></dl><p>Profile reference: {profile.referenceUrl}. Reviewed assumptions are supplied by the app, not inferred from the model name or a live price lookup. No discovery or contact lookup is included.</p></details>
        </> : <p>No supported reviewed profile is available. Activation is unavailable.</p>}
      </section>
      <label className="settings-local-research__review"><input type="checkbox" aria-label="I have reviewed this setup" checked={reviewed} disabled={pending || draft.unknown || !!latest} onChange={event => setReviewed(event.target.checked)} /><span>I have reviewed this setup: bounded published page text goes to the exact model only after an explicit Research request, within these request limits and the cumulative local ceiling.</span></label>
      <div className="settings-local-research__footer"><div className="settings__row-actions"><Button type="submit" disabled={pending || !current || !snapshot || !extraction || !reviewed || draft.unknown || !!latest || !!snapshot.blockedReason}>Save local research</Button>{snapshot?.configuration && <Button variant="quiet" disabled={pending || !current || draft.unknown || !!latest || snapshot.configuration.state !== 'active'} onClick={() => void save(true)}>Pause local research</Button>}</div><a href="#/accounts">Return to selected company</a></div>
      <p>Save does not fetch pages, run Research or send anything.</p>
    </form>
    <p role="status">{message}</p>
    <Button variant="quiet" disabled={!api || pending || !current} onClick={() => void refresh()}>Refresh current settings</Button>
    {latest && draft.attempted && <p role="status">{companyResearchSettingsUpdateReplySchema(draft.attempted).safeParse(latest).success ? 'Current stored record exactly matches the attempted save. No new command was issued.' : 'Current stored record does not exactly match the attempted save. Review before making any new change.'}</p>}
    {latest && <section aria-label="Current stored local research settings"><h3>Current stored settings · revision {latest.revision}</h3><p>{latest.configuration ? `${latest.configuration.state} · ${latest.configuration.profileId} · $${money(latest.configuration.maxAccountBudgetMicros)} USD cumulative ceiling` : 'Not configured'}</p><pre>{latest.configuration?.permittedSources.join('\n') ?? 'No sources'}</pre><details><summary>Current stored reviewed limits</summary><pre>{JSON.stringify(latest.configuration?.researchLimits ?? null, null, 2)}</pre></details><p>Reserved or known spend: ${money(latest.reservedOrSpentMicros)} USD. {latest.blockedReason ? 'Paired research is present.' : ''}</p><Button variant="quiet" disabled={pending} onClick={() => { update({ snapshot: latest, unknown: false }); setLatest(null); setReviewed(false); setMessage('Current revision reviewed. Your edits are unchanged. Acknowledge before saving deliberately.'); }}>I reviewed current settings</Button></section>}
  </section>;
}
