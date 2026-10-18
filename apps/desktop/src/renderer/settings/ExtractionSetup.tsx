import { useCallback, useEffect, useRef, useState } from 'react';
import { CRM_EXTRACTION_ENDPOINT, CRM_EXTRACTION_MODELS, CRM_OWNER_SCOPE_VERSION } from '@fss/contracts';
import {
  extractionDraft, extractionSaveInput, extractionSetupFields, extractionSetupNotice,
  extractionSetupPorts, type ExtractionDraft, type ExtractionPurpose, type ExtractionSetupPorts,
} from './extractionSetup.ts';

export function ExtractionSetup({ available, privacyKey, onSaved, ports = extractionSetupPorts }: {
  available: boolean;
  privacyKey: string;
  onSaved(): void;
  ports?: ExtractionSetupPorts;
}) {
  const [purpose, setPurpose] = useState<ExtractionPurpose | null>(null);
  const [draft, setDraft] = useState<ExtractionDraft | null>(null);
  const [capture,setCapture]=useState<Awaited<ReturnType<NonNullable<ExtractionSetupPorts['readCaptureBinding']>>>>(null);
  const [busy, setBusy] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [notice, setNotice] = useState('');
  const epoch = useRef(0);
  const flight = useRef(false);
  const load = useCallback(async () => {
    if (!available || flight.current) return;
    const ticket = epoch.current;
    flight.current = true;
    setBusy(true);
    setPurpose(null);
    setDraft(null);
    setCapture(null);
    setAcknowledged(false);
    setNotice('');
    try {
      const [value,binding] = await Promise.all([ports.read(),ports.readCaptureBinding?.()??Promise.resolve(null)]);
      if (ticket !== epoch.current) return;
      setPurpose(value);
      setDraft(extractionDraft(value));
      setCapture(binding);
    } catch (error) {
      if (ticket === epoch.current) setNotice(extractionSetupNotice(error));
    } finally {
      if (ticket === epoch.current) { flight.current = false; setBusy(false); }
    }
  }, [available, ports]);
  useEffect(() => {
    epoch.current += 1;
    flight.current = false;
    setPurpose(null);
    setDraft(null);
    setCapture(null);
    setBusy(false);
    setAcknowledged(false);
    setNotice('');
    void load();
    return () => { epoch.current += 1; flight.current = false; };
  }, [load, privacyKey]);

  const parsed = draft && purpose && purpose.scopeVersion===CRM_OWNER_SCOPE_VERSION && capture ? extractionSaveInput(draft, purpose.revision,capture.ownerApprovalId) : null;
  async function save() {
    if (!available || flight.current || !acknowledged || !parsed?.success) return;
    const ticket = epoch.current;
    flight.current = true;
    setBusy(true);
    setNotice('');
    try {
      const result = await ports.save(parsed.data);
      if (ticket !== epoch.current) return;
      // A fresh read, not the edited draft, establishes the next revision.
      setPurpose(null);
      setDraft(null);
      onSaved();
      setNotice(`Saved disabled configuration revision ${String(result.revision)}. No consent or activation was requested. Reload to inspect current settings.`);
    } catch (error) {
      if (ticket !== epoch.current) return;
      setPurpose(null);
      setDraft(null);
      setNotice(extractionSetupNotice(error));
    } finally {
      if (ticket === epoch.current) { flight.current = false; setBusy(false); setAcknowledged(false); }
    }
  }
  const update = (key: keyof ExtractionDraft, value: string) => {
    setDraft(old => old ? { ...old, [key]: value } : null);
    setAcknowledged(false);
  };
  return <section aria-label="Evidence extraction setup" aria-busy={busy}>
    <h2>Evidence extraction setup</h2>
    <p>Owner configuration only. Connecting Gmail is not consent. Capture of qualified incoming and owner-Sent business mail requires its own approval and excludes personal, excluded and unresolved conversations. Hosted extraction of needs, objections and commitments requires separate explicit approval.</p>
    <p>Disable stops fresh work, not accepted provider requests, and retains copied history and consent audit. Explicit scoped deletion erases Callie copies and dependent evidence, not Gmail originals. Disconnect stops new capture, not deletion. Historical backfill requires a separate bounded approval.</p>
    <p>This form does not enable capture, extraction, Ask answering, indexing, embeddings, backfill or sending. Plain keyword and record search remain available. Saving clears any current extraction approval and leaves extraction disabled.</p>
    <p>Extraction scope is mail only, bound to the current approved capture epoch. Notes, call transcripts and meeting transcripts are not authorized. Incoming and owner-Sent originals must be at or after capture activation, with no older backfill.</p>
    <p>A route on this reviewed list is not proof of a deployed adapter, funding or current access. Enter the exact independently verified access/data-handling versions, token prices and budgets. Proposed defaults are not permission. No automatic provider fallback.</p>
    {!available ? <p>Authenticated owner administrator setup is unavailable.</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    <button type="button" disabled={!available || busy} onClick={() => { void load(); }}>Reload extraction configuration</button>
    {purpose && draft ? <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <p>{capture?`Bound business mailbox: ${capture.mailboxEmail}. Mail-only capture approval: ${capture.ownerApprovalId}.`:'Current approved mailbox capture is unavailable. Configure and activate forward-only capture, then reload. Extraction stays off.'}</p>
      <p>Current extraction: {purpose.enabled ? 'enabled' : 'disabled'}; revision {purpose.revision}. {purpose.configured ? 'Configured values below are editable proposals until saved.' : 'Not configured. No model, prices or budget have been assumed.'}</p>
      <fieldset disabled={!available || busy}>
        <legend>Proposed AWS Bedrock configuration</legend>
        <p>API endpoint region: us-east-1. The us.* model IDs are cross-US-region inference profiles, not a guarantee of us-east-1-only inference. Review the applicable data-handling version for the exact approved processing scope.</p>
        <label>Endpoint<select value={draft.endpointId} onChange={event => update('endpointId', event.target.value)}>
          <option value="">Select verified endpoint</option>
          {draft.endpointId && draft.endpointId !== CRM_EXTRACTION_ENDPOINT ? <option value={draft.endpointId}>{draft.endpointId} (unsupported)</option> : null}
          <option value={CRM_EXTRACTION_ENDPOINT}>{CRM_EXTRACTION_ENDPOINT}</option>
        </select></label>
        <label>Model<select value={draft.modelVersion} onChange={event => update('modelVersion', event.target.value)}>
          <option value="">Select verified model</option>
          {draft.modelVersion && !(CRM_EXTRACTION_MODELS as readonly string[]).includes(draft.modelVersion) ? <option value={draft.modelVersion}>{draft.modelVersion} (unsupported)</option> : null}
          {CRM_EXTRACTION_MODELS.map(model => <option key={model} value={model}>{model}</option>)}
        </select></label>
        {extractionSetupFields.map(([key, label]) => <label key={key}>{label}<input required value={draft[key]} onChange={event => update(key, event.target.value)} /></label>)}
        <p>Prices are exact microdollars per token, not dollars per token. Budgets are integer USD cents. Blank or invalid values cannot be saved.</p>
        <label><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />I reviewed these exact proposed values. Save disabled configuration only, clearing any current extraction approval. This is not capture, extraction, spending or backfill consent.</label>
        <button type="submit" disabled={!parsed?.success || !acknowledged}>Save disabled extraction configuration</button>
      </fieldset>
    </form> : null}
  </section>;
}
