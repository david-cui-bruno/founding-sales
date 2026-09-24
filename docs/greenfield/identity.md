# Identity: sign-in, sessions, devices, commands and audit

Specification revision 3, sections 5.1, 5.2, 5.3, 6 and 14, and Appendix G 23, 24 and
40. This is how a person gets into Callie and how the API decides, on every single
command, that they may still be there.

## The short version

A Callie Google account, in the system browser, with PKCE and one-time state and
nonce. The API's own HTTPS endpoint is where Google sends the browser back. The Mac
collects its grant with a secret it generated itself. After that the Mac holds three
things: a device secret, an access token good for an hour, and a refresh credential
that rotates every time it is used. Reuse of a spent credential revokes the device.
Membership and device revocation are checked on every command. Every mutating command
carries an id, and its receipt commits with the mutation.

## Sign-in, move by move

```
Mac                         API                         Google (system browser)
 |  POST /auth/sign-in/start |                           |
 |-------------------------->|  row: sha256(state),      |
 |  { authorizationUrl,      |       sha256(nonce),      |
 |    handoffSecret }        |       sha256(handoff),    |
 |<--------------------------|       S256 challenge      |
 |                                                       |
 |  shell.openExternal(authorizationUrl) ----------------->|
 |                                                       |  person signs in
 |                           |  GET /auth/google/callback |
 |                           |<---------------------------|
 |                           |  consume state row,        |
 |                           |  exchange code (PKCE),     |
 |                           |  validate id token,        |
 |                           |  require membership        |
 |                           |  --> status = authenticated|
 |  POST /auth/sign-in/claim |                           |
 |-------------------------->|  consume row again;        |
 |  { grant }                |  mint device secret,       |
 |<--------------------------|  access token, credential  |
```

Why the API's callback rather than a loopback port or a `callie://` scheme:
`docs/decisions/g2-redirect-target.md`, which is also the note that says exactly which
OAuth client David creates and with which redirect URIs.

### How a deployed API is given all this

`apps/api/src/bootstrap/deployment.ts` builds `AuthConfig` at startup and
`bootstrap/main.ts` adds the database session, the clock and the random source. Four
inputs, none of them defaulted:

| Part | Where it comes from |
|---|---|
| Client id and secret | the `google-oidc-client` Secrets Manager entry, injected by the ECS `secrets` block as `{"client_id": "...", "client_secret": "..."}` |
| Redirect URI | derived: `FSS_PUBLIC_ORIGIN` + `/auth/google/callback`, so it equals the URI registered with Google rather than being configured twice |
| Hosted domain | `FSS_GOOGLE_HOSTED_DOMAIN`, the `google_hosted_domain` root variable — the same value the mailbox check uses, so the two cannot disagree |
| PKCE/state HMAC | `session-signing-key`, base64 bytes, 32 or more, PEM refused by name |

Issuer, discovery URL, clock skew and the four session lifetimes are constants, not
configuration: `createGoogleClient` already refuses a discovery document whose `issuer`
differs and any endpoint it names on a host the rule below does not admit, so making
the issuer settable would only widen what a deployment can be pointed at.

### Where the discovery document may send the API

The issuer is `https://accounts.google.com` and the discovery document is read from
`https://accounts.google.com/.well-known/openid-configuration`. The document names the
authorization endpoint, the token endpoint and the key set, and the API uses what it
names — so the document is also the thing an attacker would forge, to send the token
exchange (which carries the code and the client secret) to their own host.

`endpointAllowed` in `apps/api/src/auth/googleClient.ts` is the rule. Each of the three
endpoints must be **`https:`, on either the issuer's own hostname or a hostname ending in
`.googleapis.com`**, Google's documented API hosts. The document's `issuer` must equal the
configured one exactly. Anything else, and a URL that does not parse, makes `discovery()`
answer null. The issuer's exact origin is also admitted, which in production is the same
`https://accounts.google.com` and is plain HTTP only for the loopback provider the tests
start.

Google's own document is why the rule is not "the issuer's origin". As published on 24
September 2026 it names:

| Field | Value |
|---|---|
| `authorization_endpoint` | `https://accounts.google.com/o/oauth2/v2/auth` |
| `token_endpoint` | `https://oauth2.googleapis.com/token` |
| `jwks_uri` | `https://www.googleapis.com/oauth2/v3/certs` |

The first version of this rule required all three to share the issuer's origin. It
refused Google's real document, and production's first four real sign-ins were refused
`token_exchange_failed` (release runbook 8.0u). `apps/api/test/auth/discovery.test.ts`
now runs against that document's shape, with the production issuer and discovery URL,
and `test/release/scenario23.check.ts` holds the same rule in the release suite.

