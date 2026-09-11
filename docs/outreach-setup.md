# Outreach provider setup

## What is implemented, and what is not verified

FSS has main-process adapters for OpenAI's Responses API and sending through **your own Gmail mailbox**. No account is provisioned for you. No Jcode credentials, browser profiles, home-directory credential files, or other applications' tokens are imported.

Automated checks use fictional credentials, controlled HTTP responses and a local loopback OAuth callback. They do **not** establish that your key, Google project, account policies, billing, quota, or live mailbox will work. Setup does not send a test email.

Status meanings:

- **Unconfigured:** the required local configuration/authorization is absent.
- **Ready:** usable-looking configuration or a previously authorized mailbox is stored. This is not a live connectivity, billing, or delivery guarantee.
- **Locked:** secure storage or the workspace is unavailable. Unlock normally, then retry setup. There is no plaintext fallback.
- **Reauthorize:** a token refresh was rejected. Explicitly reconnect through Google's browser screen.
- **Error:** secure storage or provider data could not be validated. Corrupt credentials are never silently replaced or treated as missing. Do not manually edit the encrypted envelope.

## OpenAI

1. Use your own OpenAI API project with API access, billing and an appropriate spending limit.
2. In Settings → Connections, enter the API key and a model identifier available to your project that supports the Responses API and structured JSON output. A ChatGPT subscription/login is not an API key.
3. Save the configuration. No network request is made merely by saving it.
4. Generating a draft sends bounded, supported outreach context to OpenAI: the contact name, organization label when known, segment, stage, action, selected evidence-backed facts, and the supplied playbook. Private local-only notes must never be placed in those facts. The domain service owns this selection.
5. The adapter requests `store: false` and a strict subject/body/evidence-ID response. This does not override OpenAI's applicable abuse-monitoring or account-level retention policy. Do not include information you are not authorized to share with the provider.
6. Review and edit the result. Evidence-ID checks prevent unknown source references, but cannot prove that every generated sentence is true. There is no automatic template pretending to be model output if generation is unavailable.

## Your Google Desktop OAuth client

Use a Google Cloud project you control. This application does not bundle a shared OAuth client.

1. Enable the **Gmail API** in that project.
2. Configure the OAuth consent screen, audience and required project details. If the app is in testing, add your own account as an allowed test user. Organization-managed Google Workspace accounts may require an administrator to allow the app or scopes.
3. Create an OAuth client with application type **Desktop app**, not Web application. Copy its client ID and, if provided, client secret into Settings → Connections. A desktop client secret is not a confidential-server security boundary. PKCE protects the authorization-code exchange.
4. Save the configuration, then explicitly choose **Connect Gmail**. The system browser opens Google's authorization screen. Check that the selected account is the mailbox you intend to send from.
5. Requested scopes are only `openid`, `email`, and `https://www.googleapis.com/auth/gmail.send`. Google may display the equivalent userinfo-email scope name. FSS retrieves the verified account email using the OpenID userinfo endpoint, not Gmail mailbox-read permission.
6. The callback is a short-lived `http://127.0.0.1:<ephemeral port>/oauth/callback/<random path>` listener. Allow local loopback connections if a firewall prompts. No public server, custom DNS or externally reachable callback is required. Random state and PKCE S256 are validated. The listener closes on completion, cancellation, browser failure or timeout (two minutes).
7. Verify the connected email in Settings before using Send. Changing Google client settings invalidates prior prepared sends and clears locally stored authorization for that client.

Testing-mode Google OAuth grants can have short refresh-token lifetimes, commonly seven days when non-basic scopes are requested. Public distribution or moving beyond test users can require Google's consent-screen verification and policy compliance. Requirements depend on project audience, requested scopes and Google policies. This implementation has not been live-verified with your project.

## Explicit Send and uncertainty

Set your real sender name and valid postal address. The draft workflow must preview the reply-opt-out footer together with the exact subject/body that will be sent. The provider does not invent or append unseen text.

Only explicit **Send** dispatches. Token refresh occurs before the domain's final authorization and durable reservation. The prepared sender is bound to its account, configuration/workspace lifetime, cancellation signal and token validity. It invokes one fixed Gmail endpoint immediately and has no automatic retries or redirects.

- **Accepted** means Gmail returned a message identifier. It does not establish delivery, reading, a reply, a conversation or an interview.
- **Not sent** is a definite local refusal or a definite provider rejection. Correct the cause and review again. There is no automatic retry.
- **Unknown** means the request may have succeeded. A timeout, transport failure, malformed successful response or crash is not evidence of non-delivery. **Do not resend to find out.** Check the exact recipient, subject, content and timestamp in your Gmail Sent folder. The local draft/command ledger must keep the affected draft locked, including under a new command ID. This send-only integration cannot search Sent or reconcile automatically.

