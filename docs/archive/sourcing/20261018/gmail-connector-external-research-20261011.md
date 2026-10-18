# Gmail connector architecture: external primary-source research

Research date: October 11, 2026. Scope: OpenClaw, NousResearch Hermes Agent (assumed meaning of “Hermes”), Google Workspace CLI, EmailEngine, and Google's Gmail contract. Read-only research; no accounts authorized or mail/provider operations performed. These systems solve different jobs, so a CLI with fewer moving parts is not automatically a substitute for a durable CRM connector.

## Comparison

| System | Main job | Mail access and credentials | Change delivery | Fit for a sales CRM |
| --- | --- | --- | --- | --- |
| OpenClaw + gogcli | Personal-agent tools and inbox-triggered agent runs | Gmail API; gog stores tokens in platform keyring by default | Pub/Sub to gog watcher, then Gateway HTTP hook; renewal supervised by OpenClaw | Useful operational reference; CRM evidence, account ownership and durable capture remain application responsibilities |
| Hermes Workspace skill | Agent searches, reads, sends and changes Google Workspace resources on demand | gws preferred; Python Google API fallback with profile-local token JSON | Reviewed skill is command-oriented | Useful tool surface; does not establish a durable CRM mailbox ingestion pipeline |
| Hermes Email gateway | People email a dedicated agent mailbox and receive replies | IMAP/SMTP app password in profile `.env` | Polling, default 15 seconds | Different product job from linking a customer's existing Gmail mailbox |
| Google Workspace CLI | General-purpose Google API command tool | OAuth; encrypted credentials and OS keyring/file-key option | `gmail +watch`: Pub/Sub pull and NDJSON output | Useful debugging/agent interface; reviewed helper lacks several durable sync guarantees |
| EmailEngine | Mail connectivity service for applications | Gmail REST API or IMAP/SMTP; managed OAuth lifecycle | Gmail history via Pub/Sub pull plus fallback polling; application webhooks | Closest comparator to durable ingestion, but adds another service and state owner |

Sources supporting each row are expanded below; “fit” statements are architectural inferences.

## OpenClaw and gogcli

OpenClaw's documented Gmail trigger uses `gog gmail watch serve`. The transport is Gmail → Pub/Sub → gog watcher → Gateway HTTP hook. Setup involves `gcloud`, authorized gog, hooks, and a reachable HTTPS push endpoint (Tailscale Funnel recommended). Its documentation requires a restricted mail reader for untrusted inbox input. [Gmail trigger guide](https://docs.openclaw.ai/automation/cron-jobs/gmail).

OpenClaw's webhook commands create the watch/topic/subscription and run the watcher with an automatic watch-renewal loop. Gateway boot can start the watcher; operators should avoid running a second listener for the same configuration. [Webhook CLI](https://docs.openclaw.ai/cli/webhooks).

