export type { AuthConfig, AuthDeps, GoogleOidcConfig, SessionPolicy } from './config.ts';
export {
  createGoogleClient,
  httpFetch,
  type DiscoveryDocument,
  type GoogleClient,
  type GoogleClientOptions,
  type HttpFetch,
  type HttpRequest,
  type HttpResponse,
  type TokenExchangeFailureReason,
  type TokenExchangeResult,
} from './googleClient.ts';
export { validateIdToken, type IdTokenOutcome, type VerifiedIdTokenClaims } from './idToken.ts';
export {
  bearerOf,
  canonicalJson,
  codeChallengeOf,
  deriveCodeVerifier,
  digestsEqual,
  formatAccessToken,
  formatRefreshCredential,
  parseAccessToken,
  parseRefreshCredential,
  payloadHashOf,
  sha256Hex,
} from './tokens.ts';
export {
  claimSignIn,
  handleCallback,
  startSignIn,
  type CallbackInput,
  type CallbackOutcome,
  type ClaimInput,
  type ClaimOutcome,
  type StartSignInInput,
  type StartSignInOutcome,
} from './signIn.ts';
export {
  authenticate,
  endSession,
  issueSession,
  registerDevice,
  renewSession,
  revokeDevice,
  type AuthenticateOutcome,
  type AuthenticatedPrincipal,
  type IssuedSession,
  type RenewOutcome,
} from './sessions.ts';
export {
  runCommand,
  type CommandOutcome,
  type CommandRequest,
  type CommandWorkResult,
  type RefusalDetails,
} from './commands.ts';
export {
  actorOf,
  decideSensitiveRead,
  recordAuditEvent,
  recordSensitiveRead,
  SYSTEM_ACTOR,
  type AuditActor,
  type AuditEventInput,
  type SensitiveReadDecision,
  type SensitiveReadRecord,
  type SensitiveReadRequest,
} from './audit.ts';
export type { SessionGrant, SessionRenewal } from '@fss/contracts';
