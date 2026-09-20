# Google sign-in is configured, or the API refuses to start

**Lane:** G12b · **Spec:** 5.1, 5.3, Appendix G 23 · **Files:** `apps/api/src/bootstrap/{deployment,main}.ts`, `test/release/scenario23.check.ts`

## What was open

G12 left `ApiOptions.auth` absent and wrote down why: "an OIDC client half-built by a
release lane is worse than one that is honestly missing", so the API served `/healthz`,
`/readyz` and the client-version notice and refused everything else. That was the right
call for a lane whose brief did not name identity. It is the wrong state to ship,
because from outside it is indistinguishable from a working deployment: the load
balancer is healthy, `/readyz` is 200, and every command answers a refusal. Nobody can
sign in and nothing says so except a boolean in a startup line that did not exist.

## The decision

A live API builds G2's `AuthDeps` at startup or exits `configurationInvalid`. Four
inputs, none defaulted:

| Part | Source | Missing |
|---|---|---|
| Client id and secret | `google-oidc-client`, as `{"client_id","client_secret"}` | `MISSING` or `INVALID`, naming the entry |
| Redirect URI | derived, `FSS_PUBLIC_ORIGIN` + `/auth/google/callback` | `MISSING` on the origin |
| Hosted domain | `FSS_GOOGLE_HOSTED_DOMAIN`, with the secret as one-release fallback | `MISSING`, naming both places |
| PKCE/state HMAC | `session-signing-key`, base64 bytes ≥ 32, PEM refused by name | `MISSING` or `INVALID` |

Four things are **constants rather than configuration**: the issuer
(`https://accounts.google.com`), the discovery URL, the 60-second clock skew, and the
four session lifetimes of 5.3 (an hour, 30 days, 30 days, ten minutes). `createGoogleClient`
already refuses a discovery document whose `issuer` differs and any endpoint it names
at another origin, so making the issuer settable would only widen what a deployment can
be pointed at, for no operational need anybody has.

### The redirect is derived, not configured

`https://api.usecallie.com/auth/google/callback` and
`https://api.rehearsal.usecallie.com/auth/google/callback` are the two URIs registered
with the `fss-greenfield-oidc` client, and both are the API's own origin plus a fixed
path. Deriving it from `FSS_PUBLIC_ORIGIN` means the string in the Google console and
the string the token exchange sends cannot disagree — a mismatch that Google reports as
`redirect_uri_mismatch` and that is otherwise found by trying to sign in. The Gmail
lane derives its redirect the same way, from the same origin.

### The sign-in client is not the Gmail client

Two registrations, two secrets, two scope sets: 5.1 keeps the `openid email profile`
grant and the `gmail.readonly gmail.send` grant apart, and revoking Gmail must not end
FSS login. Pasting one client into both entries is a mistake an operator can make in
thirty seconds, and it fails at the first sign-in because `validateIdToken` requires
`aud` to be exactly the configured sign-in client id. The API test asserts the two ids
differ in the fixture, which is a weak check of a real distinction — the strong one is
Google's.

### A rehearsal names its own client

`FSS_DEPENDENCIES=recorded` refuses to start without `options.signInClient`, exactly as
G12 made it refuse without `options.pushVerifier`, and for the same reason: a rehearsal
that fetched `accounts.google.com`'s discovery document and key set would be testing
Google's availability rather than the release. Falling back to the real client "because
none was supplied" is the shape of accident this whole file exists to prevent.

Note what this means in practice: the production image cannot be run with
`FSS_DEPENDENCIES=recorded`, because `bootstrap/main.ts` passes neither fake. That is
deliberate. The recorded branch is for a caller that constructs the deployment in
process — the tests, and any future harness — and a rehearsal that wants the real
sign-in path uses `live` with the rehearsal hostname, which is why that hostname is the
client's second registered redirect URI.

## `--selftest` names parts, never values

`describeDeployment` reports `sign_in` (`google | fixture | absent`) and four booleans:
client, secret, redirect, hosted domain, plus `session_signing_key_configured`. Not the
client id, not the redirect URI, not the domain — all three are public identifiers, but
"this line carries no operator-supplied string" is a rule that survives the next person
adding a field, and "these particular strings happen to be public" is not. The test
feeds the reader a generated marker as the secret and a recognisable client id and
asserts neither appears.

## Where the assertion lives

`test/release/scenario23.check.ts`. Appendix G 23 is the four OIDC replay refusals, and
every one of them is dead code in a deployment that has no sign-in at all — so the
precondition belongs beside them rather than in a scenario of its own. The check has a
positive control first (the complete environment yields a configured sign-in with the
derived redirect), one case per removed input, the three dependency-switch refusals,
and one source assertion that `bootstrap/main.ts` actually hands what it built to
`createApiServer`. That last one is the falsifiable half: a bootstrap that built
`auth` and dropped it would satisfy everything else on this page.
