import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import {
  bridgeErrorCodeSchema,
  bridgeRequestSchema,
  bridgeResponseSchema,
  type BridgeEvent,
  type BridgeRequest,
} from '../../shared/appleBridgeContract';
import {
  appleSpikeManualActionSchema,
  appleCapabilityStatusSchema,
  appleSpikeObservationDegradationReasonSchema,
  appleSpikeObservationEvidenceSchema,
  appleSpikePermissionActionSchema,
  appleSpikeReadOnlyActionSchema,
  appleSpikeResultSchema,
  appleSpikeStatusSchema,
  type AppleSpikeAction,
  type AppleSpikeManualAction,
  type AppleSpikeObservationEvidence,
  type AppleSpikePermissionAction,
  type AppleSpikeReadOnlyAction,
  type AppleSpikeResult,
  type AppleSpikeStatus,
} from '../../shared/appleSpikeContract';
import type { AppleBridgeService } from './appleBridgeService';

const unavailableOutcome = (action: AppleSpikeAction['action']): AppleSpikeResult =>
  appleSpikeResultSchema.parse({
    action,
    outcome: 'capability_unavailable',
    message: 'This Apple feasibility operation is unavailable on this Mac.',
  });

const task4ObservationEventSchema = z.union([
  z.object({
    event: z.literal('capability.changed'),
    payload: z.object({
      source: z.literal('phone_observation'),
      available: z.literal(true),
    }).strict(),
  }).strict(),
  z.object({
    event: z.literal('capability.changed'),
    payload: z.object({
      source: z.literal('phone_observation'),
      available: z.literal(false),
      reason: appleSpikeObservationDegradationReasonSchema,
    }).strict(),
  }).strict(),
  z.object({
    event: z.literal('call.stateChanged'),
    payload: z.object({
      outgoing: z.boolean(),
      connected: z.boolean(),
      ended: z.boolean(),
      onHold: z.boolean(),
    }).strict(),
  }).strict(),
  z.object({
    event: z.literal('call.identityResolved'),
    payload: z.object({ identity: z.literal('resolved') }).strict(),
  }).strict(),
  z.object({
    event: z.literal('call.identityUnresolved'),
    payload: z.object({
      identity: z.enum(['unresolved', 'ambiguous']),
    }).strict(),
  }).strict(),
]);

export interface AppleSpikeServiceApi {
  getStatus(): AppleSpikeStatus;
  runReadOnlyCheck(action: AppleSpikeReadOnlyAction): Promise<AppleSpikeResult>;
  requestPermission(action: AppleSpikePermissionAction): Promise<AppleSpikeResult>;
  authorizeManualAction(action: AppleSpikeManualAction): Promise<AppleSpikeResult>;
  subscribeObservation(
    listener: (evidence: AppleSpikeObservationEvidence) => void,
  ): () => void;
  dispose(): void;
}

export type AppleSpikeServiceOptions = {
  enabled: boolean;
  bridge: AppleBridgeService;
  createUuid?: () => string;
};

export class AppleSpikeService implements AppleSpikeServiceApi {
  readonly #enabled: boolean;
  readonly #bridge: AppleBridgeService;
  readonly #createUuid: () => string;
  readonly #observationListeners = new Set<
    (evidence: AppleSpikeObservationEvidence) => void
  >();
  #bridgeObservationUnsubscribe: (() => void) | undefined;
  #bridgeBindingGeneration = 0;
  #disposed = false;

  constructor(options: AppleSpikeServiceOptions) {
    this.#enabled = options.enabled;
    this.#bridge = options.bridge;
    this.#createUuid = options.createUuid ?? randomUUID;
  }

  getStatus(): AppleSpikeStatus {
    const status = appleSpikeStatusSchema.parse({
      enabled: this.#enabled,
      bridge: this.#bridge.getStatus(),
    });
    this.#reconcileObservationSubscription(status.bridge);
    return status;
  }

  runReadOnlyCheck(action: AppleSpikeReadOnlyAction): Promise<AppleSpikeResult> {
    return this.#run(action, appleSpikeReadOnlyActionSchema);
  }

  requestPermission(action: AppleSpikePermissionAction): Promise<AppleSpikeResult> {
    return this.#run(action, appleSpikePermissionActionSchema);
  }

  authorizeManualAction(action: AppleSpikeManualAction): Promise<AppleSpikeResult> {
    return this.#run(action, appleSpikeManualActionSchema);
  }

