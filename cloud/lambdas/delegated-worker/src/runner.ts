import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SSMClient } from '@aws-sdk/client-ssm';
import { z } from 'zod';
import { withDynamoReadErrors, type DynamoAdapter, type DynamoStore } from './dynamoStore';
import { WorkerAuth } from './workerAuth';
import { RemoteGoogleAuthorization, type RemoteGoogleConfig } from './remoteGoogleAuthorization';
import { claimJob, jobRef, parseJobId, queueMessageSchema, settleJob, type JobRecord, type QueueMessage } from './queue/jobs';
import { attemptCode, recordAttempt } from './v1/attempts';
import { runScheduledDayBuild } from './v1/dayBuild';
import { draftKey, draftRecordSchema, runMailPollJob, type MailDependencies } from './v1/mail';
import { createWorkerGrantMailboxAccess, type MailboxAccess } from './v1/mailbox';
import { runReconcileJob, runSendFollowupJob, runSendStepJob, type SendDependencies } from './v1/send';

/**
 * The runner Lambda (FSS target design sections 1 and 4; slice S3). One job per message, claimed under a lease
 * before any work happens and settled after it: five minutes of budget inside a six-minute function timeout
 * inside a thirty-six-minute queue visibility timeout, so a job can never be delivered again while it is running.
 *
 * The claim is what makes a redelivered message safe: `JOB#<jobId>` admits an absent record, a failed one, or a
 * running one whose lease has expired, and nothing else. A message whose job another runner holds is acknowledged
 * without doing the work twice. A job that fails is settled `failed` and then thrown, so SQS redelivers it up to
 * three times and the dead-letter queue and its alarm take it after that.
 *
 * The work itself lives in the modules the API also uses; this file only decides which one, with what, and settles.
 */

export const RUNNER_BUDGET_MS = 5 * 60_000;

export type RunnerDependencies = { store: DynamoStore; mailbox: MailboxAccess; fetch: typeof globalThis.fetch; budgetMs?: number };
export type RunnerOutcome = { jobId: string; state: 'done' | 'failed' | 'skipped'; reason: string | null };

export const sqsEventSchema = z.object({ Records: z.array(z.object({ messageId: z.string().max(200), body: z.string().max(262144) })).max(1) });

/** The message the queue delivered, or null when it is not one this worker wrote. */
export function parseQueueMessage(body: string): QueueMessage | null {
  let raw: unknown;
  try { raw = JSON.parse(body); } catch { return null; }
  const parsed = queueMessageSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Runs exactly one claimed job. Throws nothing: the caller decides what a failure means to the queue. */
async function execute(deps: RunnerDependencies, message: QueueMessage, signal: AbortSignal): Promise<{ ok: boolean; reason: string | null }> {
  const parsed = parseJobId(message.jobId);
  if (!parsed || parsed.kind !== message.kind) return { ok: false, reason: 'job_id_unrecognised' };
  const send: SendDependencies = { store: deps.store, mailbox: deps.mailbox, fetch: deps.fetch };
  const mail: MailDependencies = send;
  switch (parsed.kind) {
    case 'day.build': {
      const outcome = await runScheduledDayBuild(deps.store);
      return outcome.outcome === 'failed' ? { ok: false, reason: outcome.errorClass } : { ok: true, reason: outcome.outcome };
    }
    case 'mail.poll': {
      const report = await runMailPollJob(mail, { jobId: message.jobId }, signal);
      return { ok: true, reason: report.held };
    }
    case 'mail.reconcile': {
      const report = await runReconcileJob(send, signal);
      return { ok: true, reason: report.stillUnknown > 0 ? 'send_unknown' : null };
    }
    case 'mail.send_step': {
      const outcome = await runSendStepJob(send, { jobId: message.jobId, firmId: parsed.firmId, stepId: parsed.stepId }, signal);
      return { ok: outcome.outcome !== 'refused', reason: 'code' in outcome ? outcome.code : outcome.outcome };
    }
    case 'mail.send_followup': {
      const row = await deps.store.get<unknown>(draftKey(parsed.firmId, parsed.draftId));
      const draft = row ? draftRecordSchema.safeParse(row.data) : null;
      if (!draft?.success) return { ok: false, reason: 'draft_unknown' };
      if (draft.data.status === 'sent') return { ok: true, reason: 'already_sent' };
      if (draft.data.status !== 'approved' || draft.data.text === null) return { ok: true, reason: 'draft_not_approved' };
      const outcome = await runSendFollowupJob(send, { jobId: message.jobId, draft: { firmId: draft.data.firmId, draftId: draft.data.draftId,
        to: draft.data.to, subject: draft.data.subject, text: draft.data.text, inReplyTo: draft.data.inReplyTo, threadId: draft.data.threadId } }, signal);
      if (outcome.outcome === 'sent' || outcome.outcome === 'already_accepted') {
        const current = await deps.store.get<unknown>(draftKey(parsed.firmId, parsed.draftId));
        const held = current ? draftRecordSchema.safeParse(current.data) : null;
        if (held?.success && held.data.status !== 'sent') {
          await deps.store.transact([deps.store.put(draftKey(parsed.firmId, parsed.draftId),
            draftRecordSchema.parse({ ...held.data, status: 'sent', updatedAt: deps.store.now() }), current!.rev)]);
        }
      }
      return { ok: outcome.outcome !== 'refused', reason: 'code' in outcome ? outcome.code : outcome.outcome };
    }
    // S4 puts research on the queue. Until it does, the scheduler never enqueues one, and a message that names one
    // is refused honestly rather than quietly acknowledged as done.
    case 'research.firm':
    case 'research.backfill_page':
      return { ok: false, reason: 'job_kind_not_ready' };
  }
}

/**
 * One SQS message. Claims the job, runs it inside the budget, settles the claim. A refused claim is not an error:
 * another runner holds it, or it is already done.
 */
export async function runQueuedJob(deps: RunnerDependencies, body: string): Promise<RunnerOutcome> {
  const started = Date.now();
  const message = parseQueueMessage(body);
  if (!message) return { jobId: '', state: 'skipped', reason: 'message_unrecognised' };
  const claim = await claimJob(deps.store, { jobId: message.jobId, kind: message.kind });
  if (!claim.claimed) return { jobId: message.jobId, state: 'skipped', reason: claim.reason };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.budgetMs ?? RUNNER_BUDGET_MS);
  let result: { ok: boolean; reason: string | null };
  try { result = await execute(deps, message, controller.signal); }
  catch (error) { result = { ok: false, reason: attemptCode(error instanceof Error ? error.constructor?.name ?? error.name : 'unknown') }; }
  finally { clearTimeout(timer); controller.abort(); }
  const record: JobRecord = claim.record;
  await settleJob(deps.store, { jobId: message.jobId, rev: claim.rev, record, state: result.ok ? 'done' : 'failed', error: result.reason });
  await recordAttempt(deps.store, { kind: 'tick_phase', outcome: result.ok ? 'ok' : 'failed', reason: result.reason,
    detail: { code: attemptCode(message.kind), jobId: jobRef(message.jobId) }, durationMs: Date.now() - started, ref: jobRef(message.jobId) });
  return { jobId: message.jobId, state: result.ok ? 'done' : 'failed', reason: result.reason };
}

