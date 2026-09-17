# Delegated-worker Terraform root

The only Terraform root in this repository. It calls `../terraform/modules/delegated-worker`, the single worker implementation, and nothing else. It contains no sourcing, SES, S3 resource, DNS, budget, watchdog, backend-bootstrap or remote-state definitions. The S3 backend declaration is state storage configuration only, not an S3 resource.

## The removed legacy root

Until 17 September 2026 the same module was also instantiated from the legacy sourcing root `cloud/terraform/*.tf` through a compatibility file with same-state `moved` blocks. David destroyed the deployed legacy sourcing stack in account 326255650484 on 17 September 2026 (its eight sourcing Lambdas and the schedule watchdog, their schedules, tables, buckets, the SES identity and its DNS records); the root, its nine Lambda packages, their documents and `tests/infrastructure/terraformHardening.test.ts` were removed from the repository in the batch that followed. `cloud/terraform/` now holds only `modules/delegated-worker`. The deployed worker was not part of the destroy: it is managed from this root under its own state key. This root is the only Terraform owner of the worker.

## Preserved behavior

The module is the former legacy `delegated-worker.tf` implementation with only its two archive paths parameterized. This root passes root-relative paths: the archive source resolves to `cloud/lambdas/delegated-worker/dist` and the output to `.build/delegated-worker.zip` inside this root. Terraform does not build the worker.

Defaults remain worker off, activation review false, schedule off, research off, workspace empty and Google client ID empty. Account, region, names, IAM path, account allowlist and provider tags retain the legacy defaults (`callie-sourcing` name prefix, `/callie-sourcing/` IAM path, `Project=callie-sourcing` and `ManagedBy=terraform` tags) so the deployed worker's names and addresses stay stable. The providers retain `hashicorp/aws ~> 5.0`, `hashicorp/archive ~> 2.4`, and Terraform `>= 1.9.0`. No additional provider or service dependency is introduced.

The implementation retains the 256 MiB / 60-second / concurrency-2 Lambda, 7-day logs, API throttles 5 burst / 2 rate, exact routes and existing handler authentication contract, table deletion protection / PITR / TTL behavior, IAM scope and conditions, KMS rotation / deletion window, optional five-minute schedule and retry limits. API Gateway authorization settings and the Lambda handler are unchanged. This root does not independently validate application authentication. Terraform still handles parameter names/ARNs only, never SecureString values. Opting in is not a grant, send approval, budget approval or runtime acceptance.

## Mandatory backend and state-ownership review

No backend is created and no existing backend or state is assumed. `backend.hcl.example` is an example with intentionally unresolved identifiers, not runnable configuration. There is no checked-in `backend.hcl` or approved activation configuration. This root does not create, migrate or import state.

Before any initialization or live work, the operator must explicitly approve and record:

1. The target AWS account, region and operator identity. This root is the only Terraform owner of the worker; never create a second root or state for the same worker resources.
2. The reviewed state bucket, the worker state key `cloud/delegated-worker/terraform.tfstate`, lock table and state KMS key, including existence, access scope, encryption, versioning/recovery and locking. State-key separation is not IAM isolation. The bucket and lock table predate this root (`cloud/scripts/bootstrap-terraform-state.sh` created them once for the shared account and can only recover its own run); this root does not provision, modify or grant access to them.
3. Whether worker resources already exist under that key. Do not infer absence from disabled defaults or an empty new backend. Inspect ownership under a separately approved read-only process before planning.
4. A human-readable plan reviewed before any apply. Disabled defaults should show no managed worker resources and no archive read/build requirement.
5. Never point this root at the legacy state key `cloud/terraform.tfstate`, and never import or migrate anything from it. If that object still exists in the shared bucket it is the emptied state of the destroyed sourcing stack, not a source of worker resources.

## Local validation

Offline checks only. `tests/infrastructure/delegatedWorkerTerraformIsolation.test.ts` reads this root and the module as text and asserts that the module is the only implementation, that inputs, defaults, limits, routes, IAM scope and the backend example are unchanged, and that `cloud/terraform/` contains nothing but the module. `tests/infrastructure/delegatedWorkerRouteParity.test.ts` matches the module's routes against the handler. `tests/worker_contract.tftest.hcl` holds the Terraform mock-provider plan tests for this root and the module; every run uses `command = plan` with both providers mocked.

Observed at extraction (September 2026) with Terraform 1.15.8 and the AWS 5.100.0 and archive 2.8.1 provider schemas: defaults plan zero resources and a null endpoint; enabling the worker with schedules, research and Google off plans 27 managed creates, all below the module; opting into the schedule adds exactly three resources; missing activation review, missing workspace and malformed workspace fail their preconditions. These are offline results, not a live deployment plan or cost approval.

To repeat them, use a scratch source copy and an empty environment/HOME, initialize **only with `-backend=false`**, then run `terraform validate` and `terraform test`. Never substitute an ordinary live `terraform plan` or `apply` for the mocked tests. Keep provider downloads and lock files in disposable scratch directories until a deployment provider lock file is reviewed and pinned. Do not use targeting to hide unrelated resources.

## Pairing operator

The separate [pairing operator](../lambdas/delegated-worker/OPERATOR.md) prepares a short-lived bootstrap only after explicit execution, private output reservation and exact AWS identity/table checks. It does not deploy this root, pair the desktop, activate schedules, or grant Google access. Deployment and live issuance remain separately approved actions.
