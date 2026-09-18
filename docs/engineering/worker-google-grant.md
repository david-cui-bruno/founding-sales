# The worker-held Google grant for callie@usecallie.com

The Worker, not this Mac, holds the Google grant that sends mail from the company mailbox and reads
replies on the threads it sent. Nothing in this repository creates that grant, deploys the worker, or
sends a message. Everything below that changes a live system is an explicit step David takes.

Code: `cloud/lambdas/delegated-worker/src/remoteGoogleAuthorization.ts` (OAuth begin/callback, sealed
tokens, status, revoke), the `/google/*` and `/oauth/callback` routes in `handler.ts`, and the shared
contracts `src/shared/contracts/googleGrantCapabilities.ts` and `remoteGoogleGrantContract.ts`.

## What the grant permits, exactly

Two purposes, stored under separate keys and never interchangeable:

| Purpose | Scopes requested | Used for |
| --- | --- | --- |
| `permitted_correspondence` | `openid`, `email`, `gmail.send`, `gmail.readonly` | Sending from the named `@usecallie.com` mailbox under a template David approved or a message he approved one at a time, and reading replies on threads the worker already sent |
| `personal_availability` | `openid`, `email`, `calendar.freebusy` | Free/busy for explicitly confirmed calendar IDs only |

The disclosure the desktop shows before consent is revision 2 (`google-grant-v2` and
`personal-google-grant-v2`). Revision 1's "Google Testing refresh tokens may expire after seven days"
sentence was withdrawn: the deployed OAuth client is a Google Workspace **Internal**-audience client,
so that External-audience warning never described it. The version travels in the begin request
(`remoteGoogleGrantContract.ts`), so a desktop holding a stale text cannot start consent at all.

## What David creates in Google Cloud

Directive: `DAVID-DIRECTIVE-GOOGLE-WEB-CLIENT-20260917.html`.

1. In the Google Cloud project for the Workspace, create an **OAuth 2.0 Web application** client with
   audience **Internal**. An Internal client can only be completed by an account inside the Workspace,
   which is what we want for `callie@usecallie.com`.
2. The single authorised redirect URI is exactly
   `https://z5orkvbus9.execute-api.us-east-1.amazonaws.com/oauth/callback`. The worker refuses any other
   path, any query or fragment, and any non-HTTPS origin (`RemoteGoogleAuthorization.config()`).
3. Enable the Gmail API. Enable the Calendar API only if the personal availability purpose is wanted.
4. Keep the client id; it is not a secret and goes into Terraform as `delegated_google_client_id`.
   Keep the client secret out of Terraform entirely: it goes only into SSM, below.

## The two SSM parameters (names only)

Both are `SecureString`, encrypted with the worker's KMS key, provisioned by hand after approval.
Terraform declares the names and the read policy and never reads or writes a value.

- `/delegated-worker/<workspace-id>/google-client-secret` — the OAuth client secret.
- `/delegated-worker/<workspace-id>/token-encryption-key` — 32 random bytes, base64. This key seals the
  refresh and access tokens (AES-256-GCM) and signs the access evidence HMAC. Rotating it invalidates
  every sealed token, which forces a fresh consent; it is not a routine operation.

Never paste a value into a commit, a test, a fixture, a log line or a pull request. The worker code
only ever names these parameters; it reads them at cold start and keeps the values in memory.

## Redeploy

`cloud/terraform/modules/delegated-worker` needs no new variable for anything in this document: the
sender ramp is policy, not infrastructure. Set `delegated_google_client_id` to the new client id (an
empty value leaves Google unconfigured and every `/google/*` route answers `503 google_unconfigured`),
then apply from `cloud/worker-terraform`. `DELEGATED_GOOGLE_SECRET_PARAMETER` and
`DELEGATED_GOOGLE_KEY_PARAMETER` derive from the client id automatically
(`modules/delegated-worker/main.tf`); a partially set trio fails the worker's own composition check
rather than starting half-configured.

## "Continue to Google"

