# Scoped acquisition acceptance environment (#524)

This procedure prepares the separately isolated schema90 candidate. It does not approve a live run, production release, capture activation, AI use or sending. This source90 work remains unreleased; preserve the independently reviewed release state and all sending safeguards. The ordinary rehearsal root defaults to database `fss`, no diagnostic environment variable, no diagnostic tags and no additional witness policies. Production rejects diagnostic mode.

## Approval prerequisites

Before any cloud plan/apply or private-data acquisition, obtain approval for the separate ephemeral rehearsal resources and cost, exact schema90 commit/API/worker digests, environment UUID and expiry. Independently review the mailbox owner, actual incoming/Sent message IDs, thread IDs, date bounds, disclosure/consent/provider-policy references, retention/deletion and read/unit limits. The capture-only isolated OAuth callback, permitted Google redirect URI, envelope KMS access and token refresh must work; never copy production tokens or use installed desktop credentials. No infrastructure configuration or fixture evidence substitutes for these approvals.

## Capture-only consent and safe cleanup (#528)

Use an independently isolated Google API/OAuth project and dedicated client with reviewed exact HTTPS redirects and Workspace/test-user consent policy. A different client within the production project does not isolate revocation: Google revokes the project's scopes and issued tokens across its clients. Do not reuse production mailbox tokens, change its project consent, or call Gmail users.watch/users.stop. [Google revocation](https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke), [users.stop](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/stop).

Before beginning consent, callback exchange/profile or local cleanup, the API independently witnesses its actual ECS task, database, injected secret, tags and DNS/address outside command transactions; absent or failed physical proof refuses. Namespace/configuration alone is insufficient. In that diagnostic startup composition only, authenticated `/gmail/connect` begins a fresh-owner readonly grant. Signed state binds the environment and refuses ordinary/cross-environment/expired state, switch intent and retained mailbox reuse. Callback must return the consenting owner's exact account and readonly scope; it stores a fresh encrypted token and actual OAuth observation, with no baseline/reconcile/watch jobs, sending-domain registration or coverage claim. The signed diagnostic attempt has a durable one-use body-free audit reservation before exchange. Callback getProfile is separately reserved as1 unit and recorded observed1 or conserved unknown1; failed exchanges spend zero profile units. Repeated/concurrent callbacks cannot redispatch the attempt. These callback units are separate from the later eight-read/84-unit capture grant. Ordinary production OAuth continues its existing readonly+send scopes, baseline and disconnect behavior. Consent does not grant diagnostic acquisition authority; separately provision the reviewed exact bounded grant afterward.

Diagnostic mode refuses ordinary `/gmail/disconnect`. The owner instead POSTs the local-only command `/gmail/acquisition/cleanup`, using the supported client version and strict envelope:

```json
{
  "commandId": "<fresh UUID>",
  "clientVersion": "<supported current client version>",
  "mailboxId": "<isolated owner's mailbox UUID>",
  "reason": "diagnostic_complete"
}
```

This command fences acquisition through current mailbox generation/status and deletes its isolated encrypted token under local locks. It performs no provider calls and preserves private retained copies and conserved accounting. Its result explicitly reports `localDisconnected=true`, `providerRevoked=false`, and `trustedRevocationPending=true`; it does not mutate immutable authority receipts. Repeat/replay is safe and does not reacquire tokens. Trusted authority revocation remains the separate operations command below. After deleting copies and trusted revocation, revoke only the independently isolated Google project's grant through reviewed provider controls, then destroy the exact isolated environment. Never use users.stop as cleanup: this environment creates no watch. Capture waits must settle known/uncertain usage even after cleanup while refusing publication or redispatch. A retained disconnected mailbox cannot reconnect through this fresh-only mode; create a newly reviewed isolated environment for another run.

## Prepare the supported rehearsal root

Use a separate checkout/state key and a fresh `fss-rh-<run>` prefix. Use the pinned Terraform1.15.8 and normal rehearsal deployment role; verify its account/identity through `infra/scripts/rehearsal.sh identity` before cloud operations. Do not reuse a standing rehearsal database: changing `db_name` replaces RDS. The existing prefix/state/teardown guards remain mandatory.

