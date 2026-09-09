import {
  assertDailySessionScope,
  captureDailySessionScope,
} from './dailySessionScope';
import type { CalliePreloadApi } from '../../../shared/preload';
import {
  approveRequestedFollowupSchema,
  requestedFollowupDraftSchema,
  type ApproveRequestedFollowup,
  type RequestedApprovalStatus,
  type RequestedFollowupDraft,
} from '../../../shared/contracts/requestedFollowupContract';
export type RequestedDraftApi = Pick<
  CalliePreloadApi['delegation'],
  'getRequestedFollowup' | 'editRequestedFollowup' | 'approveRequestedFollowup'
>;
type State = {
  draft: RequestedFollowupDraft;
  subject: string;
  body: string;
  busy: boolean;
  saving: boolean;
  conflict: boolean;
  stale: boolean;
  error: string | null;
  approval: RequestedApprovalStatus | null;
  unknownApproval: boolean;
  incoming: RequestedFollowupDraft | null;
  expiry: string;
  attested: boolean;
};
const identity = (d: RequestedFollowupDraft) =>
  JSON.stringify({
    ...d,
    revision: 0,
    subject: '',
    body: '',
    evidenceIds: [],
    generation: 'edited',
    updatedAt: '',
  });
/** API + workspace + fixed draft/recipient identity. No read here materializes a draft.
 * Only explicit edit/save responses acknowledge a canonical remote revision. */