In Settings → Connections → Work email, type the named `@usecallie.com` mailbox, confirm the mailbox,
acknowledge the disclosure, then press **Continue to Google**. That opens consent in the browser; the
button is not a connected grant and the desktop runs no automatic follow-up check. Complete consent as
`callie@usecallie.com`, then press **Refresh** here. The redirect lands on the worker's
`/oauth/callback`, which exchanges the code with PKCE, verifies the identity, and stores only the sealed
token envelope. A callback whose `state` was never issued, was already consumed, or has expired is
refused before any provider call.

## Revoking

Settings → Connections → Work email → **Revoke cloud grant**. The worker claims the revocation durably
first, then calls Google's revoke endpoint. If that call gives no definitive answer, the grant stays
`revoked` with `providerRevocation: 'pending'` and re-authorisation is blocked until an explicit retry
confirms cleanup. "Pending" means provider access may still exist. Revoking never touches the pairing.

## Today's sender cap and the warm-up ramp

`sender-caps` policy (`src/shared/contracts/workerPolicyContract.ts`) is `{ sender, dailyLimit, ramp? }`
with `ramp: { startPerDay, stepPerDay, maxPerDay }`. `SENDER_RAMP_DEFAULT` is David's decision of
17 September 2026: start 10 a day, add 2 per calendar day, ceiling 40.

- Today's cap is `min(maxPerDay, startPerDay + stepPerDay × UTC calendar days since the first send)`.
- The ceiling may never exceed `dailyLimit` (the policy schema refuses that), so a ramp can only slow a
  sender down, never widen one.
- No ramp at all keeps exactly today's behaviour: the flat `dailyLimit` every day.
- The first-send date is recorded once, under `DISPATCH_SENDER_FIRST_SEND#<sender>`, inside the same
  final reservation transaction that consumes the first daily cap, and is fenced by a condition check on
  every later reservation so a concurrent reservation cannot move it.
- The cap is enforced where the flat cap was already enforced: the shared final flight in
  `dispatchRepository.finishReservationPlan`. Over the cap throws `dispatch_cap_reached`, which the
  dispatch service closes as a hold.
- `GET /google/status?purpose=permitted_correspondence` carries
  `senderCap: { today, position: { day, startPerDay, stepPerDay, maxPerDay }, firstSendAt }` beside the
  grant, and Settings → Worker connection prints "Sender cap today: 14 of 40 (day 3 of ramp)."
  `senderCap` is absent when no cap policy is recorded for the granted mailbox; the desktop then says so
  rather than inventing a number. `position` is `null` for a flat cap.

## When the grant is missing

Send and reply-read both go through `RemoteGoogleAuthorization.authorizedAccess`. With no usable grant
that is a known, expected condition, not a failure: `dispatchService` closes the attempt as
`{ status: 'held', reason: 'mailbox_not_connected' }` — the same reason the territory sequence gives its
email steps (`TERRITORY_EMAIL_HOLD_REASON`). Nothing throws, nothing is marked sent, and a held step
stays held until David connects the mailbox. The worker modules that read the grant are
`dispatchService.ts` (send), `mailPoller.ts` (reply read), `sendReconciler.ts` (sent-lookup),
`dispatchRepository.ts` (grant conditions in the final transaction), `threadIntakeRepository.ts` and
`intakeBarrier.ts` (intake scope), `meetingCoordinator.ts` (availability) and `ownerCommandCoordinator.ts`.

## What is logged

Never a token, a refresh token, a client secret, an encryption key, an authorization code, an OAuth
`state` value, a PKCE verifier, or a provider response body. The worker logs its own short codes
(`google_unconfigured`, `google_grant_unavailable`, `google_provider_unavailable`,
`google_provider_rejected`, `oauth_state_unavailable`, `oauth_subject_mismatch`,
`google_secret_unavailable`) and route status codes. `/google/status` returns recorded grant metadata —
subject, verified email, granted scopes, capabilities, purpose, and now the sender cap — and no token
field of any kind. The worker tests assert exactly that on the handler's status reply and on the
persisted transaction log.
