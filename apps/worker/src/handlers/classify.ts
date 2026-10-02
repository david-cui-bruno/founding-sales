import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { anthropicReplyClassifier, type ReplyClassifierPort } from '@fss/domain/classification/adapter.ts';
import {
  environmentClassifierSecrets,
  loadAnthropicTransport,
  type AnthropicMessagesTransport,
} from '@fss/domain/classification/anthropicClient.ts';
import { loadBedrockTransport } from '@fss/domain/classification/bedrockClient.ts';
import { classifyReplyHandler, type ClassifyHandlerOptions } from '@fss/domain/classification/handler.ts';
import { MODEL_TRANSPORT_VARIABLE, bedrockModelRoute, readModelTransport } from '@fss/domain/classification/modelTransport.ts';
import { routeOfTransport, routedTransport } from '@fss/domain/classification/routedTransport.ts';
import { listPendingModelClassifications } from '@fss/domain/classification/store.ts';
import type { ClassifierSettings } from '@fss/domain/classification/types.ts';
import type { JobHandler } from '@fss/domain/jobs/handlerRegistry.ts';
import { jobIdempotencyKey } from '@fss/domain/jobs/jobKinds.ts';
import type { JobSpecification } from '@fss/domain/jobs/jobStore.ts';
import type { DueWorkSource } from '../scheduler/schedulerPass.ts';

/**
 * The `classify.reply` handler and its due-work source (12.4, 13.1).
 *
 * The body is in `@fss/domain/classification`, for the reason G4's finalizer and
 * G7's mail handlers keep theirs there: everything it touches
 * is domain code, and the at-least-once harness registers it without importing the
 * worker. What this file owns is the composition — which adapter this deployment was
 * given, and therefore whether it claims the kind at all.
 *
 * ## A worker with no API key registers nothing
 *
 * Exactly as `mailHandlers(undefined)` does.
 * A deployment that has not been handed `FSS_LLM_CLASSIFIER_API_KEY` leaves
 * `classify.reply` unclaimed in the queue rather than failing it twice per message
 * and producing a dead job for every reply. The queue is durable; the reply is
 * already on the card and already holding the firm, so the work waiting costs
 * nobody anything but a missing suggestion.
 *
 * `FSS_CLASSIFIER=off` is the other switch, and it is deliberately not the same one.
 * "No key" is a deployment that cannot call the provider; "off" is an operator who
 * has decided not to. With `off` the handler *is* registered and each job completes
 * having sent nothing and recorded a `disabled` attempt, so the queue drains and the
 * dashboard shows why. With no key nothing is claimed at all.
 *
 * ## The source is a sweep, not a hook
 *
 * Appendix A's "Record uncertain or ambiguous reply" row says the classification
 * "may be queued" after the commit — after, because the mail lane's transaction has
 * already done everything that matters and the model is an opinion that can arrive a
 * minute later. The mail pipeline therefore enqueues nothing and knows nothing about
 * this lane; the one-minute scheduler finds the messages whose second opinion is
 * owed and materializes a job each.
 *
 * That is also what makes the queue self-healing after an outage: a classifier that
 * was switched off for a day has a backlog the sweep works through, bounded by the
 * page size and by the workspace's daily cap.
 */

export interface ClassifyWorkerOptions {
  readonly transport: AnthropicMessagesTransport;
  /** False when `FSS_CLASSIFIER=off`. The handler still runs and records `disabled`. */
  readonly processEnabled: boolean;
  readonly maxAttempts?: number | undefined;
  readonly leaseSeconds?: number | undefined;
  /** The worker's logger, for what the API said about a refused request. */
  readonly log?: ClassifyHandlerOptions['log'];
}

export function classifyHandlers(options: ClassifyWorkerOptions | undefined): readonly JobHandler[] {
  if (options === undefined) return [];
  const classifierFor = (settings: ClassifierSettings): ReplyClassifierPort =>
    anthropicReplyClassifier({
      transport: options.transport,
      model: settings.modelName,
      effort: settings.effort,
      maxOutputTokens: settings.maxOutputTokens,
    });
  return [
    classifyReplyHandler(
      { classifierFor, processEnabled: options.processEnabled, route: routeOfTransport(options.transport) },
      {
        ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
        ...(options.leaseSeconds === undefined ? {} : { leaseSeconds: options.leaseSeconds }),
        ...(options.log === undefined ? {} : { log: options.log }),
      },
    ),
  ];
}

/** The transport loaders, injectable so a test can prove which one a configuration builds. */
export interface TransportLoaders {
  readonly anthropic: typeof loadAnthropicTransport;
  readonly bedrock: typeof loadBedrockTransport;
}

const LIVE_LOADERS: TransportLoaders = { anthropic: loadAnthropicTransport, bedrock: loadBedrockTransport };

/**
 * Which model transport this deployment builds, or why none (slice BR1).
 *
 * `FSS_MODEL_TRANSPORT=bedrock` builds the Bedrock transport from `AWS_REGION` and the task
 * role, and routes by model (review BR1R, finding 1): a model Bedrock can serve for this
 * account (`BEDROCK_MODEL_TABLE`) goes to Bedrock, any other to the direct API with the
 * classifier key when the deployment holds one — the path it had before, cash — and with no
 * key it has no route. The route is per model and fixed, never a fallback after a failure.
 * Unset or `anthropic` is the direct API for every model, and needs the key, as before. Any
 * other value builds nothing.
 */