class RequestedDraftSession {
  private state: State;
  private listeners = new Set<() => void>();
  private saving: Promise<void> | null = null;
  private remoteAcknowledgedRevision: number | null = null;
  private approvalCommand: ApproveRequestedFollowup | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private actionHold: string | undefined;
  private generation = 0;
  focus: { field: 'subject' | 'body'; start: number; end: number } | null =
    null;
  constructor(
    private api: RequestedDraftApi,
    private workspaceId: string,
    draft: RequestedFollowupDraft,
    approval: RequestedApprovalStatus | null,
  ) {
    this.state = {
      draft,
      subject: draft.subject,
      body: draft.body,
      approval,
      busy: false,
      saving: false,
      conflict: false,
      stale: false,
      error: null,
      unknownApproval: false,
      incoming: null,
      expiry: '',
      attested: false,
    };
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<State>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }
  private dirty() {
    return (
      this.state.subject !== this.state.draft.subject ||
      this.state.body !== this.state.draft.body
    );
  }
  setActionHold(reason: string | undefined) {
    if (reason) this.generation++;
    this.actionHold = reason;
    if (reason && this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
  ingest(
    draft: RequestedFollowupDraft,
    approval: RequestedApprovalStatus | null,
  ) {
    if (identity(draft) !== identity(this.state.draft)) {
      this.update({
        conflict: true,
        incoming: draft,
        error:
          'Recipient or context changed. Local edits retained. Review the saved identity before continuing.',
      });
      return;
    }
    if (draft.revision < this.state.draft.revision || this.saving) return;
    if (
      draft.revision === this.state.draft.revision &&
      draft.subject === this.state.draft.subject &&
      draft.body === this.state.draft.body
    ) {
      if (
        approval &&
        JSON.stringify(approval) !== JSON.stringify(this.state.approval)
      )
        this.update({ approval });
      return;
    }
    this.remoteAcknowledgedRevision = null;
    // A concurrent revision always needs review, even if local text was clean.
    this.update({
      conflict: true,
      incoming: draft,
      error:
        'The saved revision changed. Your local text is retained for review.',
    });
  }
  reviewNewIdentity(previous: State) {
    this.update({
      subject: previous.subject,
      body: previous.body,
      conflict: true,
      incoming: this.state.draft,
      error:
        'Recipient or context changed. Earlier local text is retained separately. Review the new saved identity before continuing.',
    });
  }
  setPermission(expiry: string, attested: boolean) {
    this.update({ expiry, attested });
  }
  edit(field: 'subject' | 'body', value: string) {
    if (
      this.state.busy ||
      this.state.unknownApproval ||
      this.state.approval?.state === 'pending_preflight' ||
      this.state.approval?.state === 'materialized'
    )
      return;
    this.remoteAcknowledgedRevision = null;
    this.update({ [field]: value, error: null });
  }
  autosave() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().catch((): void => undefined);
    }, 800);
  }
  flush(forceAcknowledgement = false): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (
      this.actionHold ||
      this.state.conflict ||
      this.state.stale ||
      this.state.unknownApproval
    )
      return Promise.reject(Error('Review required'));
    if (this.saving) return this.saving;
    if (
      !this.dirty() &&
      (!forceAcknowledgement ||
        this.remoteAcknowledgedRevision === this.state.draft.revision)
    )
      return Promise.resolve();
    try {
      assertDailySessionScope(this.api, this.workspaceId);
    } catch {
      return Promise.reject(Error('View scope changed'));
    }
    const assertScope = captureDailySessionScope(this.api, this.workspaceId);
    const generation = this.generation;
    this.update({ saving: true });
    this.saving = (async () => {
      try {
        let force = forceAcknowledgement;
        while (this.dirty() || force) {
          assertScope();
          if (generation !== this.generation)
            throw Error('Operation cancelled');
          if (this.actionHold) throw Error('View scope held');
          force = false;
          const { draft, subject, body } = this.state;
          const result = await this.api.editRequestedFollowup({
            accountId: draft.accountId,
            draftId: draft.id,
            expectedRevision: draft.revision,
            subject,
            body,
          });
          const next = requestedFollowupDraftSchema.parse(result.draft);
          if (
            identity(next) !== identity(draft) ||
            next.revision <= draft.revision ||
            next.subject !== subject ||
            next.body !== body ||
            result.stale
          )
            throw Error('Saved identity changed');
          // Never replace keystrokes typed while this CAS save was in flight.
          this.remoteAcknowledgedRevision = next.revision;
          this.update({ draft: next, approval: result.approval, error: null });
          if (this.state.conflict)
            throw Error('Concurrent snapshot requires review');
        }
      } catch {
        this.remoteAcknowledgedRevision = null;
        this.update({
          error:
            'Save unavailable. Local edits retained. Use owner preflight to recover before approval.',
        });
        throw Error('Save failed');
      } finally {
        this.saving = null;
        this.update({ saving: false });
      }
    })();
    return this.saving;
  }
  async preflight() {
    if (this.actionHold || this.state.busy || this.state.saving) return;
    this.update({ busy: true });
    try {
      assertDailySessionScope(this.api, this.workspaceId);
      const result = await this.api.getRequestedFollowup({
        accountId: this.state.draft.accountId,
        draftId: this.state.draft.id,
      });
      if (!result) throw Error('Missing draft');
      this.ingest(
        requestedFollowupDraftSchema.parse(result.draft),
        result.approval,
      );
      this.update({
        stale: result.stale,
        ...(result.stale
          ? {
              error:
                'Owner context is stale. Refresh account evidence before approval.',
            }
          : {}),
      });
      // Getter may fall back to SQL. It is never a remote acknowledgement.
    } catch {
      this.update({
        error:
          'Owner preflight unavailable. Local edits retained. Retry explicitly when available.',
      });
    } finally {
      this.update({ busy: false });
    }
  }
  useSavedVersion() {
    if (!this.state.incoming || this.state.busy || this.state.unknownApproval)
      return;
    const draft = this.state.incoming;
    this.remoteAcknowledgedRevision = null;
    this.update({
      draft,
      subject: draft.subject,
      body: draft.body,
      incoming: null,
      conflict: false,
      stale: false,
      approval: null,
      error: null,
      expiry: '',
      attested: false,
    });
  }
  async approve(expiresAt: string, attested: boolean) {
    if (
      !attested ||
      this.state.busy ||
      this.state.conflict ||
      this.state.stale ||
      this.state.unknownApproval ||
      this.state.approval?.state === 'pending_preflight' ||
      this.state.approval?.state === 'materialized'
    )
      return;
    if (
      !Number.isFinite(Date.parse(expiresAt)) ||
      Date.parse(expiresAt) <= Date.now()
    ) {
      this.update({ error: 'Choose an explicit future approval expiry.' });
      return;
    }
    this.update({ busy: true });
    try {
      const assertScope = captureDailySessionScope(this.api, this.workspaceId);
      const generation = this.generation;
      await this.flush(true);
      assertScope();
      if (generation !== this.generation) throw Error('Operation cancelled');
      if (this.actionHold) throw Error('View scope held');
      const draft = this.state.draft;
      if (this.remoteAcknowledgedRevision !== draft.revision)
        throw Error('Remote acknowledgement missing');
      this.approvalCommand = approveRequestedFollowupSchema.parse({
        draft,
        expectedRemoteDraftRevision: this.remoteAcknowledgedRevision,
        approvalId: crypto.randomUUID(),
        actionId: crypto.randomUUID(),
        intentCommandId: crypto.randomUUID(),
        request: {
          statement: 'recipient_requested_information_by_email',
          recipient: draft.recipient,
        },
        expiresAt,
      });
      await this.submitRetainedApproval();
    } catch {
      if (!this.state.error)
        this.update({
          error:
            'Approval was not submitted. Review and save the exact draft first.',
        });
    } finally {
      this.update({ busy: false });
    }
  }
  private async submitRetainedApproval() {
    if (!this.approvalCommand) return;
    try {
      assertDailySessionScope(this.api, this.workspaceId);
      this.update({
        approval: await this.api.approveRequestedFollowup(this.approvalCommand),
        unknownApproval: false,
        error: null,
      });
    } catch {
      this.update({
        unknownApproval: true,
        error:
          'Approval receipt unknown. Not confirmed sent. Recover or explicitly retry the same approval.',
      });
    }
  }
  async retryApproval() {
    if (
      this.actionHold ||
      !this.state.unknownApproval ||
      this.state.busy ||
      this.state.conflict ||
      !this.approvalCommand
    )
      return;
    this.update({ busy: true });
    try {
      await this.submitRetainedApproval();
    } finally {
      this.update({ busy: false });
    }
  }
}
const sessions = new WeakMap<
  RequestedDraftApi,
  Map<string, RequestedDraftSession>
