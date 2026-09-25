/**
 * Dial authorization, tickets, call outcomes, callbacks and the calling identities a
 * dial is placed from (specification 9.1, 9.2).
 *
 * `authorizeDial` is the only allow/refuse decision in the system, and nothing here
 * dials: the Mac opens a `tel:` URI with a ticket this package minted and consumed.
 * See `docs/greenfield/policy.md`.
 */

export {
  authorizeDial,
  type AuthorizeDialInput,
  type DialDecision,
  type DialEvidence,
} from './authorize.ts';

export {
  DIAL_TICKET_SECONDS,
  authorizeDialCommand,
  consumeDialTicket,
  readDialTicket,
  type AuthorizeDialCommandInput,
  type ConsumedTicket,
  type DialResult,
  type DialTicketState,
  type IssuedDialTicket,
} from './tickets.ts';

export { callOutcomeEffects, manualReasonFor, type CallOutcomeEffects } from './outcomes.ts';

export { listCallLogs, logCallOutcome, type CallLogRow, type LogCallOutcomeInput, type LoggedCall } from './calls.ts';

export {
  CALLING_IDENTITY_LABEL_MAX,
  currentCallingIdentityId,
  disableCallingIdentity,
  listOwnCallingIdentities,
  normalizeCallingNumber,
  registerCallingIdentity,
  verifyCallingIdentity,
  type CallingIdentityChange,
  type CallingIdentityResult,
  type CallingIdentityRow,
  type RegisterCallingIdentityInput,
} from './identities.ts';

export {
  completeCallback,
  createCallback,
  listCallbacks,
  type CallbackRow,
  type CreateCallbackInput,
} from './callbacks.ts';