export async function readModelTransportComposition(
  environment: Readonly<Record<string, string | undefined>>,
  loaders: TransportLoaders = LIVE_LOADERS,
  log?: ClassifyHandlerOptions['log'],
): Promise<{ readonly transport: AnthropicMessagesTransport | null; readonly problem: string | null }> {
  const problem = modelTransportProblem(environment);
  if (problem !== null) return { transport: null, problem };
  if (readModelTransport(environment).kind === 'bedrock') {
    const secrets = environmentClassifierSecrets(environment);
    const anthropic = secrets.names().length === 0 ? null : await loaders.anthropic({ secrets });
    const bedrock = await loaders.bedrock({ region: (environment['AWS_REGION'] ?? '').trim() });
    return {
      transport: routedTransport({
        route: bedrockModelRoute({ directAvailable: anthropic !== null }),
        bedrock,
        anthropic,
        // The model id and the transport, nothing else.
        onRoute: (model, transport) => log?.('model_route', { model: model.slice(0, 64), transport }),
      }),
      problem: null,
    };
  }
  return { transport: await loaders.anthropic({ secrets: environmentClassifierSecrets(environment) }), problem: null };
}

/**
 * Why this deployment builds no model transport, by variable name only, or null when it
 * builds one: `FSS_MODEL_TRANSPORT` (not a transport), `AWS_REGION` (Bedrock chosen with no
 * region) or `anthropic:absent` (the direct API chosen with no key). For the startup line.
 */
export function modelTransportProblem(environment: Readonly<Record<string, string | undefined>>): string | null {
  const selected = readModelTransport(environment);
  if (selected.kind === null) return MODEL_TRANSPORT_VARIABLE;
  if (selected.kind === 'bedrock') return (environment['AWS_REGION'] ?? '').trim() === '' ? 'AWS_REGION' : null;
  return environmentClassifierSecrets(environment).names().length === 0 ? 'anthropic:absent' : null;
}

/**
 * Read the deployment's classifier configuration, or nothing.
 *
 * The key never becomes a value this function returns: `loadAnthropicTransport`
 * hands it to the SDK client's constructor and the closure holds a client. Nothing
 * here can be logged, serialized or put in an error body, which is the same rule
 * `MailWorkerOptions` follows for the Gmail client secret. The Bedrock transport holds
 * no secret at all: its credential is the task role.
 */
export async function classifyWorkerOptions(
  environment: Readonly<Record<string, string | undefined>>,
  log?: ClassifyHandlerOptions['log'],
  loaders: TransportLoaders = LIVE_LOADERS,
): Promise<ClassifyWorkerOptions | undefined> {
  const composed = await readModelTransportComposition(environment, loaders, log);
  if (composed.transport === null) return undefined;
  return {
    transport: composed.transport,
    processEnabled: (environment['FSS_CLASSIFIER'] ?? 'on').trim().toLowerCase() !== 'off',
    ...(log === undefined ? {} : { log }),
  };
}

/** The startup line. Says whether the classifier is configured, never with what. */
export function describeClassifier(options: ClassifyWorkerOptions | undefined): {
  readonly classifier_configured: boolean;
  readonly classifier_enabled: boolean;
  readonly model_transport?: string;
} {
  return {
    classifier_configured: options !== undefined,
    classifier_enabled: options?.processEnabled ?? false,
    // Which transport the model calls go through (slice BR1); never a key.
    ...(options === undefined ? {} : { model_transport: options.transport.kind ?? 'anthropic' }),
  };
}

/** How many replies one scheduler pass materializes a job for. */
export const CLASSIFY_SWEEP_LIMIT = 50;

/**
 * The due-work source: one `classify.reply` per message whose model layer is owed.
 *
 * `enqueueJob`'s `UNIQUE(workspace_id, kind, idempotency_key)` is what makes a
 * second pass over the same backlog insert nothing, and the key carries the message
 * rather than an instant so that is true for ever rather than for a minute.
 *
 * A finished job is *not* re-armed. `classify-reply:{message}` is done once and the
 * model row is there; a sweep that revived it would spend money re-asking a question
 * that has an answer. That is the opposite of the mail sources, which deliberately
 * re-arm — and the difference is that a mail sync's work is never finished while the
 * mailbox lives, and a classification's is finished the moment it has a row.
 */
export function classifyReplySource(limit: number = CLASSIFY_SWEEP_LIMIT): DueWorkSource {
  return {
    name: 'classify-reply',
    find: async (session: SessionQueryable): Promise<readonly JobSpecification[]> => {
      const pending = await listPendingModelClassifications(session, limit);
      return pending.map(row => ({
        workspaceId: row.workspaceId,
        kind: 'classify.reply',
        idempotencyKey: jobIdempotencyKey.classifyReply(row.messageId, row.resume),
        payload: { messageId: row.messageId },
        maxAttempts: 2,
      }));
    },
  };
}

/** The kinds a fully configured classifier worker claims. Read by the startup log. */
export const CLASSIFY_JOB_KINDS: readonly string[] = Object.freeze(['classify.reply']);
