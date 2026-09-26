# G2: where Google sends the browser back, and what David must create

**This note contains the answer David needs to create the OAuth client. The short
version is in the first two lines of "What to create".**

## The question

The brief asked lane G2 to "decide loopback versus custom scheme and write the
decision note". The specification answers it differently from either option, so this
note records the third answer and why the spec wins.

## What the specification says

Section 4.1 lists what the API serves: "HTTPS API, **Google sign-in callback**, Gmail
OAuth callback, and Gmail Pub/Sub webhook." The sign-in callback is an API endpoint,
not something on the Mac. Section 5.1 adds that the flow runs "in the system browser
with authorization code, PKCE, one-time state, and one-time nonce", and section 5.3
says the client "never holds Google credentials beyond its own session and device
credential".

Those three sentences together rule out both options the brief offered:

* **Loopback** (`http://127.0.0.1:<port>/callback`, RFC 8252) puts the callback on the
  Mac. The authorization code would then arrive at the client, which would have to
  send it on to the API — the client handling a Google credential, however briefly,
  which 5.3 says it does not do. It also means the app runs a listening socket that
  any local process can reach while a sign-in is open.
* **A custom scheme** (`callie://auth`) is worse on this Mac specifically: scheme
  registration on macOS is first-come and not exclusive, so another application can
  register the same scheme and receive the authorization code. There is no way for
  Google, the browser or Callie to tell which application answered.

## The decision

**The redirect URI is the API's own HTTPS callback. The desktop app learns the result
through a one-time handoff secret it generated itself and polls for.**

The flow:

1. The Mac generates a 256-bit handoff secret and calls `POST /auth/sign-in/start`.
   The API stores `sha256(handoff)` on the authorization request row and returns the
   authorization URL plus the handoff secret is the Mac's own — it never left.
2. The Mac opens that URL with `shell.openExternal`, so the person sees the sign-in in
   their own browser with Google's domain in the address bar.
3. Google redirects the browser to `https://<api host>/auth/google/callback?state=…&code=…`.
   The API consumes the state row, exchanges the code, validates the id token, and
   records which user the browser proved. The browser is shown a fixed page with no
   interpolation and nothing worth stealing; it never receives a token.
4. The Mac polls `POST /auth/sign-in/claim` with its handoff secret. The first call
   after the browser finishes consumes the row a second and final time, mints the
   device secret, the access token and the refresh credential right then, and returns
   them once.

This is the conservative option at every step. No listening socket on the Mac, no
scheme another application can claim, no credential resting in the database between
the browser and the app, and nothing sensitive in the browser's history or in a
referrer.

The cost is the poll. It is bounded — five minutes, then `sign_in_timed_out` — and
costs one small request per second on a link the app already has open.

## What to create

**Client type: Web application.** Not "Desktop app": a Desktop-app client is the one
that uses loopback or a custom scheme, and we use neither. A Web-application client
also has a client secret, which the API holds in Secrets Manager and presents at the
token exchange; the Mac never sees it.

**Authorized redirect URIs** — exactly these, no others:

| Environment | Redirect URI |
|---|---|
| Production | `https://<production API host>/auth/google/callback` |
| Rehearsal (per run) | `https://<rehearsal API host>/auth/google/callback` |

**Authorized JavaScript origins:** none. No browser page of ours calls Google.

**Scopes for this client:** `openid`, `email`, `profile` only. Gmail's
`gmail.readonly` and `gmail.send` are a separate grant on a later slice (5.1) and must
not be added to this client.

**Other settings:**

* User type: Internal (the Callie Workspace organisation), which is what makes the
  `hd` claim reliable. The API validates `hd` against the configured domain anyway and
  refuses a token without it.
* Publishing status: does not matter for an Internal client.

Two things the API needs at boot, both by reference and neither in this repository:
the client id (a public identifier, but configured rather than committed) and the
client secret (a Secrets Manager ARN).

## If loopback is ever wanted

Nothing here forecloses it. The handoff step is independent of where the browser
lands: a loopback variant would add a second redirect URI and have the local listener
call `claim` instead of polling. It would need a second OAuth client of type Desktop
app, because Google will not accept `http://127.0.0.1` on a Web-application client.
That is the reason to decide now rather than keep both doors open.
