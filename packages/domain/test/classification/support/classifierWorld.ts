import { readFileSync } from 'node:fs';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../../db/workspaceScope.ts';
import { promoteReply } from '../../../today/promotions.ts';
import { runMailRecovery } from '../../../mail/recover.ts';
import { type ReplyPromoter } from '../../../mail/replyLane.ts';
import { anthropicReplyClassifier, type ReplyClassifierPort } from '../../../classification/adapter.ts';
import { type ClassifyReplyDeps } from '../../../classification/classify.ts';
import {
  recordedAnthropicTransport,
  type RecordedAnswer,
  type RecordedAnthropicTransport,
} from '../../../classification/recorded.ts';
import { type ClassifierSettings } from '../../../classification/types.ts';
import {
  createMailWorld,
  fixtureMessage,
  type MailWorld,
  type MailWorldMailbox,
} from '../../mail/support/mailWorld.ts';
import { ALIAS_ADDRESS, REPLY_CORPUS, type CorpusCase } from '../../corpus/replies/cases.ts';

/**
 * The corpus harness: a real PostgreSQL, a real Gmail fixture, the real mail
 * pipeline, the real adapter, and a recorded transport in place of the provider
 * (specification 16.1).
 *
 * Nothing here is a second implementation of anything. The messages go through
 * `runMailRecovery`, so their deterministic classification and every effect it has
 * are the ones production writes; the model call goes through
 * `anthropicReplyClassifier`, so the request the fixture answers is the request the
 * provider would have been sent. The only substitution is the socket.
 *
 * The reply promoter is G6's real `promoteReply` rather than the mail tests'
 * recording fake, because the reply card list reads `today_items` and a fake would
 * make that read untestable.
 */

interface RecordedFile {
  readonly promptVersion: string;
  readonly model: string;
  readonly answers: Readonly<Record<string, RecordedAnswer>>;
}

const RECORDED: RecordedFile = JSON.parse(
  readFileSync(new URL('../../corpus/replies/recorded.json', import.meta.url), 'utf8'),
) as RecordedFile;

export const RECORDED_PROMPT_VERSION = RECORDED.promptVersion;
export const RECORDED_MODEL = RECORDED.model;

export interface ClassifierWorld {
  readonly mail: MailWorld;
  readonly transport: RecordedAnthropicTransport;
  readonly deps: ClassifyReplyDeps;
  /** The message row id for each corpus case, in the alpha workspace. */
  readonly messageIds: ReadonlyMap<string, string>;
  context(): RepositoryContext;
  adminContext(): RepositoryContext;
  systemContext(): RepositoryContext;
  messageIdOf(caseId: string): string;
  stop(): Promise<void>;
}

/** The today-list promoter the classification lane needs: G6's, unwrapped. */
function todayPromoter(): ReplyPromoter {
  return {
    promoteReply: async (context, promotion) => {
      await promoteReply(context, {
        firmId: promotion.firmId,
        ...(promotion.contactId === undefined ? {} : { contactId: promotion.contactId }),
        messageId: promotion.messageId,
        receivedAt: promotion.receivedAt,
      });
    },
  };
}

/**
 * Which corpus case a request is about.
 *
 * The request carries the authored body inside its fence, so the case is the one
 * whose body the volatile turn contains. Deliberately not a hash of the request:
 * a key that changed when the prompt changed would make every re-prompt a corpus
 * re-record, and the corpus is about the messages, not about the wording we send.
 */
function keyForRequest(content: string): string {
  for (const corpusCase of REPLY_CORPUS) {
    if (content.includes(corpusCase.body)) return corpusCase.id;
  }
  return 'unknown-case';
}

export function corpusMessage(corpusCase: CorpusCase, index: number) {
  return fixtureMessage({
    id: `msg-${corpusCase.id}`,
    // `threadId` names another case; the fixture's own thread is `thread-msg-<id>`.
    ...(corpusCase.threadId === undefined ? {} : { threadId: `thread-msg-${corpusCase.threadId}` }),
    historyId: String(2000 + index),
    from: corpusCase.from,
    to: 'sales.alpha@example.test',
    subject: corpusCase.subject,
    body: corpusCase.body,
    ...(corpusCase.truncated === undefined ? {} : { bodyTruncated: corpusCase.truncated }),
    ...(corpusCase.autoSubmitted === undefined ? {} : { autoSubmitted: corpusCase.autoSubmitted }),
    ...(corpusCase.listId === undefined ? {} : { listId: corpusCase.listId }),
    internalDateEpochMilliseconds: Date.parse('2026-09-10T14:00:00Z') + index * 60_000,
  });
}

