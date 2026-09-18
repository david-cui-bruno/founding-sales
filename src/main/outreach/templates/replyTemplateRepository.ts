import type { AppDatabase } from '../../db/database';
import {
  editReplyTemplateSchema, replyTemplateContentHash, replyTemplateSchema, replyTemplateSnapshotSchema, replyTemplateTextIssues,
  type EditReplyTemplate, type ReplyTemplate, type ReplyTemplateId, type ReplyTemplateSnapshot, type ReplyTemplateVariable,
} from '../../../shared/contracts/replyTemplateContract';

type Row = {
  id: string; name: string; purpose: string; subject: string; body: string; variables_json: string; revision: number;
  approval_state: string; approved_revision: number | null; approved_at: string | null; content_hash: string | null; updated_at: string;
};
const SELECT = `SELECT id,name,purpose,subject,body,variables_json,revision,approval_state,approved_revision,approved_at,content_hash,updated_at
  FROM email_templates ORDER BY id`;

/**
 * The five templates as this Mac holds them (schema 30). Reading, editing and recording an approval are the
 * only operations; nothing here sends, dials or reaches the worker. An edit bumps the revision by one and
 * returns an approved template to `revoked`, because the text David approved is no longer the text on file.
 * Recording an approval is deliberately separate from making it: the caller records it only after the worker
 * has accepted the owner command that carried the exact same revision and hash, so a template can never read
 * as "the worker will send this" while the worker knows nothing about it.
 */
export class SqlReplyTemplateRepository {
  constructor(readonly deps: { database: AppDatabase; clock: { now(): string } }) {}

  read(): ReplyTemplateSnapshot {
    const raw = this.deps.database.raw;
    const rows = raw.prepare(SELECT).all() as Row[];
    const settings = raw.prepare('SELECT paused,revision,updated_at FROM email_template_settings WHERE singleton=1').get() as
      { paused: number; revision: number; updated_at: string } | undefined;
    if (!settings) throw new Error('reply_template_settings_missing');
    return replyTemplateSnapshotSchema.parse({
      templates: rows.map(row => replyTemplateSchema.parse({
        id: row.id, name: row.name, purpose: row.purpose, subject: row.subject, body: row.body,
        variables: JSON.parse(row.variables_json) as ReplyTemplateVariable[], revision: row.revision,
        approval: { state: row.approval_state, approvedRevision: row.approved_revision, approvedAt: row.approved_at, contentHash: row.content_hash },
        updatedAt: row.updated_at,
      })),
      settings: { paused: settings.paused === 1, revision: settings.revision, updatedAt: settings.updated_at },
    });
  }

  get(templateId: ReplyTemplateId): ReplyTemplate {
    const template = this.read().templates.find(entry => entry.id === templateId);
    if (!template) throw new Error('reply_template_unknown');
    return template;
  }

  /** One local edit. The text is refused by the same rules the schema applies, before any row changes. */
  edit(rawInput: EditReplyTemplate): ReplyTemplateSnapshot {
    const input = editReplyTemplateSchema.parse(rawInput);
    const issues = replyTemplateTextIssues(input);
    if (issues.length) throw new Error(issues[0]!);
    const raw = this.deps.database.raw;
    if (raw.inTransaction) throw new Error('reply_template_requires_own_transaction');
    return raw.transaction(() => {
      const current = this.get(input.templateId);
      if (current.revision !== input.expectedRevision) throw new Error('stale_reply_template');
      const next = replyTemplateSchema.parse({ ...current, subject: input.subject, body: input.body,
        variables: templateVariables(input), revision: current.revision + 1,
        // An edit is never an approval: an approved template becomes `revoked` and a draft stays a draft.
        approval: { state: current.approval.state === 'draft' ? 'draft' : 'revoked', approvedRevision: null, approvedAt: null, contentHash: null },
        updatedAt: this.deps.clock.now() });
      raw.prepare(`UPDATE email_templates SET subject=?,body=?,variables_json=?,revision=?,approval_state=?,
        approved_revision=NULL,approved_at=NULL,content_hash=NULL,updated_at=? WHERE id=? AND revision=?`)
        .run(next.subject, next.body, JSON.stringify(next.variables), next.revision, next.approval.state, next.updatedAt, next.id, current.revision);
      return this.read();
    }).immediate();
  }

  /**
   * Record the standing approval the worker has already accepted. The revision and hash must be exactly the
   * ones the command carried, so a template edited between the click and the receipt stays unapproved.
   */
  recordApproval(input: { templateId: ReplyTemplateId; revision: number; contentHash: string }): ReplyTemplateSnapshot {
    const raw = this.deps.database.raw;
    if (raw.inTransaction) throw new Error('reply_template_requires_own_transaction');
    return raw.transaction(() => {
      const current = this.get(input.templateId);
      if (current.revision !== input.revision || replyTemplateContentHash(current) !== input.contentHash) throw new Error('stale_reply_template');
      const approvedAt = this.deps.clock.now();
      replyTemplateSchema.parse({ ...current, approval: { state: 'approved', approvedRevision: current.revision, approvedAt, contentHash: input.contentHash }, updatedAt: approvedAt });
      raw.prepare(`UPDATE email_templates SET revision=?,approval_state='approved',approved_revision=?,approved_at=?,content_hash=?,updated_at=? WHERE id=? AND revision=?`)
        .run(current.revision, current.revision, approvedAt, input.contentHash, approvedAt, current.id, current.revision);
      return this.read();
    }).immediate();
  }

  /** Record a revocation the worker has already accepted. Idempotent on an already unapproved template. */
  recordRevocation(input: { templateId: ReplyTemplateId; revision: number }): ReplyTemplateSnapshot {
    const raw = this.deps.database.raw;
    if (raw.inTransaction) throw new Error('reply_template_requires_own_transaction');
    return raw.transaction(() => {
      const current = this.get(input.templateId);
      if (current.revision !== input.revision) throw new Error('stale_reply_template');
      if (current.approval.state !== 'draft') {
        raw.prepare(`UPDATE email_templates SET revision=?,approval_state='revoked',approved_revision=NULL,approved_at=NULL,content_hash=NULL,updated_at=? WHERE id=? AND revision=?`)
          .run(current.revision, this.deps.clock.now(), current.id, current.revision);
      }
      return this.read();
    }).immediate();
  }

  /** Record the workspace pause switch the worker has already accepted. */
  recordPaused(paused: boolean): ReplyTemplateSnapshot {
    const raw = this.deps.database.raw;
    if (raw.inTransaction) throw new Error('reply_template_requires_own_transaction');
    return raw.transaction(() => {
      const settings = this.read().settings;
      if (settings.paused === paused) return this.read();
      raw.prepare('UPDATE email_template_settings SET paused=?,revision=?,updated_at=? WHERE singleton=1 AND revision=?')
        .run(paused ? 1 : 0, settings.revision + 1, this.deps.clock.now(), settings.revision);
      return this.read();
    }).immediate();
  }
}
/** The variables the edited text names, in the contract's declared order, so the row never over- or under-declares. */
function templateVariables(input: { subject: string; body: string }): ReplyTemplateVariable[] {
  const named = new Set((`${input.subject}\n${input.body}`.match(/\{[^{}]*\}/g) ?? []).map(match => match.slice(1, -1)));
  return (['firm', 'city', 'callback_date', 'next_step', 'my_name', 'my_phone', 'booking_link'] as const).filter(name => named.has(name));
}
