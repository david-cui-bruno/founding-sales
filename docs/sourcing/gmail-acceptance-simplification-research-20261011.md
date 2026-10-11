# Simplifying Gmail acquisition acceptance

Research date: October 11, 2026. Read-only research against current source, ADR0009/0010, #547/#549 and Google primary documentation. No OAuth consent, provider reads, cloud application, source deployment or activation occurred. This is a proposed contract revision, not operational permission.

## Finding and recommendation

Google does **not** require a temporary AWS deployment to verify Gmail acquisition. Google explicitly permits web application callbacks on localhost for testing. Our 140-resource proposal follows our own ADR0010 and AWS-specific physical-isolation implementation. A browser can help perform the real product lifecycle and Codex can verify the resulting state, but reading Gmail in a browser does not establish that Callie's OAuth, parser, database, worker or deletion path works. [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [ADR0010](../adr/0010-isolate-acquisition-acceptance-from-activation.md), [#547](https://github.com/david-cui-bruno/founding-sales/issues/547).

Prefer a **disposable local acceptance composition** running the actual API, registered worker and real PostgreSQL, with the real Google adapters, dedicated nonproduction OAuth project, exact selected messages and no production credentials. Reuse the existing diagnostic lifecycle and canonical copy reads/deletion. Add a truthful local isolation witness rather than returning `true` from the AWS verifier or inventing AWS ARNs. The Google callbacks and confidential client secret remain server-side; this is not a new native desktop OAuth implementation.

This requires a focused ADR amendment and source work before use. It is not a command that can already be run by setting `DATABASE_URL`. After it passes, verify the deployed production configuration through normal health/provider readiness checks, then separately enable approved capture. Local provider success is not proof that deployed secrets, redirects or push delivery are correct.

## Options compared

| Path | What it proves | Remaining complexity / limits | Recommendation |
|---|---|---|---|
| Local isolated API/worker/PostgreSQL and dedicated Google project | Actual sign-in/readonly consent, HTTP transport, parsing, encrypted retention, canonical reads, deletion and revocation on the selected originals | New local composition and isolation contract; localhost callback registration; secure local key/token handling; source/image and schema binding; does not prove production infrastructure or push delivery | Preferred provider acceptance path, subject to approved ADR amendment |
| Existing production, capture OFF, guided bounded diagnostic | Actual production networking/configuration and provider lifecycle if a separately scoped diagnostic lane is implemented | Current production schema88 lacks newest source; production rejects diagnostic mode. New isolation/authorization design and release required. Revoking a production-project grant can invalidate sender tokens. This is not “just read-only” because the app writes copies and operational state | Do not choose as an immediate shortcut. Consider later guided readiness UX while retaining clear scope |
| Current ephemeral AWS diagnostic | Actual isolated deployed API/worker/RDS and AWS witness, plus provider lifecycle if preparation completes | Saved plan/archive, IAM, two task identities, KMS, secrets, migration/bootstrap, release record, DNS/TLS, human handoff, owned teardown and independent backup; latest attempt never reached consent | Retain historical evidence and cleanup tooling; stop using as the default two-message provider test if simpler contract is approved |

The current proposal's actual 140 creates are recorded in [current-state](../operations/current-state.md). No estimate of local implementation hours or guaranteed provider success is asserted here.

## What Google actually requires

### Consent and callback

Use a registered client, enabled Gmail API, exact authorized callback URI and actual user consent. Web-server OAuth supports localhost testing. Keep the client secret outside source control, validate state, and preserve our existing PKCE/owner/session checks. Request offline access if refresh is being verified; successful authorization does not guarantee every exchange returns a new refresh token. [Web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server).

