import { z } from 'zod';
import { pairRedeemResponseSchema, v1CommandReceiptSchema, v1CommandSchema, type V1Command } from '../../../src/shared/contracts/v1Contract';
import {
  clientStatusSchema,
  dialRequestSchema,
  dialResultSchema,
  pairRequestSchema,
  readRequestSchema,
  viewSchemas,
  type ClientStatus,
  type CommandResult,
  type DialRequest,
  type DialResult,
  type PairRequest,
  type PairResult,
  type ReadRequest,
  type ReadResult,
  type TodayView,
} from '../shared/clientContract';
import { readLastGoodToday, writeLastGoodToday } from './lastGood';
import { ClientPhone, type HandoffLauncher, type HeldView } from './phone';
import { deleteCodeFile, PairCodeError, resolvePairCode, type PairCodeRefusal } from './pairCode';
import { TokenStoreError, type StoredDevice, type TokenStore } from './tokenStore';
import { requestWorker, type WorkerFailure, type WorkerReply } from './workerClient';
import type { EndpointResolution } from './workerEndpoint';

/**
 * The client's five operations behind the IPC channels: status, pair, get, command, unpair. Every worker
 * exchange goes through `requestWorker` (15 s, one retry on a network failure, never on an answer) and
 * every outcome is one of the honest states the renderer shows: ok, unavailable, unauthenticated,
 * unpaired, or for pairing paired, refused, unavailable. A 401 that names `device_revoked` or
 * `device_expired` forgets the token here, so the next status is unpaired and carries the sentence.
 *
 * Slice S2 adds the Firm view as a third readable path and the Phone.app handoff as a sixth operation. The handoff
 * is gated on the Today view this object last served, not on anything the renderer says: the card, its `dialAllowed`
 * and its number all have to come from that view, and the view has to be under two minutes old.
 */
const slug = z.string().regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/).max(40);
const errorBodySchema = z.object({ error: slug });
const pairRefusalSchema = z.object({ error: z.literal('pair_refused'), reason: slug });
const unauthenticatedBodySchema = z.object({ error: z.literal('unauthenticated'), reason: slug.optional() });

const FAILURE_SENTENCES: Record<WorkerFailure, string> = {
  timeout: 'The worker did not answer within 15 seconds.',
  network: 'The worker could not be reached.',
  response_too_large: "The worker's answer was too large to read.",
};
const PAIR_CODE_SENTENCES: Record<PairCodeRefusal, string> = {
  code_invalid: 'That is neither a pairing code nor the absolute path of a code file.',
  code_file_unreadable: 'The code file could not be read.',
  code_file_invalid: 'The code file does not hold a pairing code.',
};
const REFUSAL_SENTENCES = {
  device_expired: 'The worker refused this device: its token expired. Pair again with a new code.',
  device_revoked: 'The worker refused this device: it was revoked. Pair again with a new code.',
} as const;
const HTTP_SENTENCES: Record<string, string> = {
  not_found: 'The worker does not serve this view yet.',
  invalid_request: 'The worker refused the request as malformed.',
  worker_error: 'The worker reported its own error.',
  unavailable: "The worker's store is unavailable right now.",
};
const INVALID_RESPONSE = "The worker's answer did not match the contract.";
const UNPAIRED = 'This Mac is not paired.';
const TOKEN_UNREADABLE = 'The stored device token could not be read. Pair again with a new code.';
const ENCRYPTION_UNAVAILABLE = 'This Mac cannot protect a device token: safeStorage encryption is unavailable.';
const BARE_401 = "The worker refused this device's token. Unpair and pair again with a new code.";

type Reply = Extract<WorkerReply, { kind: 'reply' }>;
type Parser<T> = { safeParse(value: unknown): { success: true; data: T } | { success: false } };
type Unavailable = Extract<ReadResult, { outcome: 'unavailable' }>;
type Unauthenticated = Extract<ReadResult, { outcome: 'unauthenticated' }>;
type Unpaired = Extract<ReadResult, { outcome: 'unpaired' }>;

