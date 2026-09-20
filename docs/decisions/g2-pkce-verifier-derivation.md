# G2: the PKCE verifier is derived from the state, not stored

**Spec silence.** Section 5.1 requires PKCE. It does not say where the code verifier
lives between the authorization request and the token exchange, which on this design
are two different HTTP requests handled by two different API tasks.

**The options.** Either the verifier is written to the `oidc_authorization_requests`
row and read back at the callback, or it is recomputed. Writing it means a plaintext
value sits in the database for up to ten minutes that, together with a stolen
authorization code, completes a sign-in. The database is encrypted at rest and the row
is short-lived, so this is not a disaster — but it is a secret at rest that does not
have to exist.

**Decision.** The verifier is `base64url(HMAC-SHA256(stateSigningKey, state))`. The row
stores `sha256(state)` and the S256 challenge and nothing else. At the callback the API
has the `state` from the query string and the key from Secrets Manager, so it
recomputes the verifier, uses it, and discards it.

**Why this is still PKCE.** PKCE binds the token request to the authorization request.
The binding here is the HMAC key: an attacker with the authorization code and the
state still cannot produce the verifier without the key, and the key is never in the
database, never in a log and never in this repository. The property PKCE provides —
that possession of the code alone is not enough — is preserved.

**What it costs.** One more secret to rotate. Rotating the state-signing key
invalidates every sign-in that is mid-flight, which is at most ten minutes of them,
and the failure is a clean `token_exchange_failed` rather than anything worse. The
key is 32 random bytes and lives beside the Google client secret.

**What would change this.** If the API ever needs to support a provider that issues
the verifier itself, or if the key rotation story becomes more awkward than the row,
store the verifier in the row and encrypt it with the same envelope key the Gmail
refresh tokens use. The column would be additive and the rest of the flow unchanged.
