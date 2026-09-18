import { useEffect, useRef, useState } from 'react';
import type { CalliePreloadApi } from '../../shared/preload';
import {
  REPLY_TEMPLATE_SENDER_DAILY_LIMIT, editReplyTemplateSchema, replyTemplateRequestSchema, replyTemplateStatusSchema,
  sendingLimitsRequestSchema, sendingLimitsStatusSchema, type ReplyTemplate, type ReplyTemplateRequest, type ReplyTemplateSnapshot, type SendingLimitsStatus,
} from '../../shared/contracts/replyTemplateContract';
import { remoteGoogleGrantStatusSchema } from '../../shared/contracts/remoteGoogleGrantContract';
import { describeSenderCap } from './WorkerSetupSection';

/** The cap view the Worker connection section already renders; reused so the two lines cannot drift. */
type SenderCap = Parameters<typeof describeSenderCap>[0];

type Templates = NonNullable<CalliePreloadApi['templates']>;
/** `sendingLimits` is absent on a bridge without the worker connection; the section then names that hold. */
type Api = Omit<Templates, 'sendingLimits'> & Partial<Pick<Templates, 'sendingLimits'>>;
type GrantApi = NonNullable<CalliePreloadApi['delegation']['googleConnections']>;
const STATE_LABEL: Record<ReplyTemplate['approval']['state'], string> = {
  draft: 'Draft — never sent', approved: 'Approved — standing', revoked: 'Revoked — edited since you approved it',
};
/** The one confirmation David reads before a template becomes standing permission. Named once so the copy cannot drift. */
export const REPLY_TEMPLATE_APPROVAL_STATEMENT =
  'The worker will send this template as a sequence step without asking again, from callie@usecallie.com, until you edit it or revoke it.';
export const REPLY_TEMPLATE_PAUSE_STATEMENT =
  'Pause all sends holds every template, including the ones you have approved. Your approvals are kept; nothing goes out until you switch it back on.';

type Draft = { subject: string; body: string };
type View = {
  snapshot: ReplyTemplateSnapshot | null; message: string; pending: boolean;
  drafts: Record<string, Draft>; confirming: string | null; confirmPause: boolean;
  limits: SendingLimitsStatus | null; senderCap: SenderCap;
};
const emptyView = (message: string): View =>
  ({ snapshot: null, message, pending: false, drafts: {}, confirming: null, confirmPause: false, limits: null, senderCap: { state: 'unread' } });

/**
 * Settings → Email templates (design D13, David's decision of 17 September 2026). The five follow-up templates
 * he approves once: each shows its purpose, its variables, its approval state and its revision. Editing is
 * local and always allowed; an edit after an approval returns the template to `revoked` until he approves the
 * new revision. Approving takes one confirmation that names the standing effect, because it is permission for
 * the worker to send that template as a sequence step with no further click.
 *
 * "Pause all sends" holds every template without discarding a single approval. "Sending limits" writes the one
 * `sender-caps` row the worker's dispatch path requires before any send, with the sender read from the recorded
 * grant rather than typed. Nothing in this section sends, dials or books, and a failed response is shown as
 * unknown with the section re-reading before it offers another write.
 */
