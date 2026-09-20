import type { RepositoryContext } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { accept, refuse, type RetentionResult } from './result.ts';

/**
 * Attachment metadata and the authorized open-in-Gmail link (10.3, Appendix F, 5.2).
 *
 * > Attachments are not copied into FSS. FSS stores filename, media type, size,
 * > content hash when available, Gmail message reference, and authorization
 * > metadata. Authorized users open the original Gmail message to retrieve the file.
 *
 * The file never enters this system. What this module returns is a description of
 * something in Gmail and a URL that opens it there, so the authorization it performs
 * is the *only* control on who learns that the file exists and what it is called —
 * Gmail's own authorization then decides whether the person can open it. Both checks
 * matter and neither substitutes for the other: FSS must not tell an unassigned
 * salesperson that a firm sent a file called `2026-term-sheet.pdf`.
 *
 * Appendix F puts "message bodies, notes, callbacks, FSS drafts" in the assigned
 * salesperson's and admin's class, and an attachment's filename is message content.
 * The mailbox owner is added because the message is in their mailbox and Appendix F
 * gives them their own mailbox's material unconditionally.
 *
 * An admin read is audited (5.2: "Admin reads of message bodies, drafts, mailbox
 * diagnostics, and exports create access audit events"). The audit event names the
 * message and never the filename: an audit record that quoted the thing it was
 * recording access to would be a second copy of it.
 */

export type AttachmentRefusal = 'message_unknown' | 'not_authorized';

export interface AttachmentReference {
  readonly filename: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  /** Gmail supplies one only sometimes; null rather than a guess. */
  readonly contentHash: string | null;
  /** Gmail's own attachment id. A reference into Gmail, never a key to bytes here. */
  readonly gmailAttachmentId: string;
}

export interface AttachmentView {
  readonly mailMessageId: string;
  readonly providerMessageId: string;
  readonly attachments: readonly AttachmentReference[];
  /** Opens the original message in the mailbox it arrived in. */
  readonly openInGmailUrl: string;
}

interface StoredReference {
  readonly filename?: unknown;
  readonly mimeType?: unknown;
  readonly sizeBytes?: unknown;
  readonly contentHash?: unknown;
  readonly attachmentId?: unknown;
}

/**
 * The permalink Gmail opens a message at.
 *
 * `authuser` names the account rather than an index, because a person signed into
 * several Google accounts in one browser opens `u/0` as whichever they signed into
 * first — which for a shared Mac is how one salesperson's link opens in another's
 * mailbox and fails with a permission error they cannot explain. The address is
 * public identity, not a credential.
 */
export function gmailMessageUrl(mailboxAddress: string, providerMessageId: string): string {
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(mailboxAddress)}#all/${providerMessageId}`;
}

function toReference(stored: StoredReference): AttachmentReference {
  return {
    filename: typeof stored.filename === 'string' ? stored.filename : '',
    mediaType: typeof stored.mimeType === 'string' ? stored.mimeType : 'application/octet-stream',
    sizeBytes: typeof stored.sizeBytes === 'number' ? stored.sizeBytes : 0,
    contentHash: typeof stored.contentHash === 'string' ? stored.contentHash : null,
    gmailAttachmentId: typeof stored.attachmentId === 'string' ? stored.attachmentId : '',
  };
}

export async function readAttachmentReferences(
  context: RepositoryContext,
  input: { readonly mailMessageId: string },
): Promise<RetentionResult<AttachmentView, AttachmentRefusal>> {
  const { rows } = await context.db.query<{
    id: string;
    provider_message_id: string;
    attachment_references: readonly StoredReference[];
    mailbox_address: string;
    owner_user_id: string;
    assignees: readonly (string | null)[];
  }>(
    `SELECT m.id, m.provider_message_id, m.attachment_references, b.email_address AS mailbox_address,
            b.owner_user_id,
            COALESCE(
              (SELECT array_agg(DISTINCT f.assigned_user_id)
                 FROM mail_message_matches x
                 JOIN firms f ON f.workspace_id = x.workspace_id AND f.id = x.firm_id
                WHERE x.workspace_id = m.workspace_id AND x.mail_message_id = m.id),
              ARRAY[]::uuid[]
            ) AS assignees
       FROM mail_messages m
       JOIN mailboxes b ON b.workspace_id = m.workspace_id AND b.id = m.mailbox_id
      WHERE m.workspace_id = $1 AND m.id = $2`,
    [context.scope.workspaceId, input.mailMessageId],
  );
  const row = rows[0];
  if (row === undefined) return refuse('message_unknown');

  const actor = context.scope.actor;
  const isAdmin = actor.kind === 'user' && actor.role === 'admin';
  const userId = actor.kind === 'user' ? actor.userId : null;
  const isMailboxOwner = userId !== null && row.owner_user_id === userId;
  const isAssignee = userId !== null && row.assignees.some(assignee => assignee === userId);
  // The system reads nothing here: this is a person opening a link.
  if (!isAdmin && !isMailboxOwner && !isAssignee) return refuse('not_authorized');

  if (isAdmin && !isMailboxOwner) {
    await recordCrmAuditEvent(context, {
      action: 'attachment.viewed',
      subjectKind: 'mail_message',
      subjectId: row.id,
      detail: { attachments: row.attachment_references.length },
    });
  }

  return accept({
    mailMessageId: row.id,
    providerMessageId: row.provider_message_id,
    attachments: row.attachment_references.map(toReference),
    openInGmailUrl: gmailMessageUrl(row.mailbox_address, row.provider_message_id),
  });
}