**What a failure logs.** Two `warn` lines, through the API's structured log, which
never carry a code, a verifier, a token, the client secret or a response body:

* `event: "oidc_discovery_unavailable"`, `step: "sign_in_start"`: discovery answered null
  when a sign-in started. Start falls back to `<issuer>/o/oauth2/v2/auth` so the browser
  leg still works — which is exactly how the first failure stayed hidden until the
  callback — and now says that it did.
* `event: "token_exchange_failed"` at the callback, with `reason` one of
  `discovery_unavailable`, `token_endpoint_status_<n>` or `id_token_absent`, and
  `provider_error` carrying Google's own `error` code (`invalid_grant`, `invalid_client`,
  `redirect_uri_mismatch`, …) when the token endpoint answered JSON with one. Never
  `error_description`.

The audit row the refusal writes (`auth.sign_in_refused`, `refusal: token_exchange_failed`)
says *that* the exchange failed; the log line says why.

**A live deployment that is missing any of the four refuses to start.** Before G12b it
started without them and mounted no identity at all, which looks from outside exactly
like a working API that refuses every command. The startup line and `--selftest` name
each part — `sign_in`, `sign_in_client_configured`, `sign_in_redirect_configured`,
`sign_in_hosted_domain_configured`, `session_signing_key_configured` — as booleans and
a closed vocabulary, never a value, not even the public client id. A rehearsal selects
its own sign-in client explicitly, for the same reason it selects its own push
verifier: a rehearsal that fetched Google's key set would be testing Google's
availability. See `docs/decisions/g12b-sign-in-is-configured-or-the-api-refuses.md`.

### What makes each replay fail

| Replay | Why it fails |
|---|---|
| A `state` we never issued | No row with that digest. |
| A `state` already used | The consuming `UPDATE` has `status = 'pending'` in its `WHERE`, so the second callback changes no row — and never reaches Google. |
| An id token carrying another request's `nonce` | The row's `nonce_hash` is compared to `sha256(nonce)` from the token. |
| The authorization `code` again | Google answers `invalid_grant`; the API answers `token_exchange_failed` and logs `reason: token_endpoint_status_400`, `provider_error: invalid_grant`. |
| A token minted for another `aud` or `azp` | Both are compared to the configured client id, and `aud` must be exactly it — an array with a second audience is refused. |
| A handoff secret twice | The claim's `UPDATE` has `status = 'authenticated'`; the second is `already_claimed`. |

Every one of those has a test in `apps/api/test/auth/scenarios.test.ts`.

### What the id token must say

Issuer — the configured `https://accounts.google.com`, or `accounts.google.com`, the two
forms Google documents and nothing near them — audience, `azp` where present, RS256
signature against Google's current published keys, `exp`/`iat`/`nbf` within the
configured skew, the request's nonce, `email_verified = true`, `hd` equal to the
configured Workspace domain, and a `sub`.
`sub` is the durable identity; email is display data and is deliberately not unique in
the `users` table, because two Callie people may share an alias and a changed address
must not create a second account.

An unrecognised `kid` refreshes the key set once, no more often than a minute, which
is what a real Google rotation looks like from here. `alg` must be `RS256`: nothing
unsigned ever has its claims read, so `alg: none` cannot argue its way past the issuer
check.

**A domain account alone is not access.** The `users` row is created on first
successful sign-in, and then an active `workspace_memberships` row is required — at
the callback, again at the claim, and again on every command.

**So somebody has to write the first membership, and it is an operator, once.** Those
three rules are circular on a new deployment: sign-in refuses without the workspace,
refuses again without an active membership, and is the only thing that writes the
`users` row. `fss admin workspace bootstrap` breaks the circle from outside —
`infra/scripts/release-bootstrap-workspace.sh`, run as a one-off task under the runtime
credential (release runbook 5.1a) — and creates the workspace, the first admin's `users`
row and an active `admin` membership in one idempotent transaction. The real Google
`sub` cannot be known before that person signs in, so the row is written with
`google_sub = 'pending-email:<lowercased address>'`; the sentinel prefix is the single
exported constant `PROVISIONAL_GOOGLE_SUB_PREFIX` in `@fss/contracts`, and no Google
`sub` can collide with it because a `sub` is a decimal string of digits. The **first**
successful sign-in with that address replaces the sentinel with the real `sub` and
records `auth.provisional_user_adopted`; an address that already has a real account is
never overwritten, because the statement carries a `NOT EXISTS` guard, and a sign-in by
anybody else adopts nothing. Adoption changes *which row* the sign-in finds and grants
nothing: the membership check still decides, at the callback, at the claim and on every
command. `docs/decisions/g39-the-first-workspace-and-its-admin-are-bootstrapped.md`.