const httpReason = (reply: Reply): string => {
  const parsed = errorBodySchema.safeParse(reply.body);
  return parsed.success ? parsed.data.error : `http_${reply.status}`;
};
const httpSentence = (reply: Reply): string => HTTP_SENTENCES[httpReason(reply)] ?? `The worker answered with status ${reply.status}.`;

export type ClientCoreInput = {
  clientDirectory: string;
  tokenStore: TokenStore;
  endpoint: EndpointResolution;
  fetch?: typeof globalThis.fetch;
  now?: () => string;
  /** The Phone.app launcher. Absent means this Mac has no phone route, which is what a development run has. */
  dialLauncher?: () => Promise<HandoffLauncher | null>;
};

export class ClientCore {
  private notice: string | null = null;
  /** The Today view this process last served the renderer, and when it was fetched. The handoff's only source of truth. */
  private held: HeldView | null = null;
  private readonly phone: ClientPhone;

  constructor(private readonly input: ClientCoreInput) {
    this.phone = new ClientPhone({ heldView: () => this.held, launcher: input.dialLauncher ?? (async () => null) });
  }

  /** The Today view this Mac is showing, for the handoff gate and for a test that needs to see it. */
  heldTodayView(): HeldView | null {
    return this.held;
  }

  private now(): string {
    return this.input.now?.() ?? new Date().toISOString();
  }

  /** The stored device, or null with a notice when the file cannot be read: an unreadable token is an unpaired Mac. */
  private async stored(): Promise<StoredDevice | null> {
    try {
      return await this.input.tokenStore.load();
    } catch (error) {
      if (!(error instanceof TokenStoreError)) throw error;
      this.notice = error.reason === 'unavailable' ? ENCRYPTION_UNAVAILABLE : TOKEN_UNREADABLE;
      return null;
    }
  }

  async status(): Promise<ClientStatus> {
    const device = await this.stored();
    return clientStatusSchema.parse({
      state: device ? 'paired' : 'unpaired',
      endpoint: this.input.endpoint.endpoint,
      endpointSource: this.input.endpoint.source,
      deviceId: device?.deviceId ?? null,
      workspaceId: device?.workspaceId ?? null,
      pairedAt: device?.pairedAt ?? null,
      notice: this.notice,
    });
  }

  async pair(request: PairRequest): Promise<PairResult> {
    const { codeOrPath } = pairRequestSchema.parse(request);
    const endpoint = this.input.endpoint.endpoint;
    if (endpoint === null) return { outcome: 'refused', reason: 'endpoint_unconfigured', sentence: 'No worker endpoint is configured.' };
    let resolved;
    try {
      resolved = await resolvePairCode(codeOrPath);
    } catch (error) {
      if (error instanceof PairCodeError) return { outcome: 'refused', reason: error.reason, sentence: PAIR_CODE_SENTENCES[error.reason] };
      throw error;
    }
    const reply = await requestWorker({ endpoint, path: '/v1/pair/redeem', method: 'POST', body: { code: resolved.code } }, { fetch: this.input.fetch });
    if (reply.kind === 'failed') return { outcome: 'unavailable', reason: reply.reason, sentence: FAILURE_SENTENCES[reply.reason] };
    if (reply.status === 200) {
      const redeemed = pairRedeemResponseSchema.safeParse(reply.body);
      if (!redeemed.success) return { outcome: 'unavailable', reason: 'invalid_response', sentence: INVALID_RESPONSE };
      await this.input.tokenStore.save({ deviceToken: redeemed.data.deviceToken, deviceId: redeemed.data.deviceId, workspaceId: redeemed.data.workspaceId, endpoint, pairedAt: this.now() });
      this.notice = null;
      const codeFileDeleted = resolved.codeFile === null ? false : await deleteCodeFile(resolved.codeFile);
      return { outcome: 'paired', status: await this.status(), codeFileDeleted };
    }
    const refusal = pairRefusalSchema.safeParse(reply.body);
    if ((reply.status === 400 || reply.status === 429) && refusal.success) {
      return { outcome: 'refused', reason: refusal.data.reason, sentence: `The worker refused this code: ${refusal.data.reason}.` };
    }
    return { outcome: 'unavailable', reason: httpReason(reply), sentence: httpSentence(reply) };
  }