export function EmailTemplatesSection({ api, grants }: { api?: Api; grants?: GrantApi }) {
  const usable = api && typeof api.read === 'function' ? api : undefined;
  const [view, setView] = useState<View>(() => emptyView('Email templates are unavailable.'));
  const generation = useRef(0);
  const busy = useRef(false);

  const read = async (request: number, after: string | null) => {
    if (!usable) return;
    try {
      const status = replyTemplateStatusSchema.parse(await usable.read());
      if (request !== generation.current) return;
      setView(previous => ({ ...previous, snapshot: status.snapshot, message: after ?? '', drafts: {} }));
    } catch {
      if (request === generation.current) setView(previous => ({ ...previous, snapshot: null,
        message: after ? `${after} The current templates could not be read.` : 'Email templates are unavailable.' }));
    } finally {
      if (request === generation.current) { busy.current = false; setView(previous => ({ ...previous, pending: false, confirming: null, confirmPause: false })); }
    }
  };
  useEffect(() => {
    const request = ++generation.current;
    busy.current = !!usable;
    setView({ ...emptyView(usable ? 'Loading email templates…' : 'Email templates are unavailable.'), pending: !!usable });
    if (usable) void read(request, null);
    return () => { generation.current++; };
  // `read` closes over `usable`, which is the only value this effect keys on.
  }, [usable]);

  const write = async (label: string, operation: () => Promise<unknown>) => {
    if (!usable || busy.current) return;
    const request = generation.current;
    busy.current = true;
    setView(previous => ({ ...previous, pending: true, message: `${label}…` }));
    let after: string;
    try { await operation(); after = request === generation.current ? `${label} recorded.` : ''; }
    catch { after = `${label} outcome unknown. Review the current templates before another change.`; }
    if (request !== generation.current) return;
    await read(request, after);
  };
  /** Today's cap is a separate observation of the cloud grant: its failure never disturbs the local templates. */
  const refreshCap = async () => {
    if (!grants) return;
    const request = generation.current;
    try {
      const status = remoteGoogleGrantStatusSchema.parse(await grants.status({ purpose: 'permitted_correspondence' }));
      if (request === generation.current) setView(previous => ({ ...previous, senderCap: { state: 'read', cap: status.senderCap ?? null } }));
    } catch {
      if (request === generation.current) setView(previous => ({ ...previous, senderCap: { state: 'unread' } }));
    }
  };

  const snapshot = view.snapshot;
  const draftFor = (template: ReplyTemplate): Draft => view.drafts[template.id] ?? { subject: template.subject, body: template.body };
  const setDraft = (template: ReplyTemplate, patch: Partial<Draft>) =>
    setView(previous => ({ ...previous, drafts: { ...previous.drafts, [template.id]: { ...draftFor(template), ...patch, ...{} } } }));
  const dirty = (template: ReplyTemplate) => {
    const draft = draftFor(template);
    return draft.subject !== template.subject || draft.body !== template.body;
  };
  const save = (template: ReplyTemplate) => {
    const draft = draftFor(template);
    let input;
    try { input = Object.freeze(editReplyTemplateSchema.parse({ templateId: template.id, expectedRevision: template.revision, subject: draft.subject, body: draft.body })); }
    catch { setView(previous => ({ ...previous, message: 'That subject or body is not a shape a template may take. Keep it plain text, under ninety words, with the sign-off.' })); return; }
    void write(`Edit to ${template.id}`, () => usable!.edit(input));
  };
  /** The renderer names the command identity so a retry resends the same owner command, never a second one. */
  const command = <Kind extends 'approve' | 'revoke' | 'pause'>(kind: Kind, fields: Record<string, unknown>) => {
    const parsed = replyTemplateRequestSchema.parse({ kind, commandId: crypto.randomUUID(), ...fields });
    if (parsed.kind !== kind) throw new Error('reply_template_request_kind_mismatch');
    return Object.freeze(parsed) as Extract<ReplyTemplateRequest, { kind: Kind }>;
  };
  const approve = (template: ReplyTemplate) => {
    const input = command('approve', { templateId: template.id, expectedRevision: template.revision });
    void write(`Approval of ${template.id}`, () => usable!.approve(input));
  };
  const revoke = (template: ReplyTemplate) => {
    const input = command('revoke', { templateId: template.id, expectedRevision: template.revision });
    void write(`Revocation of ${template.id}`, () => usable!.revoke(input));
  };
  const setPaused = (paused: boolean) => {
    const input = command('pause', { paused });
    void write(paused ? 'Pause of all sends' : 'Resume of sends', () => usable!.pause(input));
  };
  const writeLimits = () => {
    if (!usable?.sendingLimits) return;
    const input = Object.freeze(sendingLimitsRequestSchema.parse({ requestId: crypto.randomUUID(), expectedRevision: view.limits?.receipt.revision ?? null }));
    void write('Sending limits', async () => {
      const status = sendingLimitsStatusSchema.parse(await usable.sendingLimits!(input));
      setView(previous => ({ ...previous, limits: status }));
      await refreshCap();
    });
  };

  return <section className="settings__section email-templates" aria-label="Email templates">
    <h2 className="settings__section-title">Email templates</h2>
    <p>Five follow-up emails you approve once. An approved template is standing permission for the worker to send that one template as a sequence step from callie@usecallie.com without asking again. Editing a template revokes your approval until you approve the new revision. Approving never sends anything by itself.</p>
    <p role="status">{view.message}</p>

    <h3>Pause all sends</h3>
    <p>{REPLY_TEMPLATE_PAUSE_STATEMENT}</p>
    {snapshot && !view.confirmPause && <button type="button" className="settings__action" disabled={view.pending}
      onClick={() => snapshot.settings.paused ? setPaused(false) : setView(previous => ({ ...previous, confirmPause: true }))}>
      {snapshot.settings.paused ? 'Switch sends back on' : 'Pause all sends'}
    </button>}
    {snapshot && view.confirmPause && <div className="settings__row-actions">
      <button type="button" className="settings__action" disabled={view.pending} onClick={() => setPaused(true)}>Confirm: pause all sends</button>
      <button type="button" className="settings__action" disabled={view.pending} onClick={() => setView(previous => ({ ...previous, confirmPause: false }))}>Keep sends on</button>
    </div>}
    {snapshot && <p>Sends are currently {snapshot.settings.paused ? 'paused' : 'on'} (revision {snapshot.settings.revision}).</p>}

    <h3>Sending limits</h3>
    <p>The worker refuses every send until a daily limit exists for the sending mailbox. This writes one limit of {REPLY_TEMPLATE_SENDER_DAILY_LIMIT} a day with the automatic warm-up ramp: ten a day to start, two more each calendar day, never above {REPLY_TEMPLATE_SENDER_DAILY_LIMIT}. The mailbox is read from the connection you confirmed, not typed here. A limit is a ceiling, never permission to send.</p>
    {usable?.sendingLimits && <button type="button" className="settings__action" disabled={view.pending} onClick={writeLimits}>Write the sending limit</button>}
    {!usable?.sendingLimits && <p>HOLD: the worker connection is unavailable, so no sending limit can be written.</p>}
    {view.limits && <p>Limit recorded for {view.limits.sender}: {view.limits.dailyLimit} a day, ramp {view.limits.ramp.startPerDay} plus {view.limits.ramp.stepPerDay} a day up to {view.limits.ramp.maxPerDay} (revision {view.limits.receipt.revision}).</p>}
    {grants && <p>{describeSenderCap(view.senderCap)}</p>}
    {grants && <button type="button" className="settings__action" disabled={view.pending} onClick={() => void refreshCap()}>Refresh today&rsquo;s cap</button>}

    <h3>The five templates</h3>
    <ul className="email-templates__list">
      {(snapshot?.templates ?? []).map(template => {
        const draft = draftFor(template);
        const changed = dirty(template);
        return <li key={template.id} className="email-templates__template" aria-label={`Template ${template.id}`}>
          <h4>{template.id}. {template.name}</h4>
          <p>Purpose: {template.purpose.replace(/_/g, ' ')} · revision {template.revision} · {STATE_LABEL[template.approval.state]}</p>
          <p>Variables: {template.variables.length ? template.variables.map(variable => `{${variable}}`).join(', ') : 'none'}</p>
          <label>Subject<input aria-label={`${template.id} subject`} type="text" maxLength={160} value={draft.subject}
            readOnly={view.pending} onChange={event => setDraft(template, { subject: event.target.value })} /></label>
          <label>Body<textarea aria-label={`${template.id} body`} rows={12} maxLength={4000} value={draft.body}
            readOnly={view.pending} onChange={event => setDraft(template, { body: event.target.value })} /></label>
          <div className="settings__row-actions">
            <button type="button" className="settings__action" disabled={view.pending || !changed} onClick={() => save(template)}>Save {template.id}</button>
            {view.confirming !== template.id && <button type="button" className="settings__action"
              disabled={view.pending || changed || template.approval.state === 'approved'}
              onClick={() => setView(previous => ({ ...previous, confirming: template.id }))}>Approve {template.id}</button>}
            {template.approval.state === 'approved' && <button type="button" className="settings__action" disabled={view.pending} onClick={() => revoke(template)}>Revoke {template.id}</button>}
          </div>
          {changed && <p>Unsaved changes. Save {template.id} before approving it; saving revokes any approval it already had.</p>}
          {view.confirming === template.id && <div className="email-templates__confirm">
            <p>{REPLY_TEMPLATE_APPROVAL_STATEMENT}</p>
            <div className="settings__row-actions">
              <button type="button" className="settings__action" disabled={view.pending} onClick={() => approve(template)}>Confirm: approve {template.id} for standing sends</button>
              <button type="button" className="settings__action" disabled={view.pending} onClick={() => setView(previous => ({ ...previous, confirming: null }))}>Cancel</button>
            </div>
          </div>}
        </li>;
      })}
    </ul>
  </section>;
}
