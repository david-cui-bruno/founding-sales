# Rehearsal capacity zones — issue 473

The public Terraform seam is the actual Availability Zones of the private database subnets, exported by network → stack → rehearsal. Tests use the AWS provider mock and `command = plan`; they configure no backend and call no cloud service. Rehearsal's `availability_zones` feeds only the shared stack's `rehearsal_availability_zones`. The permitted ordered pairs are `us-east-1a/us-east-1b` (default) and `us-east-1a/us-east-1d` (the capacity-bearing alternative reported by AWS in run 37825115424).

Production keeps its literal `a/b` pair. The shared stack's existing `environment_guard` refuses a production caller that passes the alternative. The production root gains no zone input. Database class, storage, roles, credentials, secrets, namespaces and sending flags are outside this change.

The workflow seam is its actual variables-writing Python, executed with controlled environment values. The optional dispatch choice reaches Python through `env`, is validated there, and is saved in the existing `run.auto.tfvars.json` that Terraform loads for plan, create and teardown. Deploy reads this same applied stack's outputs. The selection is never reconstructed in a later step. Tests cover both pairs and refusal of duplicates, another region and unsupported pairs; existing teardown and prefix guards remain mandatory.

## Red → green receipts

- Root captured the first mocked rehearsal plan before implementation: 16 passed, 1 failed. The actual private subnets remained `us-east-1a/us-east-1b` despite an explicit `a/d` input. Receipt: `.context/rehearsal-capacity-red.log` in the primary workspace. This is behavioral failure evidence, not a failed test due to a missing import.
- Repeated the same red locally, then implemented the root → stack input: 17 passed. Rehearsal-input validation then failed at the wrong boundary for duplicate zones (18 passed, 1 failed), and passed after the root validation (19 passed). A one-element comma-joined list likewise failed the root-boundary expectation, then passed after enforcing two elements (20 passed).
- A direct production stack caller could pass `a/d` without refusal: 1 passed, 1 failed. The `environment_guard` precondition made both runs pass. A direct rehearsal stack caller could pass another region: 2 passed, 1 failed; bounded stack validation made all three pass.
- The actual workflow writer first omitted the explicit pair from its file: 1 failed. Saving the environment choice made it pass. Its refusal slice initially accepted eight unsupported values (8 failed, 3 passed); Python validation made all 11 pass. The plan/create consumption characterization adds a twelfth passing check. The teardown characterization reads the saved `a/d` pair through the existing real script and controlled Terraform/AWS processes.

Final offline validation: `infra/scripts/offline-gate.sh` passed formatting, structural policy, validation and all 140 mocked runs across 18 module/root directories. The four relevant operations files passed all 76 tests: `rehearsalCapacity.check.ts`, `scenario39.check.ts`, `rehearsalSecretFill.check.ts` and `terraformCrossChecks.check.ts`. Operations TypeScript, focused ESLint, shell parsing, error-severity shellcheck, error-severity actionlint and whitespace checks passed. Plain actionlint reports only the two existing SC2162 informational warnings in the unchanged schema-range reader; the exact base commit has the same findings.

Local red/green, operations and infrastructure receipts are preserved under the ignored `.context/receipts/issue473/` directory in the capacity-fix worktree.

## Release evidence boundary

Runs 37823985419 and 37825115424 failed at RDS creation, before schema migration or application deployment, and retained successful cleanup guards. This source change and its offline checks do not establish a passed schema-64 release rehearsal. A new full isolated rehearsal, teardown and empty-prefix guard are still required before the affected production release. This task performs no live plan, apply, dispatch or provider action.