Create a reviewed, non-secret tfvars JSON with the usual rehearsal inputs (prefix, certificate, API hostname, immutable image digests, schema ranges and bootstrap=true) plus:

```json
{
  "crm_acquisition_diagnostic": {
    "environment_id": "<independently chosen UUID>",
    "database_name": "fss_diagnostic_<unique_run>"
  }
}
```

The database suffix is lowercase letters/digits/underscores, at most40 characters. Sending remains false; ordinary CRM adapter configuration and restored/external database overrides are refused in diagnostic mode. The shared stack creates the managed diagnostic database and tags RDS, the application database secret, task definitions and ECS services with the exact purpose/environment. Service tags propagate to running tasks. Only the API/worker task roles gain additional DescribeTasks/DescribeTaskDefinition, DescribeDBInstances/ListTagsForResource and DescribeSecret permissions scoped as documented below; there is no witness secret-value, mutation or provider permission.

The rehearsal deployment role is trusted only for the protected GitHub OIDC workflow. A local operator cannot assume it through the normal path. Do not disable role checks, expand IAM or substitute an administrative session. The ordinary `plan/create/deploy/full` workflow overrides the host and always tears down; it must not be used for an interactive diagnostic. #532 adds a separate plan-only preparation path; its source checks and exact dispatch support must be verified before use.

The following Terraform calls describe the required operations inside that verified normal-role path, after explicit cloud-operation approval, using the approved unique state key rather than the shared default. They are not a local credential workaround:

```bash
terraform -chdir=infra/roots/rehearsal init -backend-config=backend.hcl -backend-config="key=<approved unique rehearsal state key>"
terraform -chdir=infra/roots/rehearsal plan -var-file=<reviewed tfvars.json> -out=<reviewed plan file>
# Inspect locally or emit only a values-free summary; never log/upload raw plan values.
```

This repository is public. A protected workflow environment does not make its uploaded artifacts private. Retain only a values-free review manifest and an encrypted saved plan addressed to the reviewed local operator public key; keep the private key outside CI and the repository. Raw plan files, `terraform show` JSON/logs and secret-bearing configuration must not be uploaded. An encrypted plan supports local review; it does not by itself provide a later GitHub OIDC saved-plan apply path. Existing role source permissions do not include S3 version reads or arbitrary object deletion, and private escrow/retention must not be inferred.

Review replacement/create actions, names/tags and both additional IAM policies before the separately approved apply. Exact saved-plan application, bounded interactive lifetime with independent cleanup, real isolated secret injection and unique public DNS remain operational prerequisites. DNS requires a separately authorized existing DNS owner; do not add Route53 permission to the rehearsal role. A $5/four-hour proposal is neither a hard cloud cost cap nor guaranteed instantaneous deletion. Follow the existing rehearsal release sequence in `infra/scripts/deploy.sh` and the secret-entry preparation from `.github/workflows/greenfield-release.yml`: derive both database entries from `database_endpoint` and **`database_name` outputs**, fill secret values privately from stdin/file descriptors, migrate with the migration identity, and ensure the app-runtime login before scaling either service. Use actual approved OAuth/session secrets for this diagnostic; ordinary rehearsal fixture secrets cannot establish real consent. Terraform never reads/writes secret values. Do not feed this candidate into production release automation.

## Retained plan-only preparation (#532)

The separately gated `diagnostic_plan` stage in `greenfield-release.yml` is the supported preparation seam after its reviewed source is on main. It excludes the ordinary rehearsal job and has no apply, deployment, secret-value injection or teardown step. Strict inputs bind the selected environment UUID, `fss_diagnostic_<suffix>` database, `<suffix>.rehearsal.usecallie.com` hostname, two distinct immutable image digests and the recipient public SPKI fingerprint. The `diagnostic_config` JSON has only `environmentId`, `databaseName`, `apiHostname`, `recipientPublicKeyPem` and `recipientPublicKeySha256`; never put a private key or OAuth secret in that input. Existing certificate/repository values come from the protected rehearsal environment.

