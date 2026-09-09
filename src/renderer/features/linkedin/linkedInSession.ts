import { assertDailySessionScope } from '../today/dailySessionScope';
import type { DailyAnswer } from '../../../shared/contracts/dailyContract';
import {
  linkedInDraftSchema,
  type LinkedInApi,
  type LinkedInDraft,
  type LinkedInReport,
} from '../../../shared/contracts/linkedInContract';
type Item = Extract<DailyAnswer, { kind: 'manual_linkedin' }>;
type State = {
  incoming: Item | null;
  outcome: LinkedInReport['outcome'] | '';
  replyText: string;
  draft: LinkedInDraft;
  body: string;
  recovery: Item['recovery'];
  busy: boolean;
  conflict: boolean;
  error: string | null;
  feedback: string | null;
  begin: Awaited<ReturnType<LinkedInApi['begin']>> | null;
  report: Awaited<ReturnType<LinkedInApi['reportOutcome']>> | null;
};
const identity = (d: LinkedInDraft) =>
  JSON.stringify([
    d.id,
    d.workspaceId,
    d.accountId,
    d.enrollmentId,
    d.campaignVersionId,
    d.stepId,
    d.routeId,
    d.routeVersion,
    d.contextRevision,
    d.executionContextId,
    d.targetHash,
  ]);
