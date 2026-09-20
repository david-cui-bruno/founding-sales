# G2: the one table with no workspace-scoped lookup key

**Spec silence.** Section 6 requires every repository operation to go through a typed
workspace scope. The sign-in flow has two moments where there is no scope to be had,
because there is no authenticated caller yet:

* Google redirects an **anonymous browser** to `/auth/google/callback` carrying
  nothing but `state` and `code`;
* the desktop app calls `/auth/sign-in/claim` **before it has a session**, carrying
  nothing but the handoff secret it generated.

**Decision.** `oidc_authorization_requests` is the one table looked up by a key that
does not begin with `workspace_id`. It is deliberately absent from
`FOUNDATION_LOOKUP_KEYS`, so `selectOne(context, 'oidc_authorization_requests', …)`
does not typecheck and nobody reaches it through the scoped helpers by accident; the
two statements that read it are written out in `signIn.ts` with this note named in a
comment.

**What makes it safe.**

* Both keys are digests of 256-bit random values. `state_hash` is the primary key and
  `handoff_hash` is unique; neither is guessable and neither is derived from anything
  a caller supplies.
* Both are single use, and the single-useness is a conditional `UPDATE … WHERE status
  = 'pending'` rather than a check followed by a write. A replayed `state` changes no
  row, so it never reaches Google — `scenarios.test.ts` asserts the token-exchange
  count does not move.
* The row carries the `workspace_id` it was started for, with a foreign key to
  `workspaces`. Everything after the lookup is scoped by that column: membership is
  checked against it, the device is registered into it, the session belongs to it.
* The row holds no secret at all. `state_hash`, `nonce_hash`, `handoff_hash` and the
  PKCE challenge are digests; the verifier is derived and never stored (see
  `g2-pkce-verifier-derivation.md`).
* It expires. Ten minutes, enforced by `expires_at` in the `WHERE` clause of both
  consuming statements, not by a sweep that might not have run.

**What it is not.** It is not a precedent for business tables. Every table this lane
added that a caller can reach after authentication — `sessions`,
`device_refresh_credentials` — is scoped, declared in `FOUNDATION_LOOKUP_KEYS`, and
checked against a real unique index by `test/db/workspaceScope.test.ts`.