/**
 * The production runner: the table, the Google parameters through SSM (which is the only reason it has a KMS
 * grant) and the mailbox. It holds no HTTP route and answers no request.
 */
export function createRunnerHandler(env: NodeJS.ProcessEnv, boundaries: { dynamo?: DynamoAdapter; fetch?: typeof globalThis.fetch; mailbox?: MailboxAccess } = {}) {
  return async (event: unknown): Promise<RunnerOutcome[]> => {
    if (env.DELEGATED_WORKER_ENABLED !== 'true') return [];
    const config = z.object({ DELEGATED_WORKER_TABLE: z.string().min(1), DELEGATED_WORKSPACE_ID: z.string().min(1), AWS_REGION: z.string().min(1) }).parse(env);
    const parsed = sqsEventSchema.safeParse(event);
    if (!parsed.success) throw new Error('runner_event_invalid');
    const dynamo = withDynamoReadErrors(boundaries.dynamo ?? new DynamoDBClient({ region: config.AWS_REGION, maxAttempts: 1 }));
    const auth = new WorkerAuth({ dynamo, tableName: config.DELEGATED_WORKER_TABLE, workspaceId: config.DELEGATED_WORKSPACE_ID,
      clock: { now: () => new Date().toISOString() } });
    const fetch = boundaries.fetch ?? globalThis.fetch;
    const mailbox = boundaries.mailbox ?? createWorkerGrantMailboxAccess({ store: auth.store,
      authorization: new RemoteGoogleAuthorization({ auth, config: await googleConfig(env, config), fetch }) });
    const outcomes: RunnerOutcome[] = [];
    for (const record of parsed.data.Records) outcomes.push(await runQueuedJob({ store: auth.store, mailbox, fetch }, record.body));
    // A failed job must be redelivered: the queue's own retry, then the dead-letter queue and its alarm.
    if (outcomes.some(outcome => outcome.state === 'failed')) throw new Error('runner_job_failed');
    return outcomes;
  };
}

/** The Google client configuration the runner needs to refresh the mailbox token. Absent leaves the mailbox unconnected. */
async function googleConfig(env: NodeJS.ProcessEnv, config: { DELEGATED_WORKSPACE_ID: string; AWS_REGION: string }): Promise<RemoteGoogleConfig | undefined> {
  const vars = [env.DELEGATED_GOOGLE_CLIENT_ID, env.DELEGATED_GOOGLE_SECRET_PARAMETER, env.DELEGATED_GOOGLE_KEY_PARAMETER];
  if (!vars.every(Boolean)) return undefined;
  const { GetParameterCommand } = await import('@aws-sdk/client-ssm');
  const ssm = new SSMClient({ region: config.AWS_REGION, maxAttempts: 1 });
  const load = async (Name: string): Promise<string> => {
    const result = await ssm.send(new GetParameterCommand({ Name, WithDecryption: true }));
    if (result.Parameter?.Type !== 'SecureString' || !result.Parameter.Value) throw new Error('google_unconfigured');
    return result.Parameter.Value;
  };
  const [clientSecret, encodedKey] = await Promise.all([load(env.DELEGATED_GOOGLE_SECRET_PARAMETER!), load(env.DELEGATED_GOOGLE_KEY_PARAMETER!)]);
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encodedKey)) throw new Error('google_unconfigured');
  return { clientId: env.DELEGATED_GOOGLE_CLIENT_ID!, clientSecret, encryptionKey: Buffer.from(encodedKey, 'base64'),
    redirectUri: `https://${env.DELEGATED_WORKER_HOST ?? 'worker.invalid'}/oauth/callback` };
}

export const handler = async (event: unknown): Promise<RunnerOutcome[]> => createRunnerHandler(process.env)(event);
