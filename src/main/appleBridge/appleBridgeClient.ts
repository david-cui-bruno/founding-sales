import { randomUUID } from 'node:crypto';

import type {
  AppleBridgeProcessEvent,
  AppleBridgeTransport,
} from './appleBridgeProcess';
import {
  APPLE_BRIDGE_PROTOCOL_VERSION,
  appleBridgeHelloResultSchema,
  bridgeEventSchema,
  bridgeRequestSchema,
  bridgeResponseSchema,
  type BridgeEvent,
  type BridgeRequest,
  type BridgeResponse,
} from '../../shared/appleBridgeContract';

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 3_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1_000;
const MAX_TRACKED_RESPONSE_IDS = 10_000;

type ClientState = 'handshaking' | 'ready' | 'failed' | 'shuttingDown' | 'closed';

export type AppleBridgeReady = Readonly<{
  helperVersion: string;
  protocolVersion: typeof APPLE_BRIDGE_PROTOCOL_VERSION;
}>;

type PendingRequest = {
  timer: ReturnType<typeof setTimeout>;
  resolve(response: BridgeResponse): void;
  reject(error: Error): void;
};

export type AppleBridgeClientOptions = {
  createRequestId?: () => string;
  handshakeTimeoutMs?: number;
};

export type AppleBridgeClientApi = {
  ready(): Promise<AppleBridgeReady>;
  request<T extends BridgeRequest>(request: T, timeoutMs?: number): Promise<BridgeResponse>;
  subscribe(listener: (event: BridgeEvent) => void): () => void;
  shutdown(): Promise<void>;
};

export class AppleBridgeProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppleBridgeProtocolError';
  }
}

export class AppleBridgeClient implements AppleBridgeClientApi {
  readonly #transport: AppleBridgeTransport;
  readonly #createRequestId: () => string;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #usedRequestIds = new Set<string>();
  readonly #seenResponseIds = new Set<string>();
  readonly #eventListeners = new Set<(event: BridgeEvent) => void>();
  readonly #helloId: string;
  readonly #readyPromise: Promise<AppleBridgeReady>;
  readonly #resolveReady: (ready: AppleBridgeReady) => void;
  readonly #rejectReady: (error: Error) => void;
  #unsubscribeProcess: (() => void) | undefined;
  #handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  #shutdownPromise: Promise<void> | undefined;
  #shutdownRequested = false;
  #failureError: Error | undefined;
  #state: ClientState = 'handshaking';
  #lastEventSequence: number | undefined;