gog supports named accounts, multiple OAuth clients, access tokens, ADC, and Workspace service accounts. Token storage defaults to the platform keyring; headless machines can use encrypted file storage. Its default Gmail grant includes modify and settings scopes, but explicit `send` and `read-send` scope modes are documented. Inference: copying default gog permissions into a read-and-send CRM would grant more authority than necessary. [gog README](https://github.com/openclaw/gogcli/blob/ac526f4f29b6d4a80efeebdbf7a9ae7ca91222bb/README.md).

The reviewed gog processor detects duplicate Pub/Sub message IDs and stale progress, fetches history/messages, classifies rate-limit/auth failures, and attempts to restore prior progress after failed hook delivery. Stale-history recovery retrieves a bounded set of recent messages. It advances progress before hook delivery and restores on failure, so this review does **not** establish transactional exactly-once downstream delivery or crash-proof CRM persistence. The receiving application still needs idempotent writes and replay handling. [Processor source](https://github.com/openclaw/gogcli/blob/ac526f4f29b6d4a80efeebdbf7a9ae7ca91222bb/internal/gmailwatch/processor.go).

## Hermes: distinguish its two paths

Hermes's Google Workspace skill prefers gws, falling back to Google Python libraries, with OAuth and refresh. Its setup uses a desktop OAuth client and browser consent; its examples expose search/read/send/modify commands. No durable CRM ingestion contract is claimed by that page. [Workspace skill guide](https://github.com/NousResearch/hermes-agent/blob/97a9ae8ee55d31bebce49f1fb6b5ef775323976a/website/docs/user-guide/skills/google-workspace.md).

The Python setup stores `google_token.json`, `google_client_secret.json`, and pending OAuth session state beneath the active Hermes profile. Its configured scope list includes Gmail readonly, send, modify and other Workspace services. It uses persisted OAuth state/PKCE verifier and a localhost redirect. The token is written as JSON; this source does not show token-at-rest encryption. [Setup source](https://github.com/NousResearch/hermes-agent/blob/97a9ae8ee55d31bebce49f1fb6b5ef775323976a/skills/productivity/google-workspace/scripts/setup.py). The API script refreshes expired credentials and writes refreshed token JSON back to that profile. [API source](https://github.com/NousResearch/hermes-agent/blob/97a9ae8ee55d31bebce49f1fb6b5ef775323976a/skills/productivity/google-workspace/scripts/google_api.py).

Its separate Email gateway uses Python IMAP/SMTP with no extra email-client service. The recommended account is dedicated to the agent; Gmail setup uses an app password saved in `~/.hermes/.env`. Default polling is 15 seconds; allowed-sender restrictions control who can address the agent. Inference: this simple gateway is not an alternative architecture for OAuth-linking and continuously importing multiple customers' existing mailboxes. [Email gateway guide](https://github.com/NousResearch/hermes-agent/blob/97a9ae8ee55d31bebce49f1fb6b5ef775323976a/website/docs/user-guide/messaging/email.md).

## Google Workspace CLI

gws dynamically derives API commands from Google's Discovery Service. Credentials are AES-256-GCM encrypted with a key stored in the OS keyring, or a local encryption-key file when the file backend is selected. It supports interactive authorization, credentials-file deployment and supplied tokens. It includes `gmail +watch` to stream mail as NDJSON. [gws README](https://github.com/googleworkspace/cli/blob/a3768d0e82ad83cca2da97724e46bea4ff0e6dbd/README.md).

The reviewed watch helper creates/reuses Pub/Sub resources, starts a Gmail watch, initializes a cursor from the current profile, pulls notifications and fetches `messageAdded` history. Its cursor lives in process memory. In the reviewed implementation, history fetching has no pagination loop, does not explicitly check HTTP status before parsing, and does not implement stale-history full recovery or a periodic watch-renewal loop. It advances its in-memory cursor and acknowledges after fetch/output. Inference: wrapping this command alone as a production CRM ingress can silently skip changes across restarts, error responses or paginated history; durable application code would still be needed. These are observations about this helper at this commit, not all gws functionality. [Watch source](https://github.com/googleworkspace/cli/blob/a3768d0e82ad83cca2da97724e46bea4ff0e6dbd/crates/google-workspace-cli/src/helpers/gmail/watch.rs).

## EmailEngine: closer to an ingestion service

EmailEngine supports Gmail REST API access separately from IMAP/SMTP. REST permits narrower grants (for example readonly, send or modify), while OAuth IMAP/SMTP uses the full `https://mail.google.com/` grant. Its Gmail API service renews watches when more than one day old, checks hourly, exposes watch state, and recreates subscriptions deleted through inactivity. Pub/Sub resources are shared across accounts using the same service-account app. [Gmail API setup](https://learn.emailengine.app/docs/accounts/gmail/gmail-api).

It consumes Pub/Sub by **pull**, which does not require a public Gmail push listener. History processing also has a roughly ten-minute fallback poll; without the Pub/Sub service-account link, polling remains available with that latency. This demonstrates that push delivery is an optimization around history reconciliation. IMAP instead requires a persistent connection per account. [Pub/Sub guide](https://learn.emailengine.app/docs/accounts/gmail/gmail-pubsub).

OAuth tokens are persisted in Redis, encrypted when `EENGINE_SECRET` is configured. Refresh rejection produces an authentication error requiring new consent, while transient token-endpoint failures are retried. Long-running auth failure can switch accounts off; reauthorization restores them. Inference: a bought or reused connectivity layer can reduce provider-specific work, but the application must integrate lifecycle webhooks, keep durable CRM evidence and operate another service. [Token lifecycle](https://learn.emailengine.app/docs/accounts/oauth2-token-management).

## Google's contract sets the actual correctness bar

Gmail notifications contain an email address and history ID, not message contents. Push or pull are supported; subscribers must acknowledge. Watches expire and must be renewed within seven days (daily recommended). Notifications may be delayed or dropped, including above one event/second per user, so Google advises periodic history reconciliation. Pub/Sub topic ownership must match the developer project executing the watch. [Push contract](https://developers.google.com/workspace/gmail/api/guides/push), [Watch reference](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/watch).

History retention is not a fixed guaranteed week: it can be shorter. An out-of-range start cursor returns 404 and requires full synchronization. “Full” means retrieving the amount of recent mail needed for the application's purpose, not necessarily the entire mailbox. Bounded product-specific recovery is compatible with that guidance if coverage is explicit. [Sync contract](https://developers.google.com/workspace/gmail/api/guides/sync).

Quota documentation changed for new projects on May 1, 2026; previously active projects can retain their older allocations. Current published new-project limits are 6,000 units per user/project/minute and 1,200,000 per project/minute. History listing costs 2 units; message listing 5; message retrieval 20; thread retrieval 40; watch 100; send 100. The published daily billing threshold is 80 million units; Google describes future excess-use charges with notice, so verify the real project's limits before planning spend. [Quota reference](https://developers.google.com/workspace/gmail/api/reference/quota).

Readonly remains a restricted scope; adding send adds a sensitive scope. Server-side storage/transmission of restricted-scope data brings Google's stated security-assessment requirement. Splitting capture-only and send consent reduces authority but does not itself remove restricted-data obligations. [Scope reference](https://developers.google.com/workspace/gmail/api/auth/scopes).

## Assessment implications for the local review

These are recommendations inferred from the sources, not claims about code inspected in this research subtask:

1. Gmail API + OAuth + durable history cursor + reconciliation is the appropriate family of architecture for continuous CRM capture. Pub/Sub is optional acceleration; replacing it with periodic history polling can simplify infrastructure when ten-minute latency is acceptable.
2. Personal-agent command tools are useful interfaces over mail access. Their short setup does not replace account lifecycle, cursors, evidence persistence, recoverable jobs, or tenant isolation.
3. Keep transport, capture policy and agent actions as separate responsibilities. A fetched email should become durable provider evidence before it triggers a sales action or agent run.
4. Audit the boundary between provider calls and database transactions. Persist idempotent mail evidence and advance progress atomically in short transactions; do network calls outside them. Account renewal/reconciliation should recover independently of any individual model run.
5. Offer the smallest consent needed by the workflow, and expose revoked credentials, expired watches, recovery coverage and last successful sync. Encrypting refresh tokens and supervising watches are useful controls already visible in stronger comparator systems.

Limitations: source snapshots were read, not installed or load-tested; EmailEngine claims are first-party documentation rather than end-to-end runtime validation. This review does not cover every Hermes plugin or every OpenClaw extension, prove exactly-once delivery for any comparator, or measure local implementation throughput. The parent review owns the local-code comparison.