The helper runs on Node24 through `infra/scripts/diagnostic-plan.mjs`. Its public commands are `validate`, `provenance`, `plan`, `seal` and `decrypt`. The workflow checks immutable image-build provenance separately from its own infra-only commit, verifies the exact normal role and certificate, and plans only against `fss/greenfield/rehearsal/fss-rh-<suffix>/terraform.tfstate`. Nonempty state or an unreadable state check refuses; no cleanup of an existing environment is implied. Terraform backend initialization and locking are AWS operations even though no stack resource is applied.

Review artifacts are retained for one day: a values-free manifest/summary and an RSA-OAEP-SHA256/AES-256-GCM encrypted saved plan. The exact manifest bytes are authenticated as encryption associated data; retain and independently check their receipt/hash/source/configuration bindings. Decrypt only locally with the intended private key and a fresh nonexisting destination:

```bash
node --experimental-transform-types --disable-warning=ExperimentalWarning infra/scripts/diagnostic-plan.mjs decrypt \
  <plan.encrypted.json> <manifest.json> <local-private-key.pem> <new-private-plan-path>
```

A successful plan declares `applySupported=false` and `activationAllowed=false`. It supplies a concrete proposal for review, not an environment, an approved plan-application mechanism, real consent, Gmail headroom or provider/deletion acceptance. Do not dispatch ordinary `create/full` to consume it: those paths replan and tear down. Exact-plan handoff/application and independent bounded cleanup must be verified before any approved creation.

## Inspect exact bindings and execute the bounded lifecycle

Read the non-secret output after the approved deployment:

```bash
terraform -chdir=infra/roots/rehearsal output -json crm_acquisition_diagnostic
```

It includes the managed database name/ARN/endpoint, application database secret ARN, cluster ARN, actual API/worker task-definition ARNs, exact propagated tags and scoped witness policies. Both actual task environments receive strict `FSS_CRM_ACQUISITION_DIAGNOSTIC` JSON derived from these outputs, not a manually guessed secret ARN. Confirm the actual running task/image/tag/secret injections independently; planned outputs alone cannot prove the running deployment. Runtime checks the real ECS task and image, RDS/secret metadata and current PostgreSQL server address against RDS DNS before reads.

Use the strict authorization/read/command contracts at `packages/contracts/src/crmAcquisitionDiagnostic.ts` for the following bounded lifecycle. Freeze the exact reviewed grant digest and independent release record. The API allows only auth/OAuth, diagnostic commands and canonical lifecycle; the dedicated worker refuses ordinary capture/send/AI/backfill jobs. Two complete incoming/Sent copies require8 metered HTTP reads/84units; partial/refused/unknown outcomes remain explicit. Never blindly retry an ambiguous read.

Verify actual originals/hashes/directions and unavailable-after-delete through owner reads without logging bodies. Revoke the diagnostic grant, delete remaining copies through the owner lifecycle, and use the existing rehearsal teardown/leftover guard. Account/owner/generation drift, revocation, deletion or missing witness must stop publication. A separately reviewed actual acquisition/deletion acceptance artifact is still required for any production capture authority; this diagnostic never creates it automatically.

## Trusted authority and authenticated requests

Prepare a body-free `CrmAcquisitionDiagnosticAuthorization` document with the approved exact mailbox/account/owner/generation/OAuth observation, deployment/database bindings from the output, implementation commit/digests/schema90/release record, current disclosure hash, independently reviewed consent/policy/expiry references and exact message scope. Obtain its canonical digest using `crmAcquisitionDiagnosticFingerprint` on the schema-parsed document; arbitrary file hashes or raw JSON field order are not the authorization fingerprint. Do not include originals, credentials or tokens.

With the trusted migration operations identity (normal `FSS_MIGRATION_DATABASE_URL` or migration-secret injection), provision only the reviewed immutable authority:

```bash
fss admin crm-acquisition-diagnostic provision --json reviewed-authorization.json --sha256 <reviewed canonical digest>
```

Provision enables nothing and queues nothing. Changed content under an existing authority ID refuses. Runtime credentials cannot provision/revoke. Use the normal authenticated admin-owner session to POST `/crm/business/mail/diagnostic/request`:

