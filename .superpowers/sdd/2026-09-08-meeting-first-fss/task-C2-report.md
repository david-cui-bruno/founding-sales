# Task C2 report

**Status: DONE_WITH_CONCERNS (offline implementation, independent review and activation gates pending).**

Implementation commit: `717fb6778064d274f7f82c3bdbf54d96ff7ec0ea` (`feat: add scoped worker pairing and Google grant setup`). Committed with `git commit --only --` and an explicit 16-file ownership list. Resulting commit paths were inspected. No C1 repository/shared-contract, startup/schema/renderer or sibling-source writes.

## Ownership and coordination

Read the task brief, actual frozen `delegationContract.ts`, C1 `DynamoStore`/execution adapter and `task-C1-remote-report.md`. Interfaces were sent to root before C3 began. Root approved these exact additions to the original scope:

- `src/main/outreach/providers/providerValidation.ts`: optional strict local grant metadata, preserving legacy records.
- `tests/main/googleGrantCredentials.test.ts`: actual loopback and authenticated-encryption/private-temp-file tests.
- `cloud/lambdas/delegated-worker/build.mjs`: actual `src/handler.ts` entry to `dist/index.cjs`.
- Worker `package.json` and `package-lock.json`: root prepared pinned `@aws-sdk/client-ssm` **3.1124.0** offline. The proposed 3.1123.0 tarball was not cached. No installs were run by this worker.
- Narrow Mac-independent emergency request with durable replay mapping and explicit calendar-selection metadata were confirmed with root.

Original owned files implemented: worker `workerAuth.ts`, `remoteGoogleAuthorization.ts`, `googleGrantCapabilities.ts`, `handler.ts`, their two listed test files, `delegated-worker.tf`, appended `variables.tf`, and the three listed local provider files. This report is the only further owned documentation file.

## RED / GREEN evidence

Every npm/npx shell used:

```sh
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"
```

Behavioral RED observations, before implementation of the relevant behavior:

- Pairing/auth: **6 failures**, unimplemented durable issue/redeem/auth/revoke/fence methods.
- Remote OAuth/capabilities: **9 failures**, unimplemented grant/state/capability bindings.
- Remote cancelled refresh: **1 failure**, refresh resolved and replaced state despite cancellation.
- Actual handler: **2 failures**, missing command/production entry behavior. OAuth HTTP binding separately failed before its implementation.
- Local grant integration: **3 failures**, missing persisted metadata, scope downgrade accepted, strict schema rejected local grant records. Cancellation against the preexisting manager was already GREEN. Corrected the downgrade fixture to return a valid userinfo response, then observed the intended resolved-instead-of-rejected behavioral RED.
- Mac-independent emergency and calendar selection: **2 failures**, narrow emergency request rejected and calendar scope grant accepted without selected calendars.
- Local unexpected extra read scope: **1 failure**, unrequested powers were accepted.
- Optional Google outage: **1 behavioral failure**, production emergency returned 503 rather than reaching authenticated domain handling. A preceding missing-export error was scaffolding, not the behavioral RED.
- Local calendar selection: **1 failure**, browser opened before configuration refusal.

Final focused verification at 2026-09-09 01:01 UTC, one chained command, exit 0:

