# Delegated-worker-only Terraform root

Source-only isolation. This directory calls only `../terraform/modules/delegated-worker`, not the sourcing root. It contains no sourcing, SES, S3 resource, DNS, budget, watchdog, backend-bootstrap or remote-state definitions. The S3 backend declaration is state storage configuration only, not an S3 resource.

## Preserved behavior

The shared module is the former `cloud/terraform/delegated-worker.tf` implementation with only its two archive paths parameterized. Both roots pass the same root-relative source and output paths. The source still resolves to `cloud/lambdas/delegated-worker/dist`; each root writes its own `.build/delegated-worker.zip`. Terraform does not build the worker.

Defaults remain worker off, activation review false, schedule off, research off, workspace empty and Google client ID empty. Account, region, names, IAM path, account allowlist and provider tags retain the legacy defaults. The providers retain `hashicorp/aws ~> 5.0`, `hashicorp/archive ~> 2.4`, and Terraform `>= 1.9.0`. No additional provider or service dependency is introduced.

The implementation retains the 256 MiB / 60-second / concurrency-2 Lambda, 7-day logs, API throttles 5 burst / 2 rate, exact routes and existing handler authentication contract, table deletion protection / PITR / TTL behavior, IAM scope and conditions, KMS rotation / deletion window, optional five-minute schedule and retry limits. API Gateway authorization settings and the Lambda handler are unchanged. This extraction does not independently validate application authentication. Terraform still handles parameter names/ARNs only, never SecureString values. Opting in is not a grant, send approval, budget approval or runtime acceptance.

## Mandatory backend and state-ownership review

No backend is created and no existing backend or state is assumed. `backend.hcl.example` is an example with intentionally unresolved identifiers, not runnable configuration. There is no checked-in `backend.hcl` or approved activation configuration.

Before any initialization or live work, the parent/reviewer must explicitly approve and record:

1. The target AWS account, region, operator identity, and which single root/state will own this worker. The legacy naming defaults intentionally collide if both roots try to own the same worker. Never enable both roots for the same resources.
2. Whether any worker resources or state already exist. Do not infer absence from disabled defaults or an empty new backend. Inspect ownership under a separately approved read-only process. Preserve unrelated sourcing resources and all legacy outputs.
3. The reviewed state bucket, distinct worker state key, lock table and state KMS key, including existence, access scope, encryption, versioning/recovery and locking. State-key separation is not IAM isolation. Storage/locking provisioning or permissions changes require a separate design and approval and are not supplied here. Never reuse `cloud/terraform.tfstate` or the sourcing backend configuration unchanged.
4. If there is no existing worker, independently review a fresh worker-only plan after the backend and activation gates. Disabled defaults should have no managed worker resources and no archive read/build requirement.
5. If a worker already belongs to the legacy state, stop activation of this root until a separately reviewed, backed-up, locked worker-only state ownership transfer is designed. Do not disable the old worker and apply as a migration: that requests destruction. Do not import into a second state while the old state still owns it. Do not migrate/copy the entire sourcing state to this root. No cross-state transfer is implemented or authorized by this change.

The moved blocks in `cloud/terraform/delegated-worker.tf` cover all 15 managed resource blocks and the archive data block, including count instances and route keys. They preserve addresses **within the legacy state** by moving them under `module.delegated_worker`. They do not transfer state across roots/backends. Retain them for users upgrading from the original addresses. The legacy `delegated_worker_endpoint` output forwards the same module value, including null when disabled. All other legacy outputs/files are untouched.

## Local validation completed

The extracted implementation and both roots passed source review, 75 infrastructure regression tests, actual Terraform 1.15.8 formatting and backend-disabled validation. Nine actual Terraform mock-provider plan tests passed using AWS 5.100.0 and archive 2.8.1 schemas. Every test uses `command = plan`, with both providers mocked.

Observed defaults: zero resources and null endpoint. Enabling the worker with schedules/research/Google off produces 27 managed creates in the mock plan, all below the worker module. Opting into the schedule adds exactly three resources. Missing activation review, missing workspace and malformed workspace fail their expected preconditions. Tests assert routes, IAM, retention and resource limits. These are offline results, not a live deployment plan or cost approval.

The legacy root including all 16 moved blocks passed real parsing/type validation. No existing state was supplied: this is NOT evidence of a safe live state migration. No backend, state object, cloud resource or grant was created or changed. Provider downloads and lock files were isolated in disposable scratch directories. Review and pin the deployment provider lock file before any actual deployment.

To repeat offline checks, use a scratch source copy and an empty environment/HOME, initialize **only with `-backend=false`**, then run `terraform validate` and `terraform test`. Never substitute an ordinary live `terraform plan` or `apply` for the mocked tests. The legacy root must be evaluated against its real approved ownership/state before any future apply. Do not use targeting to hide unrelated resources.

## Pairing operator

The separate [pairing operator](../lambdas/delegated-worker/OPERATOR.md) prepares a short-lived bootstrap only after explicit execution, private output reservation and exact AWS identity/table checks. It does not deploy this root, pair the desktop, activate schedules, or grant Google access. Deployment and live issuance remain separately approved actions.