>();
export function requestedDraftSession(
  api: RequestedDraftApi,
  workspaceId: string,
  draft: RequestedFollowupDraft,
  approval: RequestedApprovalStatus | null,
) {
  let map = sessions.get(api);
  if (!map) {
    map = new Map();
    sessions.set(api, map);
  }
  // Session holds its immutable recipient identity and refuses changed bindings.
  const key = JSON.stringify([
    workspaceId,
    draft.accountId,
    draft.id,
    identity(draft),
  ]);
  let session = map.get(key);
  if (!session) {
    const prior = [...map.entries()].find(
      ([k, s]) =>
        JSON.parse(k)[0] === workspaceId &&
        s.snapshot().draft.id === draft.id &&
        s.snapshot().draft.accountId === draft.accountId,
    )?.[1];
    session = new RequestedDraftSession(api, workspaceId, draft, approval);
    if (prior) {
      prior.setActionHold(
        'Recipient or context changed. Review the current saved identity.',
      );
      session.reviewNewIdentity(prior.snapshot());
    }
    map.set(key, session);
  }
  return session;
}

/** Update all retained editors, including offscreen drafts, on each local read. */
export function updateRequestedSessionHolds(
  api: RequestedDraftApi,
  hold: (draft: RequestedFollowupDraft) => string | undefined,
) {
  for (const session of sessions.get(api)?.values() ?? [])
    session.setActionHold(hold(session.snapshot().draft));
}
