# Outreach provider setup

## What is implemented, and what is not verified

Callie has main-process adapters for OpenAI's Responses API and sending through **your own Gmail mailbox**. No account is provisioned for you. No Jcode credentials, browser profiles, home-directory credential files, or other applications' tokens are imported.

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
5. Requested scopes are only `openid`, `email`, and `https://www.googleapis.com/auth/gmail.send`. Google may display the equivalent userinfo-email scope name. Callie retrieves the verified account email using the OpenID userinfo endpoint, not Gmail mailbox-read permission.
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

Workspace lock, restore or shutdown must dispose the provider manager and cancel pending work before changing database runtime. Recreate the manager for a new unlocked runtime. No operation reconnects or sends automatically after restart. Secure-storage problems should be addressed through normal application/OS recovery, never a password reset or plaintext credential workaround.

## Developer validation

Run with Node 24:

```sh
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm test -- \
  tests/main/outreachProviders.test.ts \
  tests/main/outreachProvidersHttp.test.ts \
  tests/main/outreachProvidersOAuth.test.ts
```

These tests do not use live provider accounts. Do not replace fixture `fetch` implementations with a real network client, use real credentials in tests, or run a real send to claim test success.
