import { createHash } from 'node:crypto';
import type { OutboundRequest } from '../../shared/contracts/outboundContract';

// Optimistic display consistency only. This snapshot grants no outbound permission.
export function contactSnapshot(input: Readonly<{
  id: string; personId: string; kind: 'phone' | 'email';
  normalizedValue: string; validationState: 'unverified' | 'valid' | 'invalid';
  updatedAt: string;
}>): string {
  return createHash('sha256').update(JSON.stringify([
    'contact_snapshot_v1', input.id, input.personId, input.kind,
    input.normalizedValue, input.validationState, input.updatedAt,
  ])).digest('hex');
}

export function outboundIntentFingerprint(request: OutboundRequest): string {
  return createHash('sha256').update(JSON.stringify([
    'outbound_intent_v1', request.commandId, request.channel, request.personId,
    request.salesCycleId, request.contactMethodId, request.expectedContactSnapshot,
  ])).digest('hex');
}
