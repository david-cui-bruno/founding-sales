# The rehearsal apply names every variable the root requires, and leaves the teardown the same values

Lane G12i, 21 September 2026. Status: decided and implemented.

## What happened

The second credentialed rehearsal (Actions run 35602423640, commit 02cd48e7) initialised its backend for the first time and was refused at the apply:

```
The root module input variable "api_schema_range" is not set
The root module input variable "worker_schema_range" is not set
```

Both variables have no default in `infra/roots/rehearsal/variables.tf`. The workflow's apply passed six of the root's eight required variables. The production runbook passes all eight, because a person reads `variables.tf`; the workflow was written from the runbook's earlier shape and nothing compared the two lists afterwards. Neither offline check could see it: the dry-run job never runs `terraform`, and `terraform test` in the offline gate supplies its own variables.

## Decisions

1. **The ranges come from the source, in the workflow, the way the images workflow already reads them.** A step before the apply imports `packages/domain/db/schemaRange.ts` and exports the four numbers to the job environment. Typing `{min=14,max=14}` into the workflow would be a literal that a lane widening a range has to remember; the images workflow rejected that in G5b for the same reason.

2. **The create step writes `run.auto.tfvars.json` beside the root, and the teardown refuses to destroy without it.** `terraform destroy` requires the same variables as `apply`. The teardown runs on `always()`, in a later step, after the create step's shell and its values are gone, and it passed only `name_prefix`. On any run that got past the apply the destroy would have been refused and the environment left standing at hourly cost, with the report blaming a variable. The file holds identifiers (a prefix, two image references, a certificate ARN, a hostname, two ranges) and never a value from a secret entry; `infra/.gitignore` already ignores `*.tfvars.json`. The refusal is explicit so that a manual teardown from a fresh checkout knows what to recreate (release.md section 3, step 13).

3. **The test derives the required list rather than naming it.** Scenario 22 splits `variables.tf` into blocks, keeps those without a `default`, and asks the workflow for `-var="<name>=` and for `"<name>": ` in the tfvars file for each. The next required variable a lane adds to the root will fail the pull request rather than the rehearsal. A mutation removes one `-var` line and requires the suite to go red.

## What this does not change

The images. Nothing under `.github`, `infra/scripts`, `test` or `docs` is copied into either image, so the digests David pushed from 02cd48e7 remain the release's identity and the release commit moves to this merge.
