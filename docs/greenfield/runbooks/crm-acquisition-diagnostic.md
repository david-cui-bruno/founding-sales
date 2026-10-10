# Scoped acquisition acceptance environment (#524)

This procedure prepares the separately isolated schema89 candidate. It does not approve a live run, production release, capture activation, AI use or sending. Keep the schema88 release hold and sending safeguards. The ordinary rehearsal root defaults to database `fss`, no diagnostic environment variable, no diagnostic tags and no additional witness policies. Production rejects diagnostic mode.

## Approval prerequisites

Before any cloud plan/apply or private-data acquisition, obtain approval for the separate ephemeral rehearsal resources and cost, exact schema89 commit/API/worker digests, environment UUID and expiry. Independently review the mailbox owner, actual incoming/Sent message IDs, thread IDs, date bounds, disclosure/consent/provider-policy references, retention/deletion and read/unit limits. The normal isolated OAuth callback, permitted Google redirect URI, envelope KMS access and token refresh must work; never copy production tokens or use installed desktop credentials. No infrastructure configuration or fixture evidence substitutes for these approvals.

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

After explicit cloud-operation approval, run the usual isolated root preparation, using an approved state key rather than the default shared rehearsal key:

```bash
terraform -chdir=infra/roots/rehearsal init -backend-config=backend.hcl -backend-config="key=<approved unique rehearsal state key>"
terraform -chdir=infra/roots/rehearsal plan -var-file=<reviewed tfvars.json> -out=<reviewed plan file>
terraform -chdir=infra/roots/rehearsal show <reviewed plan file>
```

Review replacement/create actions, names/tags and both additional IAM policies before the separately approved apply. Follow the existing rehearsal release sequence in `infra/scripts/deploy.sh` and the secret-entry preparation from `.github/workflows/greenfield-release.yml`: derive both database entries from `database_endpoint` and **`database_name` outputs**, fill secret values privately from stdin/file descriptors, migrate with the migration identity, and ensure the app-runtime login before scaling either service. Use actual approved OAuth/session secrets for this diagnostic; ordinary rehearsal fixture secrets cannot establish real consent. Terraform never reads/writes secret values. Do not feed this candidate into production release automation.

## Inspect exact bindings and execute the bounded lifecycle

Read the non-secret output after the approved deployment:

```bash
terraform -chdir=infra/roots/rehearsal output -json crm_acquisition_diagnostic
```

It includes the managed database name/ARN/endpoint, application database secret ARN, cluster ARN, actual API/worker task-definition ARNs, exact propagated tags and scoped witness policies. Both actual task environments receive strict `FSS_CRM_ACQUISITION_DIAGNOSTIC` JSON derived from these outputs, not a manually guessed secret ARN. Confirm the actual running task/image/tag/secret injections independently; planned outputs alone cannot prove the running deployment. Runtime checks the real ECS task and image, RDS/secret metadata and current PostgreSQL server address against RDS DNS before reads.

Use the strict authorization/read/command contracts at `packages/contracts/src/crmAcquisitionDiagnostic.ts` for the following bounded lifecycle. Freeze the exact reviewed grant digest and independent release record. The API allows only auth/OAuth, diagnostic commands and canonical lifecycle; the dedicated worker refuses ordinary capture/send/AI/backfill jobs. Two complete incoming/Sent copies require8 metered HTTP reads/24units; partial/refused/unknown outcomes remain explicit. Never blindly retry an ambiguous read.

Verify actual originals/hashes/directions and unavailable-after-delete through owner reads without logging bodies. Revoke the diagnostic grant, delete remaining copies through the owner lifecycle, and use the existing rehearsal teardown/leftover guard. Account/owner/generation drift, revocation, deletion or missing witness must stop publication. A separately reviewed actual acquisition/deletion acceptance artifact is still required for any production capture authority; this diagnostic never creates it automatically.

## Trusted authority and authenticated requests

Prepare a body-free `CrmAcquisitionDiagnosticAuthorization` document with the approved exact mailbox/account/owner/generation/OAuth observation, deployment/database bindings from the output, implementation commit/digests/schema89/release record, current disclosure hash, independently reviewed consent/policy/expiry references and exact message scope. Obtain its canonical digest using `crmAcquisitionDiagnosticFingerprint` on the schema-parsed document; arbitrary file hashes or raw JSON field order are not the authorization fingerprint. Do not include originals, credentials or tokens.

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