  async get(request: ReadRequest): Promise<ReadResult> {
    const { view, kind, firmId } = readRequestSchema.parse(request);
    // The three view schemas differ in shape; the read only needs "does it parse", and the preload re-validates per path.
    const schema: Parser<unknown> = viewSchemas[view];
    const query: Record<string, string> | undefined = kind !== undefined ? { kind } : firmId !== undefined ? { firmId } : undefined;
    const result: ReadResult = await this.authenticated({ path: view, method: 'GET', ...(query === undefined ? {} : { query }) }, schema, async (value): Promise<ReadResult> => {
      const fetchedAt = this.now();
      if (view === '/v1/today') {
        await writeLastGoodToday(this.input.clientDirectory, { fetchedAt, view: value as TodayView });
        this.held = { view: value as TodayView, fetchedAt };
      }
      return { outcome: 'ok', fetchedAt, view: value, source: 'worker' };
    });
    // A morning survives an outage (design section 1): when the worker does not answer Today, the last good answer
    // this Mac kept is served with its own fetched-at stamp and the sentence of the failure, so the page shows it as
    // stale. A refused token or an unpaired Mac is never papered over with an old list.
    if (view === '/v1/today' && result.outcome === 'unavailable') {
      const lastGood = await readLastGoodToday(this.input.clientDirectory);
      // The held view keeps the original fetched-at stamp, so a dial from a last-good list is refused as stale
      // rather than as "no list": the answer names the real reason.
      if (lastGood) {
        this.held = { view: lastGood.view, fetchedAt: lastGood.fetchedAt };
        return { outcome: 'ok', fetchedAt: lastGood.fetchedAt, view: lastGood.view, source: 'last_good', sentence: result.sentence };
      }
    }
    return result;
  }

  async command(command: V1Command): Promise<CommandResult> {
    const parsed = v1CommandSchema.parse(command);
    return this.authenticated({ path: '/v1/commands', method: 'POST', body: parsed }, v1CommandReceiptSchema, async (receipt): Promise<CommandResult> => ({ outcome: 'ok', receipt }));
  }

  /**
   * Hands one number to Phone.app (S2). Never a call: the dialer opens with the number in it and David presses the
   * button. An unpaired Mac has no list and therefore no card, which is the refusal it gets.
   */
  async dial(request: DialRequest): Promise<DialResult> {
    const parsed = dialRequestSchema.parse(request);
    return dialResultSchema.parse(await this.phone.dial(parsed));
  }

  async unpair(): Promise<ClientStatus> {
    await this.input.tokenStore.clear();
    this.notice = null;
    this.held = null;
    return this.status();
  }

  private async authenticated<T, R>(
    request: { path: string; method: 'GET' | 'POST'; body?: unknown; query?: Record<string, string> },
    schema: Parser<T>,
    onOk: (value: T) => Promise<R>,
  ): Promise<R | Unavailable | Unauthenticated | Unpaired> {
    const device = await this.stored();
    if (!device) return { outcome: 'unpaired', sentence: UNPAIRED };
    const reply = await requestWorker({ endpoint: device.endpoint, token: device.deviceToken, ...request }, { fetch: this.input.fetch });
    if (reply.kind === 'failed') return { outcome: 'unavailable', reason: reply.reason, status: null, sentence: FAILURE_SENTENCES[reply.reason] };
    if (reply.status === 401) {
      const body = unauthenticatedBodySchema.safeParse(reply.body);
      const reason = body.success ? body.data.reason : undefined;
      if (reason === 'device_expired' || reason === 'device_revoked') {
        await this.input.tokenStore.clear();
        this.notice = REFUSAL_SENTENCES[reason];
        return { outcome: 'unauthenticated', reason, cleared: true, sentence: this.notice };
      }
      return { outcome: 'unauthenticated', reason: null, cleared: false, sentence: BARE_401 };
    }
    if (reply.status === 200) {
      const parsed = schema.safeParse(reply.body);
      if (!parsed.success) return { outcome: 'unavailable', reason: 'invalid_response', status: 200, sentence: INVALID_RESPONSE };
      return onOk(parsed.data);
    }
    return { outcome: 'unavailable', reason: httpReason(reply), status: reply.status, sentence: httpSentence(reply) };
  }
}
