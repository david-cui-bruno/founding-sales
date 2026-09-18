import type { z } from 'zod';
import { commandReceiptSchema, type CommandReceipt } from '../../shared/contracts/delegationContract';
import {
  editReplyTemplateSchema, replyTemplateContentHash, replyTemplateRequestSchema, replyTemplateStatusSchema,
  sendingLimitsRequestSchema, sendingLimitsStatusSchema, REPLY_TEMPLATE_SENDER_DAILY_LIMIT,
  type ReplyTemplateCommandPayload, type ReplyTemplateRequest, type ReplyTemplateSnapshot, type ReplyTemplateStatus,
} from '../../shared/contracts/replyTemplateContract';
import { remoteGoogleGrantStatusSchema } from '../../shared/contracts/remoteGoogleGrantContract';
import { SENDER_RAMP_DEFAULT, workerPolicyReceiptSchema, workerPolicyRequestSchema } from '../../shared/contracts/workerPolicyContract';
import type { AppDatabase } from '../db/database';
import { SqlReplyTemplateRepository } from '../outreach/templates/replyTemplateRepository';
import { registerValidatedIpc } from './registerValidatedIpc';

/** What main asks the worker to record. Main builds the payload from its own SQL; the delegation runtime owns
 * the command envelope, because it is the only place that holds the current pairing and workspace id. */
export type ReplyTemplateCommandRequest = Readonly<{ commandId: string; payload: ReplyTemplateCommandPayload }>;
/** Only the workspace and pairing identifiers are read from the stored pairing. No credential is ever read here. */
export type ReplyTemplatePairingStore = { load(): Promise<{ workspaceId: string; pairingId: string } | null> };
/** The database gate the runtime already owns. Nothing here opens, migrates or closes a database. */
export type ReplyTemplateDatabaseGate = { withDatabase<T>(operation: (database: AppDatabase) => T): Promise<T> };

/**
 * Settings → Email templates (design D13). Five channels: read the five templates, edit one locally, and
 * approve, revoke or pause through the worker. Registration is inert until the serialized composition root
 * calls it. The `host` is the delegation runtime; the three worker channels are registered only when it
 * actually carries `replyTemplate`, so until the worker hop exists the section reads and edits honestly and
 * offers no approval it cannot keep. The receipt that comes back is parsed before anything is recorded.
 *
 * Approving is a standing permission, so it is deliberately the narrowest path in this file: the renderer names
 * only the template, the revision it read and the command identity. Main reads the text from its own SQL,
 * derives the sha256, sends the owner command, and records the approval **only** after the worker applied it.
 * The renderer never supplies a subject, a body or a hash, and an edit between the click and the receipt makes
 * the recording fail rather than approve text David did not read. Nothing in this file sends an email.
 */