  subscribeObservation(
    listener: (evidence: AppleSpikeObservationEvidence) => void,
  ): () => void {
    if (this.#disposed) return () => undefined;
    this.#observationListeners.add(listener);
    const bridgeStatus = this.#bridge.getStatus();
    this.#reconcileObservationSubscription(bridgeStatus);
    if (
      this.#enabled
      && bridgeStatus.state === 'ready'
      && this.#bridgeObservationUnsubscribe === undefined
    ) {
      this.#observationListeners.delete(listener);
      throw new Error('Apple observation subscription is unavailable.');
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.#observationListeners.delete(listener);
      this.#reconcileObservationSubscription(this.#bridge.getStatus());
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#observationListeners.clear();
    this.#unbindObservationSubscription();
  }

  async #run<T extends AppleSpikeAction>(
    input: T,
    schema: z.ZodType<T>,
  ): Promise<AppleSpikeResult> {
    if (!this.#enabled) {
      throw new Error('Apple feasibility spike is disabled.');
    }

    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      throw new Error('Apple feasibility request is invalid.');
    }
    const action = parsed.data;

    const bridgeStatus = this.#bridge.getStatus();
    this.#reconcileObservationSubscription(bridgeStatus);
    if (bridgeStatus.state !== 'ready') {
      throw new Error('Apple integration helper is unavailable.');
    }
    if (
      action.action === 'start_call_observation'
      && (
        this.#observationListeners.size === 0
        || this.#bridgeObservationUnsubscribe === undefined
      )
    ) {
      throw new Error('Apple observation subscription is unavailable.');
    }

    const request = this.#requestFor(action);
    let response: z.infer<typeof bridgeResponseSchema>;
    try {
      response = bridgeResponseSchema.parse(await this.#bridge.request(request));
    } catch {
      throw new Error('Apple integration helper is unavailable.');
    }

    if (response.id.toLowerCase() !== request.id.toLowerCase()) {
      throw new Error('Apple feasibility response was invalid.');
    }
    if (response.ok === false) {
      if (response.error.code === 'capability_unavailable') {
        return unavailableOutcome(action.action);
      }
      throw new Error(this.#safeErrorFor(response.error.code));
    }

    return this.#completedResult(action, response.result, request);
  }

  #requestFor(action: AppleSpikeAction): BridgeRequest {
    const id = this.#createUuid();
    switch (action.action) {
      case 'probe_capabilities':
        return this.#parseRequest({ v: 1, kind: 'request', id, method: 'capabilities.probe', params: {} });
      case 'request_contacts':
        return this.#parseRequest({ v: 1, kind: 'request', id, method: 'permissions.requestContacts', params: {} });
      case 'prompt_accessibility':
        return this.#parseRequest({ v: 1, kind: 'request', id, method: 'permissions.promptAccessibility', params: {} });
      case 'scan_recent_notes':
        return this.#parseRequest({ v: 1, kind: 'request', id, method: 'notes.scanCallRecordings', params: {} });
      case 'scan_test_messages':
        return this.#parseRequest({
          v: 1,
          kind: 'request',
          id,
          method: 'messages.scanTestActivity',
          params: { recipientHandle: action.normalizedHandle },
        });
      case 'start_call_observation':
        return this.#parseRequest({ v: 1, kind: 'request', id, method: 'call.observe.start', params: {} });
      case 'stop_call_observation':
        return this.#parseRequest({ v: 1, kind: 'request', id, method: 'call.observe.stop', params: {} });
      case 'send_test_message': {
        const commandId = this.#createUuid();
        if (commandId.toLowerCase() === id.toLowerCase()) {
          throw new Error('Apple feasibility request identifiers are unavailable.');
        }
        return this.#parseRequest({
          v: 1,
          kind: 'request',
          id,
          method: 'messages.sendTest',
          params: {
            commandId,
            recipientHandle: action.normalizedHandle,
            body: action.body,
            confirmation: action.confirmation,
          },
        });
      }
    }
  }

  #parseRequest(input: unknown): BridgeRequest {
    const parsed = bridgeRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error('Apple feasibility request could not be constructed.');
    }
    return parsed.data;
  }

  #completedResult(
    action: AppleSpikeAction,
    rawResult: Record<string, unknown>,
    request: BridgeRequest,
  ): AppleSpikeResult {
    try {
      switch (action.action) {
        case 'probe_capabilities': {
          const result = z.object({
            capabilities: appleCapabilityStatusSchema,
          }).strict().parse(rawResult);
          return appleSpikeResultSchema.parse({
            action: action.action,
            outcome: 'completed',
            capabilities: result.capabilities,
          });
        }
        case 'request_contacts': {
          const result = z.object({
            access: z.enum([
              'full',
              'limited',
              'denied',
              'restricted',
              'notDetermined',
            ]),
          }).strict().parse(rawResult);
          return appleSpikeResultSchema.parse({
            action: action.action,
            outcome: 'completed',
            contactAccess: result.access,
          });
        }
        case 'prompt_accessibility': {
          const result = z.object({ trusted: z.boolean() }).strict().parse(rawResult);
          return appleSpikeResultSchema.parse({
            action: action.action,
            outcome: 'completed',
            accessibilityTrusted: result.trusted,
          });
        }
        case 'scan_recent_notes': {
          const result = z.object({
            artifacts: z.array(z.object({
              artifactId: z.string().uuid(),
              createdAt: z.string().datetime(),
            }).strict()).max(501),
            truncated: z.boolean(),
          }).strict().parse(rawResult);
          return appleSpikeResultSchema.parse({
            action: action.action,
            outcome: 'completed',
            artifactCount: result.artifacts.length,
            truncated: result.truncated,
          });
        }
        case 'scan_test_messages': {
          const result = z.object({
            sentCount: z.number().int().nonnegative().max(500),
            receivedCount: z.number().int().nonnegative().max(500),
            latestAt: z.string().datetime().nullable(),
          }).strict().parse(rawResult);
          return appleSpikeResultSchema.parse({
            action: action.action,
            outcome: 'completed',
            ...result,
          });
        }
        case 'start_call_observation':
          z.object({ observing: z.literal(true) }).strict().parse(rawResult);
          return appleSpikeResultSchema.parse({
            action: action.action,
            outcome: 'completed',
            observation: 'started',
          });
        case 'stop_call_observation':
          z.object({ observing: z.literal(false) }).strict().parse(rawResult);
          return appleSpikeResultSchema.parse({
            action: action.action,
            outcome: 'completed',
            observation: 'stopped',
          });
        case 'send_test_message': {
          const result = z.object({ commandId: z.string().uuid() }).strict().parse(rawResult);
          if (
            request.method !== 'messages.sendTest'
            || result.commandId.toLowerCase() !== request.params.commandId.toLowerCase()
          ) {
            throw new Error('command mismatch');
          }
          return appleSpikeResultSchema.parse({
            action: action.action,
            outcome: 'completed',
            delivery: 'sent',
          });
        }
      }
    } catch {
      throw new Error('Apple feasibility response was invalid.');
    }
  }

  #safeErrorFor(code: z.infer<typeof bridgeErrorCodeSchema>): string {
    switch (code) {
      case 'permission_denied':
        return 'Apple permission was denied.';
      case 'invalid_request':
        return 'Apple feasibility request was rejected.';
      case 'identity_unresolved':
        return 'The test recipient could not be resolved uniquely.';
      case 'schema_unsupported':
        return 'The local Apple data format is unsupported.';
      default:
        return 'Apple feasibility operation failed safely.';
    }
  }

  #reconcileObservationSubscription(
    status: ReturnType<AppleBridgeService['getStatus']>,
  ): void {
    const shouldBind = (
      !this.#disposed
      && this.#enabled
      && status.state === 'ready'
      && this.#observationListeners.size > 0
    );
    if (!shouldBind) {
      this.#unbindObservationSubscription();
      return;
    }
    if (this.#bridgeObservationUnsubscribe !== undefined) return;

    const generation = ++this.#bridgeBindingGeneration;
    try {
      this.#bridgeObservationUnsubscribe = this.#bridge.subscribe((event) => {
        if (this.#disposed || generation !== this.#bridgeBindingGeneration) return;
        const evidence = this.#observationEvidence(event);
        if (evidence === undefined) return;
        for (const listener of [...this.#observationListeners]) {
          try {
            listener(evidence);
          } catch {
            // One renderer listener cannot interrupt the sanitized evidence boundary.
          }
        }
      });
    } catch {
      this.#bridgeObservationUnsubscribe = undefined;
    }
  }

  #unbindObservationSubscription(): void {
    if (this.#bridgeObservationUnsubscribe === undefined) return;
    const unsubscribe = this.#bridgeObservationUnsubscribe;
    this.#bridgeObservationUnsubscribe = undefined;
    this.#bridgeBindingGeneration += 1;
    try {
      unsubscribe();
    } catch {
      // The optional Apple boundary remains disposable even if a stale client misbehaves.
    }
  }

  #observationEvidence(event: BridgeEvent): AppleSpikeObservationEvidence | undefined {
    const parsed = task4ObservationEventSchema.safeParse({
      event: event.event,
      payload: event.payload,
    });
    if (!parsed.success) return undefined;

    switch (parsed.data.event) {
      case 'capability.changed':
        if (parsed.data.payload.available === true) {
          return appleSpikeObservationEvidenceSchema.parse({
            kind: 'capability',
            available: true,
          });
        }
        return appleSpikeObservationEvidenceSchema.parse({
          kind: 'capability',
          available: false,
          reason: parsed.data.payload.reason,
        });
      case 'call.stateChanged':
        return appleSpikeObservationEvidenceSchema.parse({
          kind: 'call_state',
          ...parsed.data.payload,
        });
      case 'call.identityResolved':
      case 'call.identityUnresolved':
        return appleSpikeObservationEvidenceSchema.parse({
          kind: 'identity',
          identity: parsed.data.payload.identity,
        });
    }
  }
}