```json
{
  "commandId": "<fresh UUID>",
  "clientVersion": "<supported current client version>",
  "authorizationId": "<reviewed authority UUID>",
  "expectedAuthorizationSha256": "<reviewed canonical digest>"
}
```

The API verifies external isolation before the SQL command transaction and rechecks locked current authority inside it. Identical command replay creates no new work; changed payload under the same command ID refuses. POST `/crm/business/mail/diagnostic/read` with only `authorizationId` for body-free progress, explicit partial coverage, actual-versus-controlled transport and observed/conserved usage. Request preallocates owned pending originals, allowing deletion during provider waits. Use `/crm/business/mail/list`, `/crm/business/mail/state/read`, `/crm/business/mail/read/v2` and `/crm/business/mail/delete` with the canonical exact source ID/revision/hash contracts to inspect and delete owned copies. No evidence, processing or Ask path may consume these diagnostic originals.

Stop the authority when complete, expired or blocked:

```bash
fss admin crm-acquisition-diagnostic revoke --workspace <UUID> --authorization <UUID> --reference <body-free review reference>
```

Retain only the body-free reviewed accounting/deletion outcome and exact source identities/hash/revisions. Controlled success or actual HTTP transport alone never proves actual acceptance; independent review of the specifically authorized real lifecycle remains necessary. The diagnostic does not provision a production authority receipt.

## Witness IAM authorization evidence

AWS's [ECS service authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ecs.html) lists `DescribeTasks` against the `task` resource, with cluster and resource-tag condition keys. Its policy names only task ARNs under this actual cluster and additionally requires the exact cluster ARN and diagnostic purpose/environment tags. The same reference gives `DescribeTaskDefinition` no resource type or action-specific condition keys. That single action therefore requires `Resource: "*"`; claiming family-level IAM restriction would produce an unusable witness. Its added policy is restricted to the configured `aws:RequestedRegion` and caller `aws:PrincipalAccount`, following [global condition-key documentation](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_condition-keys.html). It permits readonly task-definition metadata at that regional endpoint for the configured account’s caller and cannot be truthfully described as family-restricted. `aws:PrincipalAccount` constrains the caller, not a target resource account; it is not an invented resource scope. The application witness still validates the exact independently reviewed task definition, matching current running task/image and exact secret injection. Do not invent unsupported task-definition/tag IAM conditions for this action.