export interface ClassifierWorldOptions {
  /** Which corpus cases to ingest. All of them by default. */
  readonly cases?: readonly CorpusCase[] | undefined;
  readonly settings?: Partial<ClassifierSettings> | undefined;
  readonly processEnabled?: boolean | undefined;
}

export async function createClassifierWorld(
  options: ClassifierWorldOptions = {},
): Promise<ClassifierWorld> {
  const cases = options.cases ?? REPLY_CORPUS;
  const mail = await createMailWorld({ alphaMessages: cases.map(corpusMessage) });

  // A second route on the same contact, so the alias case matches (12.3).
  await mail.database.session.query(
    `INSERT INTO email_addresses (workspace_id, firm_id, contact_id, address, source, retrieved_at,
                                  association_confidence, technical_validation, eligibility,
                                  eligibility_policy_version)
     VALUES ($1, $2, $3, $4, 'research_provider', TIMESTAMPTZ '2026-09-01 12:00:00+00',
             0.900, 'passed', 'usable', 'route-policy.1')`,
    [mail.seeded.alpha.workspaceId, mail.crm.alpha.firmId, mail.crm.alpha.contactId, ALIAS_ADDRESS],
  );

  const system = mail.systemContext(mail.seeded.alpha.workspaceId);
  const recovery = await runMailRecovery(
    system,
    mail.syncDeps(mail.alpha as MailWorldMailbox, { replyPromoter: todayPromoter() }),
    { mailboxId: mail.alpha.mailboxId, generation: 1 },
  );
  if (recovery.outcome !== 'completed') {
    throw new Error(`the corpus baseline did not complete: ${recovery.outcome}`);
  }

  const messageIds = new Map<string, string>();
  for (const corpusCase of cases) {
    const { rows } = await mail.database.session.query<{ id: string }>(
      'SELECT id FROM mail_messages WHERE workspace_id = $1 AND provider_message_id = $2',
      [mail.seeded.alpha.workspaceId, `msg-${corpusCase.id}`],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error(`the corpus message ${corpusCase.id} was not recorded`);
    messageIds.set(corpusCase.id, id);
  }

  const transport = recordedAnthropicTransport({
    answers: new Map(Object.entries(RECORDED.answers)),
    keyOf: request => keyForRequest(request.messages.map(message => message.content).join('\n')),
  });

  const classifierFor = (settings: ClassifierSettings): ReplyClassifierPort =>
    anthropicReplyClassifier({
      transport,
      model: settings.modelName,
      effort: settings.effort,
      maxOutputTokens: settings.maxOutputTokens,
    });

  if (options.settings !== undefined) {
    const settings = options.settings;
    await mail.database.session.query(
      `INSERT INTO classifier_settings (workspace_id, enabled, model_name, effort, max_output_tokens,
                                        daily_call_cap)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        mail.seeded.alpha.workspaceId,
        settings.enabled ?? true,
        settings.modelName ?? 'claude-opus-5',
        settings.effort ?? 'low',
        settings.maxOutputTokens ?? 512,
        settings.dailyCallCap ?? 500,
      ],
    );
  }

  return {
    mail,
    transport,
    deps: {
      classifierFor,
      ...(options.processEnabled === undefined ? {} : { processEnabled: options.processEnabled }),
    },
    messageIds,
    context: () => mail.userContext(mail.seeded.alpha.workspaceId),
    adminContext: () =>
      repositoryContext(
        workspaceScope(mail.seeded.alpha.workspaceId, {
          kind: 'user',
          userId: mail.seeded.alpha.admin.userId,
          role: 'admin',
        }),
        mail.database.session,
      ),
    systemContext: () => mail.systemContext(mail.seeded.alpha.workspaceId),
    messageIdOf: (caseId: string) => {
      const id = messageIds.get(caseId);
      if (id === undefined) throw new Error(`the corpus has no case ${caseId}`);
      return id;
    },
    stop: async () => {
      await mail.stop();
    },
  };
}