## What the Mac holds

| Thing | Where | Lifetime |
|---|---|---|
| Device secret | macOS Keychain | Until the device is revoked |
| Refresh credential | macOS Keychain | Rotates on every use; 30 days at the outside |
| Access token | Memory | About an hour |
| Device record (ids, label, API address) | `device.json`, mode 0600 | Until sign-out |
| Today list | `today.cache`, AES-256-GCM | 24 hours |

Server-side, all three secrets exist only as sha256 digests, and the `CHECK`
constraints in migration 0003 refuse anything that is not one — so a plaintext
credential cannot be written by mistake.

The credentials name their own workspace (`fssa1.<workspace>.<secret>`), which is what
lets an unauthenticated lookup still begin with `workspace_id`:
`docs/decisions/g2-session-token-shape.md`.

## Renewal, and what reuse means

`device_refresh_credentials` has one row per generation and a partial unique index
that allows exactly one `active` row per device. A renewal spends the old row
(`rotated`, with `used_at`) before the new one exists, so a rotation that forgot to
spend the old one cannot commit.

Presenting a `rotated` generation is reuse: the device is revoked, its sessions end,
its live credential is spent, and a full Google sign-in is required. Presenting a
`revoked` one is not reuse — it was taken away deliberately, by an admin, a sign-out
or a membership ending — and says `credential_unknown`.

The Mac serialises renewal for exactly this reason. Four views noticing an expired
session at the same moment share one in-flight promise, so the credential is presented
once. `apps/desktop/test/desktop.test.ts` asserts the renewal count.

The 30-day boundary lives on the session as `reauthenticate_after` and is carried
forward unchanged by every renewal, so the chain cannot extend itself. Both the access
session and the refresh credential are clipped to it.

## Commands

`runCommand` in `apps/api/src/auth/commands.ts` is the only way a mutation happens.
It checks the client version, builds the workspace scope from the verified principal,
hashes the payload canonically, runs the route's work and writes the receipt in one
transaction.

* Same id, same payload, same device: the original result, `replayed: true`.
* Same id, different payload: `command_payload_mismatch`.
* Same id, different device: `command_device_mismatch` — and the database enforces it,
  because `(workspace_id, command_id)` is unique
  (`docs/decisions/g2-command-id-uniqueness.md`).
* `authorize_dial`: the receipt carries no result at all, so a replay is never
  actionable. Migration 0001 refuses a row of that kind that has one.

**A pre-flight refusal writes no receipt.** An outdated client, a revoked device, an
inactive membership — none of those reached a command, so none of them consumes its
id. That is what makes the upgrade path work: the Mac updates and retries the same
command id, and it is still free.

## The client-version range

`GET /auth/client-version` is readable by anyone, at any version, with no session. It
is the one thing an outdated client may read, and it says what to install. Everything
else an outdated client tries — starting a sign-in, claiming, renewing, any command —
is `client_upgrade_required` with HTTP 426.

The Mac enforces the same rule locally so that it does not offer a person a button
that cannot work, but the API is the authority and checks independently.

## Audit and the read matrix

`audit_events` is append-only by privilege: `UPDATE`, `DELETE` and `TRUNCATE` are
revoked from both application roles in migration 0001. Sign-ins, sign-in refusals,
device revocations, membership changes and deactivations all write one.

`decideSensitiveRead` is Appendix F as a pure function: an admin may read anything,
and every admin read of a row they are not the assignee or mailbox owner of is
audited; a salesperson reads only their own, and those are ordinary work. Message
bodies, drafts and mailbox diagnostics do not exist yet — the rule that will govern
them does, so the slice that adds them inherits it.

## Where everything is

```
apps/api/src/auth/config.ts        what identity needs that is not a row
apps/api/src/auth/googleClient.ts  discovery and its endpoint-host rule, JWKS with caching and rotation, token exchange
apps/api/src/auth/idToken.ts       every claim the specification names, each its own refusal
apps/api/src/auth/signIn.ts        start, callback, claim
apps/api/src/auth/sessions.ts      devices, sessions, rotation, reuse, revocation
apps/api/src/auth/commands.ts      the command middleware every later route uses
apps/api/src/auth/audit.ts         append-only events and the read matrix
apps/api/src/routes/auth.ts        the six routes above
apps/api/src/routes/admin/         memberships and devices
packages/contracts/src/auth.ts     the wire contract and the closed refusal set
packages/domain/db/migrations/0003_identity.sql
apps/desktop/                      the Mac
```

## Running the tests

```
npm run gate:greenfield       # everything, including the desktop rules
npm run test:desktop:e2e      # the window, in chromium
```