Gmail does not provide this application's local command ID as a server-side idempotency guarantee. The MIME Message-ID is only a correlation aid.

**Replies and opt-outs:** send-only permission does not read incoming Gmail replies. Monitor your own inbox and promptly record every opt-out in FSS so its permanent person-wide block takes effect before further outreach. Do not assume that a reply automatically updates FSS. A separate, explicitly approved inbound integration would be needed for that capability.

## Storage, disconnect and recovery

Credentials are serialized only into an OS-protected safeStorage ciphertext envelope, written atomically to a dedicated 0700 directory with a 0600 file under the application's private storage. Encryption must be available. Symlinked, overly permissive, malformed or corrupted envelopes are refused. Keys/tokens are not included in status responses or provider exception messages. Secret entry briefly crosses the trusted renderer/preload boundary to main, but secrets are never returned to the renderer.

**Disconnect Gmail** invalidates outstanding prepared sends and clears local access/refresh tokens. It does not send email or make a remote revocation request. To revoke the Google account's grant as well, use your Google Account's connected-app controls. Other backups of encrypted credentials, if any, are not remotely erased by disconnect. Do not export credentials in database backups or diagnostic logs.

Workspace lock or wake must call the provider manager's `invalidate()` hook to cancel pending OAuth, configuration writes, generation and prepared sends without reconnecting. Restore or shutdown must permanently `dispose()` the manager before changing database runtime. Recreate it for a new runtime. Invalidation itself does not authorize new work while locked: the root workspace gate must refuse new setup/send requests until unlock. No operation reconnects or sends automatically after restart. Secure-storage problems should be addressed through normal application/OS recovery, never a password reset or plaintext credential workaround.

## Developer validation

Run with Node 24:

```sh
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm test -- \
  tests/main/outreachProviders.test.ts \
  tests/main/outreachProvidersHttp.test.ts \
  tests/main/outreachProvidersOAuth.test.ts
```

These tests do not use live provider accounts. Do not replace fixture `fetch` implementations with a real network client, use real credentials in tests, or run a real send to claim test success.

## Delegated meeting-first source integration (not live acceptance)

The normal main process now reads an OS-encrypted delegated pairing from its private `delegation` directory. An absent, invalid or workspace-mismatched pairing leaves delegation inactive. The expected workspace is captured before asynchronous initialization and cannot be supplied by research results or a default UUID. Pairing is an explicit authenticated operation against an exact configured HTTPS endpoint. A newly paired installation must restart to capture that immutable identity. Credentials never appear in status or sync responses.

The strict preload `delegation` surface provides `status`, `pair`, `configure`, `bootstrap`, `submit`, `sync`, `configurePolicy`, `configureResearch` and `beginPhone`. These are backend integration paths, not a claim that the D3-pending renderer offers these controls. Local configuration is revisioned encrypted-SQL state and defaults to paused. Remote account activation, sender caps, calendar rules and workspace research selection are separate explicit authenticated configurations. None creates a grant, permission evidence, budget approval or execution ownership. Selected bootstrap exports only the bounded selected account/provenance/suppression snapshot, acknowledges an explicit research baseline, and does not delegate or upload the workspace database.

Every local operation uses a live Foundation database lease. Lock and shutdown abort local work and invalidate current proof readers before their lease closes. They do not revoke separately authorized remote automation. The actual A1 registry includes the delegated adapter. Manual phone handoff uses a short-lived owner proof scoped to the exact reserved handoff, while retaining all other inbound adapters and dependencies. A missing adapter, stale/consumed token, current suppression or unavailable owner holds the action. Consuming a handoff is one-shot and is followed by the immediate native phone adapter, never a retry or automatic voice call. A typed owner outcome is required before dependent automation proceeds. Generic cancellation or uncertainty is not proof that no action occurred.

### Remaining source and acceptance gates

- Renderer presentation and exact D3 visual approval remain pending. No new screen or fake packaged entry was introduced.
- Normal admission of a newly researched account's route-policy receipt still needs a reviewed integration path. Test fixture admission is not normal-user-path acceptance.
- Current requested-followup email approval requires a real existing inbound thread. A phone-origin request for the first email is not implemented by that enum. The separate receipt-backed first-followup plan must be implemented and verified without a fabricated person/thread or cold-mail fallback.
- Deployment, pairing setup, account grants, provider reads, real research/model requests, actual calls/sends/invitations and migration of a real workspace remain separately authorized activities. No such operations were performed for this integration.
- **Mac-asleep live acceptance remains unperformed:** after bounded deployment/grant/endpoint approval, verify a real relevant reply, exact approved response, agreed Calendar event, remote pause/revoke and one-result reconnect. Fictional encrypted-SQL/HTTP tests cannot establish that result.