class LinkedInSession {
  private state: State;
  private actionHold: string | undefined;
  focus: { field: 'note' | 'reply'; start: number; end: number } | null = null;
  private listeners = new Set<() => void>();
  private beginCommand: string | null = null;
  private reportCommand: LinkedInReport | null = null;
  constructor(
    private api: LinkedInApi,
    private workspaceId: string,
    item: Item,
  ) {
    this.state = {
      incoming: null,
      outcome: '',
      replyText: '',
      draft: item.draft,
      body: item.draft.body,
      recovery: item.recovery,
      busy: false,
      conflict: false,
      error: null,
      feedback: null,
      begin: null,
      report: null,
    };
    this.beginCommand = item.recovery.approvalCommandId;
  }
  snapshot = () => this.state;
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };
  private update(p: Partial<State>) {
    this.state = { ...this.state, ...p };
    this.listeners.forEach((l) => l());
  }
  ingest(item: Item) {
    if (
      identity(item.draft) !== identity(this.state.draft) ||
      item.draft.revision > this.state.draft.revision
    ) {
      this.update({
        conflict: true,
        incoming: item,
        error:
          'Saved target or revision changed. Local edits retained. Recover the exact saved draft before continuing.',
      });
    } else if (
      item.draft.revision === this.state.draft.revision &&
      (JSON.stringify(item.recovery) !== JSON.stringify(this.state.recovery) ||
        item.draft.state !== this.state.draft.state)
    ) {
      this.update({ draft: item.draft, recovery: item.recovery });
    }
  }
  edit(body: string) {
    if (
      this.state.busy ||
      this.state.draft.state !== 'draft' ||
      this.beginCommand
    )
      return;
    this.update({ body });
  }
  canUseSavedVersion() {
    return (
      !this.state.busy &&
      !(this.beginCommand && !this.state.begin) &&
      !(this.reportCommand && !this.state.report) &&
      this.state.begin?.status !== 'pending' &&
      this.state.report?.receipt.status !== 'pending'
    );
  }
  useSavedVersion() {
    const incoming = this.state.incoming;
    if (!incoming || !this.canUseSavedVersion()) return;
    this.beginCommand = incoming.recovery.approvalCommandId;
    this.reportCommand = null;
    this.update({
      draft: incoming.draft,
      body: incoming.draft.body,
      recovery: incoming.recovery,
      incoming: null,
      conflict: false,
      error: null,
      feedback: null,
      begin: null,
      report: null,
      outcome: '',
      replyText: '',
    });
  }
  setActionHold(reason: string | undefined) {
    this.actionHold = reason;
  }
  chooseOutcome(outcome: LinkedInReport['outcome'] | '') {
    if (!this.reportCommand) this.update({ outcome });
  }
  editReply(replyText: string) {
    if (!this.reportCommand) this.update({ replyText });
  }
  canEdit() {
    return (
      !this.beginCommand &&
      !this.state.busy &&
      this.state.draft.state === 'draft'
    );
  }
  private bound() {
    return {
      draftId: this.state.draft.id,
      expectedRevision: this.state.draft.revision,
    };
  }
  async save() {
    if (this.state.conflict) throw Error('Review required');
    if (this.state.body === this.state.draft.body) return;
    const before = this.state.draft;
    const body = this.state.body;
    const draft = linkedInDraftSchema.parse(
      await this.api.save({ ...this.bound(), body }),
    );
    if (
      identity(draft) !== identity(before) ||
      draft.revision <= before.revision ||
      draft.body !== body
    )
      throw Error('Saved identity changed');
    this.update({ draft });
    if (this.state.conflict) throw Error('Saved context requires review');
  }
  private async run(work: () => Promise<void>) {
    if (this.actionHold || this.state.busy || this.state.conflict) return;
    this.update({ busy: true, error: null });
    try {
      assertDailySessionScope(this.api, this.workspaceId);
      await work();
    } catch {
      this.update({
        error:
          'Action unavailable or receipt unknown. No outcome is inferred. Recover or explicitly retry the same action.',
      });
    } finally {
      this.update({ busy: false });
    }
  }
  saveEdits() {
    return this.run(() => this.save());
  }
  begin() {
    return this.run(async () => {
      await this.save();
      assertDailySessionScope(this.api, this.workspaceId);
      if (this.actionHold) throw Error('View held');
      this.beginCommand ??= crypto.randomUUID();
      const result = await this.api.begin({
        ...this.bound(),
        commandId: this.beginCommand,
      });
      if (
        result.draftId !== this.state.draft.id ||
        result.revision !== this.state.draft.revision
      )
        throw Error('Identity mismatch');
      this.update({
        begin: result,
        feedback:
          result.status === 'pending'
            ? 'Owner approval pending. No manual handoff yet.'
            : 'Manual handoff started. Opening and copying do not send.',
      });
    });
  }
  helper(kind: 'open' | 'copy') {
    return this.run(async () => {
      await this.save();
      assertDailySessionScope(this.api, this.workspaceId);
      if (this.actionHold) throw Error('View held');
      const result = await this.api[kind](this.bound());
      if (
        result.draftId !== this.state.draft.id ||
        result.revision !== this.state.draft.revision
      )
        throw Error('Identity mismatch');
      this.update({
        feedback:
          kind === 'open'
            ? 'LinkedIn opened. No outcome recorded.'
            : 'Note copied. No outcome recorded.',
      });
    });
  }
  canReport() {
    return (
      (this.state.begin?.status === 'started' ||
        this.state.begin?.status === 'already_started' ||
        this.state.recovery.started) &&
      !this.state.report
    );
  }
  report(outcome: LinkedInReport['outcome'], replyText: string) {
    return this.run(async () => {
      if (!this.canReport()) return;
      this.reportCommand ??= {
        ...this.bound(),
        commandId: crypto.randomUUID(),
        outcome,
        observedAt: new Date().toISOString(),
        ...(outcome === 'reply' ? { replyText } : {}),
      };
      if (
        this.reportCommand.outcome !== outcome ||
        (outcome === 'reply' && this.reportCommand.replyText !== replyText)
      )
        throw Error('Retry original outcome or recover');
      const result = await this.api.reportOutcome(this.reportCommand);
      if (
        result.draftId !== this.state.draft.id ||
        result.revision !== this.state.draft.revision
      )
        throw Error('Identity mismatch');
      this.update({
        report: result,
        feedback: `Human outcome receipt: ${result.receipt.status}.`,
      });
    });
  }
  async recover() {
    if (this.actionHold || this.state.busy) return;
    this.update({ busy: true });
    try {
      assertDailySessionScope(this.api, this.workspaceId);
      const draft = await this.api.get(this.bound());
      if (
        identity(draft) !== identity(this.state.draft) ||
        draft.revision !== this.state.draft.revision
      )
        throw Error('Identity changed');
      const recovery = await this.api.recover(this.bound());
      if (recovery.draftId !== draft.id || recovery.revision !== draft.revision)
        throw Error('Identity changed');
      this.update({
        draft,
        recovery,
        conflict: false,
        error: null,
        feedback:
          'Recovered local owner receipts. Remote freshness remains unknown.',
      });
      this.beginCommand ??= recovery.approvalCommandId;
    } catch {
      this.update({
        error:
          'Recovery unavailable for this exact revision. Refresh the daily snapshot and review the changed identity.',
      });
    } finally {
      this.update({ busy: false });
    }
  }
}
const sessions = new WeakMap<LinkedInApi, Map<string, LinkedInSession>>();
export function linkedInSession(
  api: LinkedInApi,
  workspaceId: string,
  item: Item,
) {
  let map = sessions.get(api);
  if (!map) {
    map = new Map();
    sessions.set(api, map);
  }
  const key = JSON.stringify([workspaceId, item.accountId, item.draft.id]);
  let session = map.get(key);
  if (!session) {
    session = new LinkedInSession(api, workspaceId, item);
    map.set(key, session);
  }
  return session;
}
