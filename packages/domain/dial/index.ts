/**
 * Dial authorization, tickets, call outcomes, callbacks and the calling identities a
 * dial is placed from (specification 9.1, 9.2).
 *
 * Nothing here dials. Since wave 2 (S4.5) the Mac asks `adviseDial` whether a firm is
 * callable and why not, opens `tel:` itself, and logs the call afterwards; the ticket
 * pair (`authorizeDial`, `consumeDialTicket`) stays for desktops up to 1.0.11.
 * See `docs/greenfield/policy.md`.
 */

export {
  authorizeDial,
  type AuthorizeDialInput,
  type DialDecision,
  type DialEvidence,
} from './authorize.ts';

export { adviseDial, type DialAdvice } from './advise.ts';

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
  resolveConfirmedInstant,
  scheduleCallbackForCall,
  type CallbackRow,
  type ConfirmedInstant,
  type CreateCallbackInput,
  type ScheduleCallbackForCallInput,
} from './callbacks.ts';

export {
  CALL_ATTEMPT_LIMIT,
  applyCallToStep,
  effectsForBoundStep,
  loadBoundCallStep,
  type AppliedStep,
  type BoundStep,
} from './stepEffects.ts';