export function registerTemplateIpc(options: {
  databaseGate: ReplyTemplateDatabaseGate; clock: { now(): string };
  host?: unknown; pairing?: ReplyTemplatePairingStore; isTrustedRendererUrl?: (url: string) => boolean;
}): () => void {
  const removers: (() => void)[] = [];
  const store = <T,>(operation: (repository: SqlReplyTemplateRepository) => T): Promise<T> =>
    options.databaseGate.withDatabase(database => operation(new SqlReplyTemplateRepository({ database, clock: options.clock })));
  const host = options.host as {
    replyTemplate?: (request: ReplyTemplateCommandRequest) => Promise<unknown>;
    configurePolicy?: (request: unknown) => Promise<unknown>;
    googleConnections?: { status(input: { purpose: 'permitted_correspondence' }): Promise<unknown> };
  } | undefined;
  const submit = typeof host?.replyTemplate === 'function'
    ? async (request: ReplyTemplateCommandRequest): Promise<CommandReceipt> => {
      const receipt = commandReceiptSchema.parse(await host.replyTemplate!(Object.freeze(request)));
      if (receipt.commandId !== request.commandId) throw new Error('reply_template_receipt_identity_mismatch');
      return receipt;
    }
    : undefined;
  /** A rejected receipt changes nothing locally: the founder reads the worker's own reason beside unchanged text. */
  const reply = async (receipt: CommandReceipt, record: () => Promise<ReplyTemplateSnapshot>): Promise<ReplyTemplateStatus> =>
    replyTemplateStatusSchema.parse({ snapshot: receipt.status === 'applied' ? await record() : await store(repository => repository.read()), receipt });
  const apply = async (request: Exclude<ReplyTemplateRequest, { kind: 'read' }>): Promise<ReplyTemplateStatus> => {
    if (!submit) throw new Error('reply_template_worker_unavailable');
    if (request.kind === 'pause') {
      const receipt = await submit({ commandId: request.commandId, payload: { kind: 'template-pause', paused: request.paused } });
      return reply(receipt, () => store(repository => repository.recordPaused(request.paused)));
    }
    // Read the text under the revision the renderer read, and derive the hash here: the worker is told the
    // exact bytes this Mac holds, never bytes the renderer chose.
    const template = await store(repository => repository.get(request.templateId));
    if (template.revision !== request.expectedRevision) throw new Error('stale_reply_template');
    if (request.kind === 'revoke') {
      const receipt = await submit({ commandId: request.commandId, payload: { kind: 'template-revoke', templateId: template.id, revision: template.revision } });
      return reply(receipt, () => store(repository => repository.recordRevocation({ templateId: template.id, revision: template.revision })));
    }
    const contentHash = replyTemplateContentHash(template);
    const receipt = await submit({ commandId: request.commandId, payload: { kind: 'template-approve', templateId: template.id,
      revision: template.revision, subject: template.subject, body: template.body, contentHash } });
    return reply(receipt, () => store(repository => repository.recordApproval({ templateId: template.id, revision: template.revision, contentHash })));
  };

  const add = <Q, R>(name: string, requestSchema: z.ZodType<Q> | null, responseSchema: z.ZodType<R>, handler: (request: Q) => Promise<R>) => {
    removers.push(registerValidatedIpc({ channel: `templates:${name}`, requestSchema, responseSchema, handler,
      safeErrorCode: 'TEMPLATE_REQUEST_FAILED', isTrustedRendererUrl: options.isTrustedRendererUrl }));
  };
  try {
    add('read', null, replyTemplateStatusSchema, async () => replyTemplateStatusSchema.parse({ snapshot: await store(repository => repository.read()), receipt: null }));
    add('edit', editReplyTemplateSchema, replyTemplateStatusSchema, async request => {
      const snapshot = await store(repository => repository.edit(request));
      const edited = snapshot.templates.find(template => template.id === request.templateId);
      if (!edited || edited.revision !== request.expectedRevision + 1 || edited.approval.state === 'approved') throw new Error('reply_template_edit_identity_mismatch');
      return replyTemplateStatusSchema.parse({ snapshot, receipt: null });
    });
    if (typeof host?.configurePolicy === 'function' && typeof host.googleConnections?.status === 'function' && options.pairing) {
      const pairing = options.pairing;
      // Sending limits: the `sender-caps` row the worker's dispatch path requires before any send. One explicit
      // click writes it. The renderer never names the sender: it is read from the recorded grant, and the
      // workspace and pairing come from the stored pairing. A ceiling is never permission to send.
      add('sending-limits', sendingLimitsRequestSchema, sendingLimitsStatusSchema, async request => {
        const stored = await pairing.load();
        if (!stored) throw new Error('reply_template_pairing_unconfigured');
        const grantStatus = remoteGoogleGrantStatusSchema.parse(await host.googleConnections!.status({ purpose: 'permitted_correspondence' }));
        const grant = grantStatus.state === 'ready' ? grantStatus.grant : null;
        if (!grant || grant.purpose !== 'permitted_correspondence' || !grant.capabilities.includes('send')) throw new Error('reply_template_grant_unavailable');
        const policy = { sender: grant.email, dailyLimit: REPLY_TEMPLATE_SENDER_DAILY_LIMIT, ramp: SENDER_RAMP_DEFAULT };
        const receipt = workerPolicyReceiptSchema.parse(await host.configurePolicy!(workerPolicyRequestSchema.parse({ version: 1, requestId: request.requestId,
          workspaceId: stored.workspaceId, pairingId: stored.pairingId, mailboxSubject: grant.subject, expectedRevision: request.expectedRevision,
          kind: 'sender-caps', policy })));
        if (receipt.requestId !== request.requestId || receipt.kind !== 'sender-caps') throw new Error('reply_template_policy_receipt_identity_mismatch');
        return sendingLimitsStatusSchema.parse({ ...policy, receipt });
      });
    }
    if (submit) {
      for (const kind of ['approve', 'revoke', 'pause'] as const) {
        add(kind, replyTemplateRequestSchema, replyTemplateStatusSchema, async request => {
          if (request.kind !== kind) throw new Error('reply_template_request_kind_mismatch');
          const status = await apply(request);
          if (status.receipt?.commandId !== request.commandId) throw new Error('reply_template_receipt_identity_mismatch');
          return status;
        });
      }
    }
  } catch (error) { removers.reverse().forEach(remove => remove()); throw error; }
  let disposed = false;
  return () => { if (disposed) return; disposed = true; removers.reverse().forEach(remove => remove()); };
}
