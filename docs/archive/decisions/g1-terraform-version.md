# G1: the Terraform version this lane actually used

**Date:** 19 September 2026 · **Lane:** G1 infrastructure · **Status:** a deviation from the lane brief, reported rather than hidden.

## The brief

> Terraform 1.5.7 is at `/opt/homebrew/bin/terraform`.

and, in the acceptance list:

> `terraform validate` clean for all modules and both roots; `fmt` clean; `terraform test` assertions pass offline.

## Why those two cannot both be satisfied

Terraform 1.5.7's `terraform test` is the old experimental command. Its own help text says so:

> This is an experimental command to help with automated integration testing of shared modules... For any that it finds, it will perform Terraform operations similar to the following sequence of commands in each of those directories: `terraform validate`, `terraform apply`, `terraform destroy`.

It **applies**. There is no offline mode, no `.tftest.hcl` file format, no `run` block, no `assert`, no `expect_failures` and no `mock_provider`. The modern test framework arrived in 1.6 and `mock_provider` in 1.7. Using 1.5.7 for `terraform test` would mean either writing no tests or attempting real infrastructure, and the second is forbidden by every other rule in the brief.

`terraform fmt` in 1.5.7 also refuses `.tftest.hcl` outright: *"Only .tf and .tfvars files can be processed with terraform fmt."*

The repository already assumes newer. `cloud/worker-terraform/versions.tf` declares `required_version = ">= 1.9.0"` and `cloud/worker-terraform/tests/worker_contract.tftest.hcl` uses `mock_provider` with `override_during = plan`. 1.5.7 cannot validate or test the existing worker root either.

## Decision

Use **Terraform 1.15.8**, which is already installed on this machine at `/Users/davidcui824/.local/bin/terraform`, for `fmt`, `init -backend=false`, `validate` and `terraform test`. Pin CI to the same 1.15.8 so the formatting and the assertions cannot drift between a local run and the gate.

Declared floors:

| Where | `required_version` | Why |
|---|---|---|
| every module | `>= 1.9.0` | matches the existing repository convention |
| both roots | `>= 1.10.0` | the S3 backend uses the native state lock file (`use_lockfile`), which spec 4.1 asks for and which 1.10 introduced |

The security constraint the brief was protecting is untouched: every test is `command = plan` against `mock_provider`, `init` is always `-backend=false`, no backend is ever configured, and no AWS or Google credential exists on this machine or in the offline CI job. The CI job additionally fails if any cloud credential variable is set.

## For the coordinator

If 1.5.7 is a hard requirement for a reason this lane does not know about, the fallback is: keep `fmt` and `validate` on 1.5.7, drop every `.tftest.hcl` file, and replace the assertions with a Node test that parses the HCL. That is strictly worse — it asserts against text rather than against a plan — so it is not what this lane did, but it is the available alternative.
