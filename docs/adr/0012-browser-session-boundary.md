# 0012: Browser sessions reuse API identity without exposing device credentials

## Status and scope

Accepted for the local implementation slice authorized by David on October22 2026 at05:39UTC. This does not authorize hosted deployment, production data routing, provider configuration changes, new services or spending. The accepted desktop remains installed as fallback. Existing owner OFF, consent, channel, privacy and budget controls are unchanged.

## Decision

Use a small browser workspace with the existing React presentation and existing API/domain handlers. Do not introduce another framework, product engine or database. The first allowlist is Today, existing Firm reads and existing meeting-note read/save. Unsupported native operations remain explicitly unavailable. Discovery creation/link migration is deferred until durable pending-command custody is demonstrated.

The shared browser contract is `apps/web/src/shared/browserContract.ts`. Server dependency ownership is `apps/web/src/server/runtime.ts`. Every request obtains its own existing API/auth request connection through `withRequest`. No transaction, principal, Today/CRM projection, draft or authenticated response cache is shared between browser identities. Existing mutable Electron bridges must not be copied into process-wide web globals.

### Session custody

- Reuse `startSignIn`, `handleCallback`, `claimSignIn`, `authenticate` and `endSession`. Their existing OIDC state/nonce/PKCE/signature/domain, membership, expiry and revocation decisions remain authoritative.
- The browser adapter owns the callback URI in its injected server auth configuration. Local acceptance uses the existing injectable signed OIDC test-provider seam against an isolated disposable database, not a production auth bypass, real Google registration change or production credential.
- Starting sign-in creates a server-encrypted, authenticated, short-lived pending cookie holding the handoff secret and exact OIDC state. The callback must match that cookie's state before invoking the existing one-time callback/claim flow. Handoff and credentials never appear in browser JSON, script storage, URLs, logs or error pages.
- A successful claim discards the device secret. The browser receives only a server-encrypted/authenticated access-session cookie, HttpOnly, Secure, SameSite=Lax, Path=/, no Domain, with a host-prefixed name and expiry no later than the API access session. There is no browser device-secret renewal. At expiry, sign in again. Server key rotation invalidates cookies.
- Cookie contents are never trusted as current membership or authority. Every protected request invokes existing `authenticate`; every product route still runs its normal authentication and command guards. Logout invokes existing `endSession` before reporting confirmed sign-out, invalidates cookies and clears UI state even when the outcome is uncertain. Do not silently present a failed remote logout as confirmed revocation.

### Browser request boundary

- All browser API/session responses are private `Cache-Control: no-store`, with a self-only CSP, no credential-bearing redirects and fixed generic error bodies. Reject malformed/duplicate cookies rather than selecting an ambiguous session. Pin the configured origin, not a request Host header.
- State-changing requests require an exact allowed Origin and a session-bound unpredictable CSRF token carried in `x-callie-csrf`. Initial same-origin session GET can establish an anonymous CSRF cookie; sign-in itself is protected. Reject cross-site fetches and unsupported methods/content types. OIDC callback is the deliberate top-level navigation exception and is protected by exact state, pending-cookie binding and existing one-time consumption.
- Protected reads and commands include `x-callie-session`, equal to the current server-derived public revision (workspace/device/session/role). A stale tab may not dispatch a command under a replacement cookie. API Authorization, Cookie and origin headers cannot be supplied by browser operation payloads. Forward only closed selected API paths/methods, never arbitrary destinations.
- Browser session metadata includes only public identifiers, role, expiry, revision and CSRF token. No access token, device secret, OIDC code, pending handoff or provider credential is exposed to JavaScript.
- Browser client generation advances on logout, identity/role/revision transition and authentication refusal before subsequent awaits can publish. Check the captured generation before dispatch after waits and after response before effects. Clear all query/draft state and notify other tabs on transitions. Server validation, not a broadcast, remains authority. Do not automatically replay mutations after auth failure or uncertain network outcomes.

### First acceptance and durable action

Actual Chromium acceptance must use the real browser handler and existing authentication mechanics with a signed local OIDC provider and real disposable database records. No Electron process, UI-only fake login, injected principal or weakened production auth. Login -> Today -> existing synthetic Firm -> reload -> logout, then verify protected data unavailable, a second identity cannot see the first, expired/revoked membership/device/session refuses, CSRF/origin mismatch refuses and late responses cannot repopulate signed-out UI.

The next action is existing `/meetings/notes` on a synthetic meeting belonging to the existing synthetic Firm, read through `/meetings/outcomes`. Preserve the existing version/schema and standard command envelope/idempotency. Persist the non-secret pending command UUID and exact minimal draft only within the isolated local browser acceptance scope, bound to current public identity, before dispatch. Reconcile a lost response with the same command identity and normal readback, never silently mint another command. Verify reload, duplicate submission, lost response, revocation and logout clear/refuse behavior. Do not generalize this into discovery/link custody without a separate outcome.

## Qualified research extension, issue #740

October22 approved reversible local continuation extends the closed browser allowlist to retained, prepared candidate/run reads, one atomic qualified research Firm creation/link command, and additive Today V3 actions. Existing V1/V2 clients retain their schemas. Qualification is current server-owned source/identity/citation evidence under existing geography, not route eligibility or channel permission. Only current unambiguous ready cases are visible, unresolved cases remain internal. No acquisition, provider/inference, contact, route, enrollment, send, live Westrom replay or external rollout is included.

The new command retains IDs/revisions and its exact command UUID before dispatch, then its canonical createdFirmId on confirmed readback. Its per-tab storage contains no research prose, excerpts, addresses or citations. Bind storage to current public session identity/revision and an expiry no later than session expiry. Clear on expiry, identity/role/revision/logout/auth refusal and cross-tab invalidation. Never automatically replay. Explicit uncertain recovery uses the same UUID/payload under current authority, not display-name lookup or a replacement command. Source loss can make content unavailable without erasing an uncertain outcome. This does not broaden the synthetic notes retention policy or establish remote erasure of offline tabs.

Today V3 derives qualified-research actions from current canonical source links and revalidates the complete target on open. Opening shows current citations and a neutral discovery preparation question, not a fabricated promise, completed task, verified maintenance need or contact approval. Actual-browser acceptance must compose creation/link, queue open, exact IDs/citations, reload/response loss, ambiguity, expiry and revocation with the actual host/auth/domain and synthetic disposable records. Real private-data rollout remains separate.

## Ownership and validation

Root owns this ADR, shared browser contract, server runtime interface, workspace/toolchain integration and final review/acceptance. After the boundary commit, one auth/server owner writes `apps/web/src/server` excluding `runtime.ts`, one UI owner writes `apps/web/src/client`, and one local acceptance owner writes `apps/web/test/e2e`, local fixture/server helpers and Playwright configuration. Tests and helpers do not change production startup or auth to permit test login. Root integrates normal focused tests/types/lint/workflow/scoped secret scan and finished spec, standards and privacy reviews. Existing product acceptance remains open until actual useful business workflows succeed.
