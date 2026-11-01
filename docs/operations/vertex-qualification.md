# Vertex qualification

Prepared-prospect qualification (one model call per company, `sourcing.qualify`) calls Google `gemini-3.8-flash` on Vertex AI, funded by the GCP credits on billing account "Framewise Health Main". Nothing else moved: opening selector, reply classifier, research extraction, calls, meetings, social and CRM stay on Bedrock, `FSS_MODEL_TRANSPORT=bedrock` and `research_settings.model_name` (`claude-haiku-4-5`) are unchanged.

## How it works

- Model constants: `packages/domain/sourcing/qualificationModel.ts` (`gemini-3.8-flash`, provider key `google_vertex.sourcing_qualification`, price table). `settings/funding.ts` funds provider kind `google_vertex` from credits, so `readCreditSpend`, the credit ceilings and the $50/day credit-model cap apply unchanged.
- Endpoint: `https://aiplatform.googleapis.com/v1/projects/colormyworld-prod-dc824/locations/global/publishers/google/models/gemini-3.8-flash` (`countTokens`, `generateContent`). The model answers only at location `global`.
- Request: temperature 0, JSON `responseSchema`, thinking budget 1,024 tokens, `maxOutputTokens` 4,096 (reasoning counts against it and is billed as output). One attempt, never retried; timeouts 20 s (count) and 75 s (generate). Vertex's `countTokens` ignores the response schema, so the reservation adds a fixed allowance (`QUALIFICATION_SCHEMA_TOKEN_ALLOWANCE`, larger than the measured gap). A 4xx is settled at zero (not billed), a timeout, 5xx or unreadable answer at the estimated cost.
- Credentials: no key anywhere. The worker task role `fss-prod-worker-task` is exchanged at Google STS through a workload identity pool restricted to that role, then impersonates `callie-qualification@colormyworld-prod-dc824.iam.gserviceaccount.com` (only `roles/aiplatform.user`). Non-secret configuration reaches the worker as `FSS_VERTEX_PROJECT`, `FSS_VERTEX_LOCATION` and `FSS_VERTEX_CREDENTIAL_CONFIG`, built by Terraform in production only (`infra/modules/stack`). Without them no qualification is scheduled, and a run that starts finishes `credit_route_unavailable`; there is no Bedrock fallback. Worker start logs `qualification_model` (`configured`, `vertex_unset`, or the variable that is wrong).
- Prompt version `qualification-context-v8`: earlier runs are not reused; the scheduler re-qualifies candidates whose last run has another prompt version (25 per pass). Re-run `qualification-configure --enabled true --evaluation-sha256 …` so auto-admission matches the new version.

## Price

Source: https://cloud.google.com/vertex-ai/generative-ai/pricing (Gemini 3 table, global endpoint), read 1 November 2026. Per million tokens: $0.75 input and $3.75 output (reasoning is output) through 31 December 2026; $1.50 and $7.50 from 1 January 2027. Haiku 4.5 on Bedrock is $1.10 and $5.50, so Gemini is cheaper only until the end of 2026. The table steps at `GEMINI_STANDARD_PRICE_FROM` (2027-01-01T00:00Z); revisit the model choice before then. Credit eligibility of Vertex Gemini spend is not verified by this repo: confirm in the Cloud Billing credits page that the credit applies to `Vertex AI` SKUs of project `colormyworld-prod-dc824`.

## One-time setup (operator, in order)

1. `infra/scripts/gcp-vertex-qualification-setup.sh --dry-run`, then without `--dry-run`, as a GCP account with `roles/iam.workloadIdentityPoolAdmin`, `roles/iam.serviceAccountAdmin` and `roles/resourcemanager.projectIamAdmin` (Owner is enough). It is idempotent: it creates pool `fss-prod-aws`, AWS provider `fss-prod-worker` (account 326255650484, condition `…assumed-role/fss-prod-worker-task/`), the service account and its two bindings, then prints what it granted.
2. `terraform apply` in `infra/roots/production` (adds the three worker variables; rehearsal gets none). `test/ops/terraformCrossChecks.check.ts` keeps the script's names and Terraform's equal.
3. Deploy the worker. Deploying before steps 1 and 2 leaves qualification finishing `credit_route_unavailable` until they land.
4. Smoke from a workstation with application-default credentials: `node --experimental-transform-types scripts/vertexQualificationSmoke.ts "Firm|City|ST|https://site/,https://site/about"` (two real billed calls of a cent or two each). After deploy, confirm one real run ends `selected` with `provider_key=google_vertex.sourcing_qualification`.

## Rollback

Remove the three `FSS_VERTEX_*` variables (or revert the deploy): qualification stops cleanly. Reverting to Bedrock needs a code change; there is deliberately no switch.
