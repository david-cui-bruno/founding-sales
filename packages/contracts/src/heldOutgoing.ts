import { z } from 'zod';
import { instant, uuid } from './foundationRows.ts';

/**
 * The salesperson's own outgoing messages that are waiting for a person to say which
 * firm they belong to (send-path v2, S1 review P1-C).
 *
 * A direct Gmail send matched to more than one firm — a shared address, or a recipient at
 * a firm the thread did not name — is held, and its direct-send effect waits for the
 * resolution. Before this read the only way to resolve one was a reply card, which an
 * outgoing message never has. `POST /messages/held-outgoing` lists them for one firm
 * page; the existing `POST /messages/resolve-ambiguity` resolves them.
 *
 * Ids, the instant and the candidate firms' names only: no address, subject or body.
 */
export const heldOutgoingCandidateSchema = z.strictObject({
  opportunityId: uuid,
  firmId: uuid,
  firmName: z.string(),
});

export const heldOutgoingMessageSchema = z.strictObject({
  messageId: uuid,
  internalDate: instant,
  candidates: z.array(heldOutgoingCandidateSchema),
});
export type HeldOutgoingMessage = z.infer<typeof heldOutgoingMessageSchema>;

export const heldOutgoingRequestSchema = z.strictObject({ firmId: uuid });

export const heldOutgoingResponseSchema = z.strictObject({
  messages: z.array(heldOutgoingMessageSchema),
});
export type HeldOutgoingResponse = z.infer<typeof heldOutgoingResponseSchema>;
