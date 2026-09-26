# G2: a credential names its own workspace

**Spec silence.** Section 6 is emphatic: "Every repository operation uses a typed
workspace scope; no method accepts a bare object ID; lookup uniqueness includes the
workspace." Section 5.3 requires bearer sessions and a device-bound refresh
credential. It does not say how the two meet, and they are in tension: a bearer token
arrives before there is a scope, so looking one up is by definition a lookup without
a workspace.

**The options.** Either the token hash is globally unique and the lookup is
`WHERE access_token_hash = $1` — the exact shape section 6 forbids — or the workspace
arrives with the token.

**Decision.** Both credentials are structured and name their workspace in the clear:

```
access token        fssa1.<workspace uuid>.<43-character secret>
refresh credential  fssr1.<workspace uuid>.<device uuid>.<generation>.<43-character secret>
```

The API parses the prefix, reads the workspace id, and every lookup that follows
begins with `workspace_id` — so `sessions` is unique on `(workspace_id,
access_token_hash)` and `device_refresh_credentials` has the primary key
`(workspace_id, device_id, generation)`, both of which `FOUNDATION_LOOKUP_KEYS`
declares and `test/db/workspaceScope.test.ts` checks against real unique indexes.

**Why this is safe.** A workspace id is an identifier, not a secret; it is in every
response body the Mac already holds. Naming it buys nothing for an attacker: the
entropy is the 256-bit secret, which is unchanged, and the hash comparison is
`timingSafeEqual` over digests of equal length. Naming it costs an attacker one thing
though — a credential from workspace beta cannot be replayed at workspace alpha by
editing the prefix, because the row is keyed on the pair and there is no row at the
crossing. `identity.test.ts` proves that with a forged credential built from beta's
secret and alpha's workspace id.

**The version prefix.** `fssa1` and `fssr1` exist so that a future change to the
credential format is a new prefix rather than a guessing game, and so that a log line
that accidentally contains one is greppable.

**What would change this.** Row-level security, which section 6 names as "a mandatory
release gate before any second external workspace is created", would set the workspace
from a session variable rather than from a parameter. The prefix would still be how
that variable is populated, so this shape is what RLS is built on rather than
something RLS replaces.