The [RDS authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_rds.html) supports the `db` resource for both `DescribeDBInstances` and `ListTagsForResource`; both are restricted to the exact managed instance ARN. The [RDS API](https://docs.aws.amazon.com/AmazonRDS/latest/APIReference/API_DescribeDBInstances.html) accepts a DB instance ARN for its explicit instance identifier, which the witness supplies. [Secrets Manager authorization](https://docs.aws.amazon.com/service-authorization/latest/reference/list_secretsmanager.html) supports the exact `Secret` ARN for `DescribeSecret`, which returns metadata rather than the encrypted secret data. Neither witness action requires `GetSecretValue` or decrypt permission. These primary references and mocked policy tests justify source policy shape; actual IAM acceptance and isolated cloud witness remain unverified until the separately approved deployment.

Current schema90 reserves20units for each metadata/body messages.get and1unit for each users.getProfile. Two complete copies therefore reserve8reads/84units (four requests/42units each), within reviewed maximum8reads/160units. This bounds local method accounting; it does not attest shared Google-project quota headroom. Schema89 grants and5unit observed/unknown reservations remain immutable, read-only historical records labeled `legacy_recorded_unverified`. The newer isolated task may obtain a purpose-limited progress witness against the same independently verified database to inspect them; that witness cannot request, dispatch or publish acquisition. New provisioning and dispatch accept only schema90, and ambiguous historical reads never retry.


## Private proposal and bounded application support (#534)

This section describes the independently reviewed source candidate, locally verified by634operations tests and statics, with exact-head CI and normal merge still required. It does not establish completed live setup or activation. The approved production release remains schema88/desktop1.0.51. Review the exact source checks and merge receipt before invoking new diagnostic workflows.

Use separate approvals for private proposal storage and environment application. A storage approval authorizes one newly generated proposal under its exact source, configuration, images and namespace; it cannot pre-review a plan hash that does not yet exist. The resulting observed encrypted-object, manifest and binary-plan hashes must be reviewed before an application lease can authorize creation. Never supply the local RSA private key to GitHub, intercept temporary Terraform output or reinterpret an earlier encrypted artifact as application approval.

The existing Terraform state bucket is versioned and has no lifecycle policy. Operational plan and execution records may remain after environment cleanup. Explicitly acknowledge that retention before any storage write. Current-object read/write permission does not imply version reads or arbitrary deletion. These records contain no conversation originals, OAuth secrets or provider tokens; deleting a conversation copy does not erase operational metadata.

Approval IDs and lease IDs are one-use execution intents. GitHub assigns actual run IDs after dispatch; those IDs are observed execution metadata, not fields invented in advance or silently relabeled as human approval. Conditional reservation and exact current-object readback bind the original approved document bytes and actual protected manual run. Application also verifies an origin index before first creation. Any duplicate or uncertain reservation refuses another apply. A fresh attempt needs a newly reviewed intent; it never blindly retries an ambiguous operation.

An application lease binds the exact plan/configuration/source/images/environment and an absolute window no longer than four hours, with cleanup scheduled at least sixty minutes before the deadline and a named owner and fallback. The proposed five-dollar allowance is not an AWS hard spending cap. GitHub cancellation, timeouts, credential failure or concurrency delays can prevent timely destruction; the backup workflow provides recovery support, not a guaranteed cloud TTL. Unverified cleanup remains unresolved and requires the named fallback.

Real Google OIDC and Gmail clients in a separate project, exact isolated redirects, actual Workspace/test-user policy review and private fresh client secrets must be verified before creation. Protected environment configuration is a prerequisite to execution, not proof of provider acceptance. Environment preparation uses the existing release/bootstrap boundaries without a sending domain. It creates no acquisition, processing, Ask or sending authority.

Cleanup uses the retained exact owned configuration and registered original run. Recovery may derive the original approved digest only from a verified origin index matching the primary conditional execution record, after independently verifying the actual primary manual workflow, repository, main ref and source. It permits cleanup only. Missing or inconsistent records do not establish cloud absence and never authorize an arbitrary namespace teardown. Public artifacts and logs must contain only sanitized receipts; private plan/configuration/Google inputs remain private.

The two source workflows are `.github/workflows/crm-acquisition-diagnostic.yml` and `.github/workflows/crm-acquisition-diagnostic-cleanup.yml`. The primary defaults to `disabled`. A proposal requires protected rehearsal secrets `FSS_DIAGNOSTIC_STORAGE_APPROVAL_JSON` and `FSS_DIAGNOSTIC_CONFIGURATION_JSON`; lifecycle requires `FSS_DIAGNOSTIC_LEASE_JSON` and `FSS_DIAGNOSTIC_GOOGLE_INPUT_JSON`. Preserve exact UTF-8 approval bytes, including any trailing newline, when computing the public `reviewed_sha256` input. Existing normal rehearsal role, certificate and API/worker repository secrets are still required. The proposal fixes subnets to `us-east-1a,us-east-1d`; the reviewed configuration hash must match. No setup or effective write permission is established by source publication.

The private normalized Google input carries `oidc` and `gmail` objects, each with `client_id`, `client_secret`, `project_id` and `redirect_uris`. Require the reviewed isolated project and the exact single isolated redirect for each real Web client. These operator-supplied metadata and review references do not cryptographically prove project ownership; later real consent and callback observations remain necessary. Do not paste secret values into chat or public issue/workflow inputs.

Backup checks the exact original attempt's job and step evidence before assuming AWS access. Disabled, proposal-only, skipped-application and already-successfully-cleaned runs make no backup cloud call. Missing evidence refuses recovery rather than implying absence. Cleanup after an attempted application still requires the durable original intent/index and exact owned configuration.