```sh
npm test --prefix cloud/lambdas/delegated-worker -- test/workerAuth.test.ts test/remoteGoogleAuthorization.test.ts
npx --no-install vitest run tests/main/googleGrantCredentials.test.ts tests/main/outreachProvidersOAuth.test.ts tests/main/outreachProviders.test.ts
npm run typecheck --prefix cloud/lambdas/delegated-worker
npx --no-install tsc --noEmit --target ESNext --module ESNext --moduleResolution node --esModuleInterop --skipLibCheck --noImplicitAny src/main/outreach/providers/providerTypes.ts src/main/outreach/providers/providerValidation.ts src/main/outreach/providers/googleOAuth.ts src/main/outreach/providers/credentialStore.ts tests/main/googleGrantCredentials.test.ts
npx --no-install eslint --no-ignore cloud/lambdas/delegated-worker/src/workerAuth.ts cloud/lambdas/delegated-worker/src/remoteGoogleAuthorization.ts cloud/lambdas/delegated-worker/src/googleGrantCapabilities.ts cloud/lambdas/delegated-worker/src/handler.ts cloud/lambdas/delegated-worker/test/workerAuth.test.ts cloud/lambdas/delegated-worker/test/remoteGoogleAuthorization.test.ts cloud/lambdas/delegated-worker/build.mjs src/main/outreach/providers/providerTypes.ts src/main/outreach/providers/providerValidation.ts src/main/outreach/providers/googleOAuth.ts src/main/outreach/providers/credentialStore.ts tests/main/googleGrantCredentials.test.ts --max-warnings 0
```

Results: **27 worker tests passed** (11 auth/handler, 16 OAuth), **29 local tests passed** (6 new C2, 6 existing OAuth, 17 existing credential/provider). Worker strict typecheck, scoped local typecheck and scoped lint passed. Scoped working/staged diff checks passed before commit. Existing regression files were run, not modified by C2.

Additional adversarial checks exercise actual C1 SDK requests using its existing conditional-request interpreter: two contenders both read the same unused bootstrap before redemption transactions, revocation after auth reads but before the real C1 commit, OAuth revocation during provider exchange, ciphertext transplantation across pairings, provider-revocation failure/retry, no log/HTTP exception-secret leakage, no tokens/verifiers in durable plaintext or Mac-facing status. These are synthetic SDK/provider-boundary tests, **not live DynamoDB race acceptance**. Local callback tests really use the temporary 127.0.0.1 HTTP listener and real protected-file store, substituting only browser/provider and OS encryption boundaries.

### Root-owned checks

Root reported actual handler prebuild/typecheck/build passed in task `576672du31`, producing a **3.1 MB CJS bundle** with the existing forbidden-desktop-dependency resolver guard active. Worker did not run package/native/full builds. Root applied Terraform formatting to the owned file, then fmt/parse passed. Root's Terraform 1.15.8 `validate -no-color` failed solely because this checkout lacks the installed `hashicorp/aws` and `hashicorp/archive` providers. See root `C2-terraform-validate.log`. **Provider-schema validation remains pending.** No init, backend/state or cloud access was performed. Assembled final package and independent review remain root-owned.

## Stable exported interfaces

### `workerAuth.ts`

- `WorkerAuth(options: RepositoryOptions)` uses actual C1 `DynamoStore`. No constructor I/O/client/profile lookup.
- `issuePairing({scopes: WorkerScope[], expiresInSeconds:number}): Promise<{code,pairingId}>` is **trusted operator composition only**, never an HTTP route. Maximum lifetime 600 seconds.
- `redeemPairing(code, rateLimitKey): Promise<PairingGrant>` returns `{pairingId,workspaceId,credential,emergencyCredential,scopes,generation}`. Both credentials are independent 32-random-byte bearer values. Bootstrap, credential and emergency secrets are stored only as hashes. Redemption transaction consumes bootstrap and creates pairing/two token rows atomically. Ambiguous response fails closed, never recovers a plaintext secret.
- `authenticate(authorization, required): Promise<WorkerPrincipal>` strongly checks credential/pairing generation each time. Principal includes credential hash, not its bearer.
- `fencedDynamo(principal): DynamoAdapter` adds fresh token/pairing condition checks to actual C1 mutation transactions. No stale authorizer cache or C1 contract changes. Leaves a 98-item domain transaction ceiling.
- `revokePairing(pairingId): Promise<void>` increments generation and revokes both device/emergency credentials and access to this pairing's remote grants/state. Does not switch execution to the Mac.
- `emergencyCommand(principal,input): Promise<DelegationCommand>` resolves the narrow `{commandId,accountId,kind:'pause'|'revoke',reason}` against actual C1 authority. Durable request fingerprint/canonical command mapping preserves exact replay despite later authority versions. Missing authority never bootstraps. A stale intent fails closed rather than silently rebasing.
- Scopes: `commands:write`, `events:read`, `google:grant`, `pairing:revoke`, `emergency:stop`. Emergency receives only the final scope.

