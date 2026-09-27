import {
  DIAL_IPC_CHANNELS,
  OPERATIONS,
  OPERATION_IPC_CHANNELS,
  OPERATION_NAMES,
  operationOf,
  type OperationName,
} from '../shared/operations.ts';
import type { AuthedClient } from './authedClient.ts';
import type { ReplyBridgeHost } from './replyBridge.ts';
import type { TodayBridgeHost } from './todayBridge.ts';

/**
 * The main-process half of the operation registry (D4; specification 14.2).
 *
 * Two channels answer every operation the converted views can name, and each answer goes
 * through the same three steps: look the operation up in the closed list, parse the input
 * with that operation's schema, and parse what comes back with its output schema. A
 * renderer that asked for something outside the list, or with a shape outside it, never
 * reaches a handler at all.
 *
 * The transformations are not written here. Today's stale expansion and refusal eviction
 * are `todayBridge.ts`'s, the wall-clock callback resolved against the business zone is
 * `replyBridge.ts`'s, and both keep the in-memory state a view's next read depends on.
 * What this file does is say which operation is answered by which of them, once, in a
 * table a test walks — so an operation with no handler and a handler with no operation
 * are both a failing test rather than a channel that answers `undefined`.
 *
 * **Parsing on both sides is not paranoia about our own code.** It is what makes the
 * renderer's type a guarantee rather than a hope, and it means a state that grew a field
 * it should not have — a token, a `tel:` URI, a message body on a Today card — fails at
 * the boundary instead of reaching the page.
 */

export interface OperationHostDeps {
  readonly api: AuthedClient;
  readonly today: TodayBridgeHost;
  readonly replies: ReplyBridgeHost;
}

type Handler = (input: never) => Promise<unknown>;

/**
 * A malformed input is the view's current state back, not an argument passed on to the
 * API — the rule every hand-written channel followed before the registry existed. The
 * diagnostics operations have no such state, so their refusal is a rejected call the
 * form shows where the answer would have been.
 */
const FALLBACK: Readonly<Record<string, OperationName>> = Object.freeze({
  today: 'today.state',
  replies: 'replies.state',
});

export function operationHandlers(deps: OperationHostDeps): Readonly<Record<OperationName, Handler>> {
  const handlers = {
    'today.state': async () => await deps.today.state(),
    'today.refresh': async (input: { readonly quiet?: boolean }) =>
      await deps.today.refresh({ quiet: input.quiet === true }),
    'today.expand': async (input: { readonly firmId: string }) => await deps.today.expand(input),
    'today.collapse': async () => await deps.today.collapse(),
    'today.snooze': async (input: Parameters<TodayBridgeHost['snooze']>[0]) => await deps.today.snooze(input),
    'today.recordOutcome': async (input: Parameters<TodayBridgeHost['recordOutcome']>[0]) =>
      await deps.today.recordOutcome(input),
    'today.scheduleCallback': async (input: Parameters<TodayBridgeHost['scheduleCallback']>[0]) =>
      await deps.today.scheduleCallback(input),
    'today.releasePause': async (input: Parameters<TodayBridgeHost['releasePause']>[0]) =>
      await deps.today.releasePause(input),

    'replies.state': async () => await deps.replies.state(),
    'replies.refresh': async () => await deps.replies.refresh(),
    'replies.open': async (input: { readonly messageId: string }) => await deps.replies.open(input),
    'replies.collapse': async () => await deps.replies.collapse(),
    'replies.forget': async () => await deps.replies.forget(),
    'replies.confirm': async (input: Parameters<ReplyBridgeHost['confirm']>[0]) => await deps.replies.confirm(input),
    'replies.resolve': async (input: Parameters<ReplyBridgeHost['resolve']>[0]) => await deps.replies.resolve(input),

    // Settings › Diagnostics. Straight through the authenticated client: there is no
    // state to keep and nothing to transform, and the recovery forms read the answer.
    'diagnostics.sendStatus': async (input: { readonly outboundMessageId: string }) => {
      const answer = await deps.api.read('/outbound/status', value => value, input);
      if (!answer.ok) throw new Error(answer.reason);
      return { fence: (answer.value as { fence?: unknown }).fence ?? null };
    },
    'diagnostics.resolveSend': async (input: { readonly outboundMessageId: string; readonly resolution: string }) => {
      const answer = await deps.api.command('/outbound/resolve', input, value => value);
      if (!answer.ok) throw new Error(answer.reason);
      return answer.value;
    },
    'diagnostics.deadJobs': async () => {
      const answer = await deps.api.read('/admin/jobs/dead', value => value);
      if (!answer.ok) throw new Error(answer.reason);
      return answer.value;
    },
    'diagnostics.requeueJob': async (input: { readonly jobId: string; readonly reason: string }) => {
      // Its own parser: this route predates the accepted envelope and answers a plain
      // body, which `AuthedClient.command` would read as a refusal.
      const answer = await deps.api.read('/admin/jobs/requeue', value => value, input);
      if (!answer.ok) throw new Error(answer.reason);
      return answer.value;
    },
  } satisfies Readonly<Record<OperationName, (input: never) => Promise<unknown>>>;
  return handlers as Readonly<Record<OperationName, Handler>>;
}