Desktop loopback OAuth is a separate supported Google flow for macOS/Linux/Windows desktop clients. It uses a Desktop app registration; do not silently convert the existing web clients or import installed Callie credentials to imitate it. Our existing callback handlers make the web-server flow the lower-change option. [Native OAuth](https://developers.google.com/identity/protocols/oauth2/native-app), [OAuth policies](https://developers.google.com/identity/protocols/oauth2/policies).

The existing diagnostic clients currently use HTTPS cloud callbacks. A local path needs separately reviewed localhost callback registrations and private client configuration. Do not mutate production clients or consent settings during research.

### Audience and provider approval

External Testing apps permit listed test users, with a 100-test-user limit and seven-day authorizations/refresh-token expiry for Gmail scopes. Internal audience is available only for projects associated with a Google Cloud organization and limits authorization to that organization's members; Workspace administrators may still restrict Gmail access. Being a business-domain mailbox alone does not establish that this project's audience is Internal. [Manage app audience](https://support.google.com/cloud/answer/15549945?hl=en).

`gmail.readonly` is a restricted scope. It allows reading messages/settings, not sending or editing originals; metadata-only scope cannot supply bodies. Testing/internal exceptions may avoid public verification, but their applicability must be checked and user-data obligations remain. Public product distribution using restricted server-side data may require verification/security assessment. Do not confuse our integration acceptance with Google's formal app verification. [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [Restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification), [Verification exceptions](https://support.google.com/cloud/answer/13464323?hl=en).

### Revocation isolation matters more than cloud size

Google says token revocation invalidates scopes and issued access/refresh tokens across clients in the **same project**. Preserve the already separated diagnostic project. Two clients within the production project would not isolate revocation from sender access. Verify normal app disconnect and provider revocation separately; deleting local tokens is not a provider revocation observation. [Token revocation](https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke).

### Push is unnecessary for two selected messages

`messages.get` reads a specified message directly. A bounded selected-message diagnostic needs no Pub/Sub topic, incoming webhook, watch renewal or Gmail `users.stop`. [Messages get](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get).

Ordinary continuous capture is a different acceptance scope. Gmail partial synchronization uses saved history IDs; expired history returns404 and requires recovery. Push can trigger partial sync but notifications may be delayed/dropped, so fallback synchronization remains necessary. Watches need renewal at least every seven days (Google recommends daily). Polling is a supported mechanism; do not add another queue/product just for this diagnostic. Existing product uses push/history and already implements recovery, so removing that production path is not required to simplify acceptance. [Synchronization](https://developers.google.com/workspace/gmail/api/guides/sync), [Push guide](https://developers.google.com/workspace/gmail/api/guides/push).

Our prepared scope remains two messages, max8reads/160units. Source accounting expects84units for the complete eight-read lifecycle, with consent callback profile allowance separate. Google's current table lists profile1, message-get20 and history-list2; preserve actual attempt accounting and never treat unused headroom as authorization to fetch more. [Quota table](https://developers.google.com/workspace/gmail/api/reference/quota), [diagnostic runbook](../greenfield/runbooks/crm-acquisition-diagnostic.md).

## Actual reusable code and work needed

Reusable normal boundaries:

- `apps/api/src/routes/crmAcquisitionDiagnostic.ts`: authenticated request/progress commands and independent pretransaction witness preparation.
- `packages/domain/mail/crmAcquisitionDiagnostic.ts` and `crmAcquisitionDiagnosticCapture.ts`: current authority checks, exact selected originals, conserved usage, reserved copy identity and capture processing.
- `packages/domain/mail/gmailClient.ts`: actual Google consent/exchange/refresh/revoke and message transport.
- Canonical `/crm/business/mail/list`, `/state/read`, `/read/v2`, `/delete` and supported diagnostic disconnect/revoke commands from the runbook.
- `packages/domain/db` migrations, registered worker dispatch and existing real disposable PostgreSQL test seams.

Required source changes, not theoretical config flags:

1. Introduce a discriminated isolation binding for AWS versus disposable local execution. Current startup requires ARN-shaped RDS/secret/ECS fields and ECS metadata; current `crmAcquisitionDiagnosticIsolation.ts` independently reads AWS task/database/secret tags and compares the connected server address. The local verifier must independently bind the actual container/process identity, isolated database instance/role, loopback network, exact artifact/schema and run ID. Never fabricate AWS witnesses.
2. Update authorization/contracts/database guards and trusted provision/revoke operations for that explicit local binding. Preserve expiry, current owner/mailbox/generation/disclosure, exact messages, conserved uncertain reads and publication-after-wait checks. Current administrative handoff/operation script requires the originating protected cloud workflow; a local trusted operation needs its own closed interface, not arbitrary SQL.
3. Provide a local composition with real Google adapters and encrypted token/copy storage. Deployed API composition currently couples real Google to a KMS key wrapper; recorded mode couples local wrapping to fake Google. Add a scoped real-Google/local-encryption composition without making production accept weak/fake configuration. Confirm secure cookie/session behavior and exact two callback origins end to end.
4. Produce a local exact-artifact/schema/observed-run receipt. A cloud ECS release record cannot be invented for a process that never ran there. Source checks and production release receipt remain separate evidence.
5. Own cleanup in one runner: stop worker/API, revoke isolated provider access, delete diagnostic copies and encrypted local token/key/storage, remove disposable database/volume, verify absence. Retain only body-free findings/accounting. Keep external originals unchanged; report interrupted/unknown cleanup explicitly.

ADR0010 explicitly requires isolated infrastructure; the runbook and approved execution bind that to HTTPS/cloud identities. Changing acceptance location requires amending the decision and #547. ADR0009's independently reviewed capability authority should remain. Local success cannot mint production activation. The stale schema90 references in #547/#549/runbook should be reconciled to checked-source requirements rather than creating another permanent schema-number dependency.

## Acceptance should be small and layered

1. Codex runs controlled real-PostgreSQL regressions for ownership/races/duplicate/history-gap/tombstone cases; these require no customer bodies and are not provider evidence.
2. David performs normal fresh Google consent in the supported browser; Codex runs the normal authenticated selected-message commands and registered worker, verifies direction/hash/completeness, canonical read/delete, unavailable reread, disconnect, provider revocation and local cleanup. Scope is still the exact two approved Shirley originals, acquisition-only, no models/sends.
3. After separately approved release, verify deployed callback/configuration and capability-specific readiness. Ordinary Gmail capture #549 requires qualification, continuity and actual history/recovery coverage beyond the two-message diagnostic; do not add every controlled edge case as a mandatory new real customer thread.
4. AI/Ask evaluations #548/#550/#551 remain independent. Neither local provider capture nor browser inspection establishes model quality. Enable passing capabilities independently under #552.

Codex can automate and independently inspect much of this. It cannot replace Google consent, manufacture transport observations, silently lift production holds or call a browser page proof of Callie's provider integration.