### `googleGrantCapabilities.ts`

- `GoogleCapability = 'send'|'relevant_read'|'availability'|'event_write'`.
- `GoogleGrant = {provider:'google',subject,email,grantedScopes,owner:'local'|'remote',purpose:'permitted_correspondence',capabilities,calendars?}`.
- `GoogleCalendarSelection = {ownedCalendarId,conflictCalendarIds,confirmed:true}`. Confirmation is explicit operator selection, **not a claim that live calendar access has been tested**. C5 must verify exact resource access before actions.
- `googleGrantSchema`, `googleCapabilitySchema`, `googleCalendarSelectionSchema`, `googleScopes`, `capabilitiesForScopes`, `requireCapabilities(grant,required)` and `googleGrantDisclosure` are exported. Missing grant or a claimed capability absent from actual scopes is denied.
- Scope mapping is exactly Gmail send/read-only, Calendar freebusy/events.owned. No full Calendar, ACL or whole-mailbox processing authorization. These are technical powers, never consent to unsolicited email.

### `remoteGoogleAuthorization.ts`

- `new RemoteGoogleAuthorization({auth,config?:RemoteGoogleConfig,fetch?})`.
- `RemoteGoogleConfig = {clientId,clientSecret,redirectUri,encryptionKey:Buffer}`. Remote-only HTTPS callback and a 32-byte key are required before use.
- `beginGoogleGrant(pairingId,capabilities,calendars?): Promise<{authorizationUrl}>`. Calendar powers require explicit confirmed selection. Requested capabilities alone never imply actual grant. State stores expiry, pairing generation, expected existing grant revision/subject and encrypted PKCE verifier. AES-256-GCM authenticates workspace, pairing, purpose and envelope version.
- `completeGoogleGrant(state,code:string|null): Promise<GrantStatus>`. Durable single-use claim precedes provider exchange. Null code consumes/cancels only this state and preserves prior grant. Token/userinfo replies determine actual scopes/verified subject. Missing/unapproved scopes or changed subject cannot replace prior credentials. Final token write is pairing/grant-revision fenced.
- `status(pairingId)` and `revokeGoogleGrant(pairingId)` return `GrantStatus = {state:'unconfigured'|'ready'|'revoked',grant:GoogleGrant|null,providerRevocation?:'confirmed'|'pending'}`. Status never includes tokens. Remote Google revocation first invalidates durable local grant/state, then attempts Google token revocation. Failure remains honestly pending and retryable with encrypted tokens inaccessible to execution.
- `authorizedAccess(pairingId,required,signal?): Promise<{accessToken,grant}>` is **remote-only**, not an HTTP route. Checks pairing/capabilities before provider refresh, pins actual subject/scopes, persists rotated tokens with CAS, and does not replace them after observed cancellation. C3 prepares access **before its final action fence**, and must not cache it as continuing authority or bypass suppression/approval checks. No transport is exposed here.

### Actual handler / production binding