  constructor(transport: AppleBridgeTransport, options: AppleBridgeClientOptions = {}) {
    this.#transport = transport;
    this.#createRequestId = options.createRequestId ?? randomUUID;
    this.#helloId = this.#createRequestId();

    let resolveReady!: (ready: AppleBridgeReady) => void;
    let rejectReady!: (error: Error) => void;
    this.#readyPromise = new Promise<AppleBridgeReady>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    this.#readyPromise.catch((): void => undefined);
    this.#resolveReady = resolveReady;
    this.#rejectReady = rejectReady;

    const hello = bridgeRequestSchema.parse({
      v: APPLE_BRIDGE_PROTOCOL_VERSION,
      kind: 'request',
      id: this.#helloId,
      method: 'bridge.hello',
      params: { supportedVersions: [APPLE_BRIDGE_PROTOCOL_VERSION] },
    });
    this.#usedRequestIds.add(canonicalRequestId(this.#helloId));
    this.#unsubscribeProcess = transport.subscribe((event) => this.#handleProcessEvent(event));
    const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.#handshakeTimer = setTimeout(() => {
      this.#fail(new AppleBridgeProtocolError(
        `Apple bridge handshake timed out after ${handshakeTimeoutMs}ms.`,
      ));
    }, handshakeTimeoutMs);

    try {
      transport.writeFrame(hello);
    } catch {
      this.#fail(new Error('Apple bridge handshake could not be written.'));
    }
  }

  ready(): Promise<AppleBridgeReady> {
    if (this.#failureError !== undefined) {
      return Promise.reject(this.#failureError);
    }
    if (
      this.#shutdownRequested
      || this.#state === 'shuttingDown'
      || this.#state === 'closed'
    ) {
      return Promise.reject(new Error('Apple bridge client is shut down.'));
    }
    return this.#readyPromise.then((ready) => {
      if (
        this.#shutdownRequested
        || this.#state === 'shuttingDown'
        || this.#state === 'closed'
      ) {
        throw new Error('Apple bridge client is shut down.');
      }
      return ready;
    });
  }

  async request<T extends BridgeRequest>(
    request: T,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<BridgeResponse> {
    const parsed = bridgeRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new AppleBridgeProtocolError('Apple bridge request failed strict protocol validation.');
    }
    if (parsed.data.method === 'bridge.hello') {
      throw new AppleBridgeProtocolError('Apple bridge hello is managed by the client.');
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error('Apple bridge request timeout must be positive.');
    }

    await this.#readyPromise;
    if (
      this.#shutdownRequested
      || this.#state === 'shuttingDown'
      || this.#state === 'closed'
    ) {
      throw new Error('Apple bridge client is shut down.');
    }
    if (this.#state !== 'ready') {
      throw this.#failureError ?? new Error('Apple bridge client is unavailable.');
    }
    return this.#sendRequest(parsed.data, timeoutMs);
  }

  subscribe(listener: (event: BridgeEvent) => void): () => void {
    if (
      this.#state === 'failed'
      || this.#shutdownRequested
      || this.#state === 'shuttingDown'
      || this.#state === 'closed'
    ) {
      return () => undefined;
    }
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  shutdown(): Promise<void> {
    if (this.#shutdownPromise === undefined) {
      this.#shutdownRequested = true;
      this.#shutdownPromise = this.#performShutdown();
    }
    return this.#shutdownPromise;
  }

  async #performShutdown(): Promise<void> {
    if (this.#state === 'closed') return;
    let shutdownError: unknown;
    if (this.#state !== 'failed') {
      try {
        await this.#readyPromise;
        if (this.#state === 'ready') {
          this.#state = 'shuttingDown';
          const request = bridgeRequestSchema.parse({
            v: APPLE_BRIDGE_PROTOCOL_VERSION,
            kind: 'request',
            id: this.#nextUnusedRequestId(),
            method: 'bridge.shutdown',
            params: {},
          });
          const response = await this.#sendRequest(
            request,
            DEFAULT_SHUTDOWN_TIMEOUT_MS,
            true,
          );
          if (!response.ok) {
            throw new Error('Apple bridge rejected graceful shutdown.');
          }
        }
      } catch (error) {
        shutdownError = error;
      }
    }

    let closeError: unknown;
    try {
      this.#transport.closeInput();
    } catch (error) {
      closeError = error;
    }
    this.#rejectPending(new Error('Apple bridge client shut down with requests still pending.'));
    this.#dispose();
    this.#state = 'closed';

    if (shutdownError !== undefined && closeError !== undefined) {
      throw new AggregateError(
        [shutdownError, closeError],
        'Apple bridge graceful shutdown and stdin cleanup both failed.',
      );
    }
    if (shutdownError !== undefined) throw shutdownError;
    if (closeError !== undefined) throw closeError;
  }

  #sendRequest(
    request: BridgeRequest,
    timeoutMs: number,
    allowDuringShutdown = false,
  ): Promise<BridgeResponse> {
    if (!allowDuringShutdown && this.#state !== 'ready') {
      return Promise.reject(new Error('Apple bridge client is not ready.'));
    }
    if (allowDuringShutdown && this.#state !== 'shuttingDown') {
      return Promise.reject(new Error('Apple bridge client is not shutting down.'));
    }
    const requestKey = canonicalRequestId(request.id);
    if (this.#usedRequestIds.has(requestKey)) {
      return Promise.reject(new AppleBridgeProtocolError(
        'Apple bridge request ID has already been used.',
      ));
    }
    this.#usedRequestIds.add(requestKey);

    return new Promise<BridgeResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.#pending.get(requestKey);
        if (pending === undefined) return;
        this.#pending.delete(requestKey);
        pending.reject(new Error(`Apple bridge request ${request.method} timed out.`));
      }, timeoutMs);
      this.#pending.set(requestKey, { timer, resolve, reject });
      try {
        this.#transport.writeFrame(request);
      } catch {
        clearTimeout(timer);
        this.#pending.delete(requestKey);
        reject(new Error(`Apple bridge request ${request.method} could not be written.`));
      }
    });
  }

  #handleProcessEvent(event: AppleBridgeProcessEvent): void {
    if (this.#state === 'failed' || this.#state === 'closed') return;
    if (event.type === 'failure') {
      this.#fail(new AppleBridgeProtocolError(
        `Apple bridge protocol transport failed: ${event.error.message}`,
      ));
      return;
    }
    if (event.type === 'exit') {
      this.#fail(new Error(`Apple bridge process exited with code ${event.code ?? 'unknown'}.`));
      return;
    }
    this.#handleFrame(event.frame);
  }

  #handleFrame(frame: unknown): void {
    if (typeof frame !== 'object' || frame === null || !('kind' in frame)) {
      this.#fail(new AppleBridgeProtocolError('Apple bridge protocol frame has no valid kind.'));
      return;
    }
    const kind = (frame as { kind?: unknown }).kind;
    if (kind === 'response') {
      const parsed = bridgeResponseSchema.safeParse(frame);
      if (!parsed.success) {
        this.#fail(new AppleBridgeProtocolError(
          'Apple bridge protocol response failed strict validation.',
        ));
        return;
      }
      this.#handleResponse(parsed.data);
      return;
    }
    if (kind === 'event') {
      const parsed = bridgeEventSchema.safeParse(frame);
      if (!parsed.success) {
        this.#fail(new AppleBridgeProtocolError(
          'Apple bridge protocol event failed strict validation.',
        ));
        return;
      }
      this.#handleEvent(parsed.data);
      return;
    }
    this.#fail(new AppleBridgeProtocolError('Apple bridge protocol frame kind is unknown.'));
  }

  #handleResponse(response: BridgeResponse): void {
    const responseKey = canonicalRequestId(response.id);
    if (this.#seenResponseIds.has(responseKey)) {
      this.#fail(new AppleBridgeProtocolError(
        'Apple bridge protocol received a duplicate response ID.',
      ));
      return;
    }
    if (responseKey === canonicalRequestId(this.#helloId)) {
      if (this.#state !== 'handshaking') {
        this.#fail(new AppleBridgeProtocolError('Apple bridge sent a duplicate hello response.'));
        return;
      }
      if (!this.#trackResponseId(responseKey)) return;
      if (!response.ok) {
        this.#fail(new AppleBridgeProtocolError('Apple bridge rejected the V1 handshake.'));
        return;
      }
      const selectedVersion = response.result.selectedVersion;
      if (selectedVersion !== APPLE_BRIDGE_PROTOCOL_VERSION) {
        this.#fail(new AppleBridgeProtocolError('Apple bridge selected an unsupported protocol version.'));
        return;
      }
      const helloResult = appleBridgeHelloResultSchema.safeParse(response.result);
      if (!helloResult.success) {
        this.#fail(new AppleBridgeProtocolError(
          'Apple bridge V1 hello result failed strict validation.',
        ));
        return;
      }
      this.#clearHandshakeTimer();
      this.#state = 'ready';
      this.#resolveReady(Object.freeze({
        helperVersion: helloResult.data.helperVersion,
        protocolVersion: APPLE_BRIDGE_PROTOCOL_VERSION,
      }));
      return;
    }

    const pending = this.#pending.get(responseKey);
    if (pending === undefined) {
      this.#fail(new AppleBridgeProtocolError(
        'Apple bridge protocol received an unknown response ID.',
      ));
      return;
    }
    if (!this.#trackResponseId(responseKey)) return;
    clearTimeout(pending.timer);
    this.#pending.delete(responseKey);
    pending.resolve(response);
  }

  #handleEvent(event: BridgeEvent): void {
    if (this.#state === 'handshaking') {
      this.#fail(new AppleBridgeProtocolError('Apple bridge sent an event before the handshake.'));
      return;
    }
    if (
      this.#lastEventSequence !== undefined
      && event.seq <= this.#lastEventSequence
    ) {
      this.#fail(new AppleBridgeProtocolError(
        'Apple bridge event sequence is duplicate or out of order.',
      ));
      return;
    }
    this.#lastEventSequence = event.seq;
    for (const listener of [...this.#eventListeners]) listener(event);
  }

  #trackResponseId(responseId: string): boolean {
    if (this.#seenResponseIds.size >= MAX_TRACKED_RESPONSE_IDS) {
      this.#fail(new AppleBridgeProtocolError('Apple bridge response tracking capacity was exceeded.'));
      return false;
    }
    this.#seenResponseIds.add(responseId);
    return true;
  }

  #nextUnusedRequestId(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = this.#createRequestId();
      if (!this.#usedRequestIds.has(canonicalRequestId(id))) return id;
    }
    throw new Error('Apple bridge could not allocate a unique request ID.');
  }

  #fail(error: Error): void {
    if (this.#state === 'failed' || this.#state === 'closed') return;
    this.#state = 'failed';
    this.#failureError = error;
    this.#clearHandshakeTimer();
    this.#rejectReady(error);
    this.#rejectPending(error);
    this.#dispose();
    try {
      this.#transport.terminate();
    } catch {
      // The original protocol/process failure remains authoritative.
    }
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #clearHandshakeTimer(): void {
    if (this.#handshakeTimer !== undefined) {
      clearTimeout(this.#handshakeTimer);
      this.#handshakeTimer = undefined;
    }
  }

  #dispose(): void {
    this.#clearHandshakeTimer();
    this.#unsubscribeProcess?.();
    this.#unsubscribeProcess = undefined;
    this.#eventListeners.clear();
  }
}

function canonicalRequestId(requestId: string): string {
  return requestId.toLowerCase();
}
