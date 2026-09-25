/**
 * Policy: state postures, calling windows, holds and administrative pauses
 * (specification 9.2, 10.1, 4.3, 15).
 *
 * Everything here goes through `RepositoryContext`, so no row is reachable without a
 * `WorkspaceScope`, and everything that records posture is admin-only. See
 * `docs/greenfield/policy.md`.
 */

export {
  ALL_BLOCKED_ACTION_KINDS,
  CHANNEL_BLOCKED_ACTION_KINDS,
  POLICY_REFUSAL_CODES,
  acceptPolicy,
  refusePolicy,
  type OpenHold,
  type PolicyRefusalCode,
  type PolicyResult,
} from './types.ts';

export { databaseNow } from './clock.ts';

export { lockSendGateForDispatch, lockSendGateForStopFact, sendGateLockName } from './sendGate.ts';

export {
  listApplicableHolds,
  listHoldsByReason,
  openHold,
  releaseHold,
  releaseHoldsOfEvent,
  type HoldSubject,
  type OpenHoldInput,
  type ReleasedHold,
} from './holds.ts';

export {
  applicablePosture,
  listStatePostures,
  recordStatePosture,
  revokeStatePosture,
  type ApplicablePosture,
  type RecordStatePostureInput,
  type StatePostureRow,
} from './postures.ts';

export {
  FLOOR_CALLING_WINDOW,
  currentCallingWindow,
  evaluateConfiguredCallingWindow,
  setCallingWindow,
  type ConfiguredCallingWindow,
  type ConfiguredWindowDecision,
  type SetCallingWindowInput,
} from './callingWindows.ts';

export {
  listPauses,
  openPause,
  releasePause,
  type OpenPauseInput,
  type PauseRow,
} from './pauses.ts';