- `createWorkerHandler({auth,host,google?})` handles bounded API Gateway v2 requests with exact HTTPS host/protocol, Authorization header auth, no bearer query parameters and static redacted errors.
- Routes: `POST /pairing/redeem`, `POST /pairing/revoke`, `POST /commands`, `POST /emergency`, `GET /events`, `POST /google/begin`, `GET /google/status`, `GET /google/disclosure`, `POST /google/revoke`, `GET /oauth/callback`.
- `/google/begin` accepts `{capabilities,disclosureVersion:'google-grant-v1',calendars?}`. Pairing identity comes only from authenticated context. Callback can only finish its bound grant and returns static no-store/no-referrer text, never command dispatch or tokens.
- `createProductionServices(env,boundaries?)` instantiates real DynamoDB/SSM clients, real WorkerAuth/RemoteGoogleAuthorization and handler. Tests replace only `dynamo.send`, `ssm.send`, and provider fetch. SSM requests exact per-workspace paths with `WithDecryption:true`, accepts only SecureString, and never creates a cloud credential from test interfaces.
- `createProductionHandler(env,boundaries?)` and exported Lambda `handler(event)` are default-disabled. Pairing/emergency/events do not depend on optional Google/SSM availability. Optional Google absence does not activate network/provider setup. No automatic bootstrap, OAuth, polling, send or calendar invitation occurs.
- Required activation env: `DELEGATED_WORKER_ENABLED=true`, `DELEGATED_WORKER_TABLE`, `DELEGATED_WORKSPACE_ID`, `DELEGATED_WORKER_HOST`, `AWS_REGION`. Optional Google setup requires all three of `DELEGATED_GOOGLE_CLIENT_ID`, `DELEGATED_GOOGLE_SECRET_PARAMETER`, `DELEGATED_GOOGLE_KEY_PARAMETER`. SecureString key is standard-base64 32 random bytes. Paths are beneath `/delegated-worker/<workspace>/`.

### Local credentials

`GmailCredentials.grant?` is strict optional metadata for backward compatibility. `authorizeGoogle` defaults to the existing send-only flow and optionally accepts explicit capabilities/calendars. It returns actual verified subject/scopes/capabilities with local ownership. The existing provider manager now persists that metadata through the actual CredentialStore. Remote grant envelopes are rejected locally. Changed subject and silent capability downgrade cannot overwrite an existing local grant. Cancellation/denial keeps the previous encrypted file byte-for-byte intact. Explicit disconnect remains local disconnect, not remote revocation.

## Infrastructure and remaining activation gates

1. Independent C2 review, assembled root/native/package checks and Terraform provider-schema validation. No validation shortcut substitutes for these.
2. Explicit cloud provisioning approval. `delegated_worker_enabled=false` and `delegated_worker_activation_reviewed=false` by default. No new schedule resource and no edits to existing schedules. Dedicated table is encrypted/PITR/deletion-protected, logs are seven-day metadata-only, API throttles and concurrency are bounded. IAM is scoped to the dedicated workspace table and two exact secure-parameter paths. Terraform contains no secret values.
3. Review actual regional costs and workload assumptions against approximately $20/month incremental non-AI budget. Comments are a bounded planning envelope, not a verified quote or hard spending cap. Polling/models/research/cold transport are not implicitly included.
4. Live two-client DynamoDB redemption/state/command-fence races and crash/response-loss acceptance require separate authorization. Offline conditional interpreter cannot establish distributed service behavior.
5. Provision the separate remote Google app, reviewed SecureStrings and key recovery/rotation procedure. This version has one configured envelope key, not automatic multi-key rotation. No live accounts, OAuth, credentials, OS/profile access or external provider/network calls were used during implementation. The only actual sockets were fictional local loopback fixtures.
6. Before a user grant, review restricted Gmail scope/verification for the actual private/personal deployment, app-limited processing, model data transfer and retention, Testing-token lifetime, owned/conflict-calendar access and any separately requested shared-calendar scope. No exemption is asserted. Disclosure is available on the authenticated route and acknowledged before begin.
7. C3/C5 must bind relevant-thread/calendar resources and final exact approval/suppression/permission/authority checks. C6 must integrate Mac pairing/status securely. The production HTTP layer intentionally has no mail or meeting-dispatch endpoint at C2. Tokens must remain remote. Cold sender eligibility/consent remains a separate gate from OAuth configuration.
8. Emergency credential must be securely recorded outside the Mac during pairing. Emergency revokes/pauses remote account authority without local sender fallback. Pairing revocation and Google-grant revocation are distinct from local disconnect.

No purchases, deployments, installations, subagents, full/native/package builds, real recipients or live account operations were performed by C2.