/** Answer one operation: the closed list, then its input schema, then its output schema. */
export async function answerOperation(
  handlers: Readonly<Record<OperationName, Handler>>,
  kind: 'read' | 'command',
  name: unknown,
  input: unknown,
): Promise<unknown> {
  const operation = operationOf(name);
  if (operation === null) throw new Error('no such operation');
  const declared = OPERATIONS[operation];
  if (declared.kind !== kind) throw new Error(`${operation} is a ${declared.kind}, not a ${kind}`);

  const parsed = declared.input.safeParse(input ?? {});
  if (!parsed.success) {
    const fallback = FALLBACK[operation.slice(0, operation.indexOf('.'))];
    if (fallback === undefined) throw new Error(`${operation} was asked for with a shape it does not accept`);
    return declared.output.parse(await handlers[fallback](undefined as never));
  }
  return declared.output.parse(await handlers[operation](parsed.data as never));
}

export interface OperationRegistration {
  readonly handlers: Readonly<Record<OperationName, Handler>>;
  readonly channels: readonly string[];
}

/**
 * Register the two channels. `handle` is passed in rather than `ipcMain` being imported,
 * for the reason every other module in this directory gives: importing Electron outside
 * the app downloads its binary in the middle of `vitest`.
 */
export function registerOperations(
  deps: OperationHostDeps,
  handle: (channel: string, listener: (argument: unknown) => Promise<unknown>) => void,
): OperationRegistration {
  const handlers = operationHandlers(deps);
  handle(OPERATION_IPC_CHANNELS.read, async argument => {
    const request = argument as { operation?: unknown; input?: unknown } | null;
    return await answerOperation(handlers, 'read', request?.operation, request?.input);
  });
  handle(OPERATION_IPC_CHANNELS.command, async argument => {
    const request = argument as { operation?: unknown; input?: unknown } | null;
    return await answerOperation(handlers, 'command', request?.operation, request?.input);
  });
  return { handlers, channels: [OPERATION_IPC_CHANNELS.read, OPERATION_IPC_CHANNELS.command] };
}

/** Every operation the registry declares has a handler, and no handler has no operation. */
export function operationCoverage(handlers: Readonly<Record<string, Handler>>): {
  readonly missing: readonly string[];
  readonly extra: readonly string[];
} {
  const named = new Set<string>(OPERATION_NAMES);
  const implemented = new Set(Object.keys(handlers));
  return {
    missing: [...named].filter(name => !implemented.has(name)),
    extra: [...implemented].filter(name => !named.has(name)),
  };
}

export { DIAL_IPC_CHANNELS, OPERATION_IPC_CHANNELS };
