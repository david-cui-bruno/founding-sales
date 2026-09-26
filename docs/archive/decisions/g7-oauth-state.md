# G7: the Gmail grant's state is signed, not stored

**Date:** 20 September 2026 · **Lane:** G7 gmail · **Spec:** 12.1, 12.2, Appendix G 27

## The problem

`GET /oauth/gmail/callback` is the one authenticated-user route in the API that
arrives with **no session**. Google redirects the browser there, and the browser may be
a different one, on a different machine, with no FSS cookie or bearer token. Something
in that request has to say, trustworthily, which workspace and which user consented —
and PKCE requires a `code_verifier` that matches the challenge sent at the start.

G2 solved the same problem for sign-in by storing a request row and looking it up
(`docs/archive/decisions/g2-oidc-request-lookup.md`).

## Decision

No row. The state is a signed, expiring token:

```
g1.<workspaceId>.<userId>.<expiryEpochSeconds>.<hmac>
```

HMAC-SHA256 over the first four fields with the deployment's state signing key,
compared in constant time. `verifyGrantState` refuses a bad signature, a malformed
token and an expired one identically. The PKCE verifier is *derived* from the state by
a second HMAC, so it is never stored either and never travels except as its own S256
challenge.

## Why this differs from G2

G2's sign-in state is **consumed**: the row is the replay defence, because a sign-in
code that is presented twice must fail the second time. A row is the natural way to
say "this has been used".

A Gmail grant does not need that, because Google enforces it. An authorization code is
single-use at the token endpoint; a replayed callback with the same code gets
`invalid_grant`, and the exchange fails before anything is written. What the state has
to carry is identity and freshness, and a signature carries both.

The cost of a row here is real: a table that exists only to be written, read once and
garbage-collected, on the path where a person is already waiting through two redirects.

## What the callback still checks, because a signature is not enough

A valid state proves the consent started here. It does not prove the person is still
entitled, so `completeGmailGrant` re-checks, in this order, and refuses if any fails:

* an **active membership** for that user in that workspace — a person removed between
  consent and callback connects nothing;
* a **refresh token** was actually issued — a grant with no refresh token is an hour
  of access and a mailbox that looks connected and is not;
* the **full** scope set was granted — Google lets a user uncheck scopes, and a
  partially granted mailbox is refused rather than half-connected;
* the **hosted domain** matches the workspace's;
* the address is **not already owned by another user** in this workspace.

## Bounds

Ten minutes (`DEFAULT_GRANT_SECONDS`). Long enough for a consent screen and an account
chooser, short enough that a state leaked into a browser history, a referrer header or
a screenshot is worthless by the time anyone finds it.

## What the page says

Nothing. Both outcomes are fixed HTML with no interpolation whatsoever — "Gmail
connected" or "Gmail not connected" — so no address, no state, no refusal reason and no
attacker-controlled string can reach the browser. The reason goes to the log.
