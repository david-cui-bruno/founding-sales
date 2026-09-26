# The rehearsal has no Google provider, and never needed one

Lane G12j, 21 September 2026. Status: decided and implemented.

## What happened

David's third credentialed rehearsal (Actions run 35611374218, commit 845c6ed5) failed
in `terraform plan`, before any AWS call, with two independent errors. The first was:

```
Error: Attempted to load application default credentials since neither `credentials`
nor `access_token` was set in the provider block. No credentials loaded.
  with provider["registry.terraform.io/hashicorp/google"],
  on providers.tf line 33, in provider "google"
```

The rehearsal root had `enable_gmail_push = false` and `gcp_project_id = ""`. That was
not enough, and the reason is worth stating plainly, because two lanes had already read
the code and not seen it: **Terraform configures every provider a configuration
requires, during the plan, whether or not any resource uses it.** `module "pubsub"` sat
in `infra/modules/stack` with `count = var.enable_gmail_push ? 1 : 0`, so both roots
required `hashicorp/google`, so both roots configured it, so the rehearsal asked GitHub
Actions for Google application-default credentials that do not exist and must not.

## Decision

1. **`module "pubsub"` moves to `infra/roots/production`.** It is the only root with a
   Google Cloud project (`callie-fss`). `infra/modules/stack` no longer requires the
   Google provider, and the rehearsal root declares neither the provider nor the
   `gcp_project_id`, `gcp_region` and `enable_gmail_push` variables it used to gate.

2. **The stack takes three strings instead.** `gmail_push_topic`,
   `gmail_push_audience` and `gmail_push_service_account` are what
   `FSS_GMAIL_PUSH_TOPIC`, `FSS_GMAIL_PUSH_AUDIENCE` and
   `FSS_GMAIL_PUSH_SERVICE_ACCOUNT` carry into both task definitions. Each is validated
   for *shape* and not for presence: production's topic and service account are values
   the apply computes, so a presence check would be either deferred or wrong, while a
   malformed literal is something a plan can refuse today. The audience is derived from
   the API hostname and the push path in each root, because it is a property of that
   environment's own webhook and involves no Google resource at all.

3. **Nothing is migrated, because nothing was ever applied.** `infra/modules/pubsub` has
   never been applied in any environment. The evidence: `docs/greenfield/release.md` 8.0
   and 8.0b record what the first two credentialed runs did (the first refused its own
   production-inventory read and created nothing; the second was refused at the apply
   for two unset variables), the third stopped in `plan`, and no production apply has
   happened at all — `docs/greenfield/infra-apply-runbook.md` still opens with "Nothing
   in this repository has ever been applied", and its section 2.2 records the single
   exception, `terraform apply -target=module.stack.module.registry`, which is the ECR
   repositories and nothing else. So there is no state entry at
   `module.stack.module.pubsub[0]` to move, and no `moved` block is needed. The
   production plan David will read is the *first* one to contain these resources, and it
   must show four Google resources created, not moved.

4. **The rehearsal's three values are values, not blanks.** This is the part that was a
   latent failure rather than a tidy-up. Both bootstraps read all three names with
   `required()` (`apps/api/src/bootstrap/deployment.ts`,
   `apps/worker/src/bootstrap/deployment.ts`), and `required()` treats an empty string
   as missing, so the rehearsal's `enable_gmail_push = false` would have produced an API
   task exiting with `FSS_GMAIL_PUSH_AUDIENCE is not set` the moment a rehearsal got far
   enough to start one. No rehearsal ever has. The rehearsal root now passes:

   | Variable | Value |
   |---|---|
   | `FSS_GMAIL_PUSH_AUDIENCE` | `https://<rehearsal api_hostname>/integrations/gmail/push`, derived |
   | `FSS_GMAIL_PUSH_TOPIC` | `projects/fss-rehearsal-no-push/topics/fss-rehearsal-no-push` |
   | `FSS_GMAIL_PUSH_SERVICE_ACCOUNT` | `gmail-push@fss-rehearsal-no-push.invalid` |

   The audience is true: it is the audience a push token delivered to that hostname
   would have to carry. The other two are public placeholders, well-formed so the
   rehearsal parses what production will, and unmistakably unreal so that no rehearsal
   log can be read as evidence that push works — the project does not exist and
   `.invalid` is reserved, so Google can mint no token for that address. Verified
   against the binary rather than assumed: `readApiDeployment` accepts all three in both
   `recorded` and `live` mode and reports `push_topic_source: environment`, and refuses
   the empty strings by name. The rehearsal's `dependencies_mode` default is `live`, so
   "make them optional in recorded mode" would not have helped it; and making them
   optional in `live` would weaken the production refusal that matters.

## The two alternatives rejected

- **A workload-identity credential for the CI job.** A Google service account federated
  to the GitHub OIDC provider, with permission on a rehearsal project. It would cost a
  second cloud trust relationship, a second set of long-lived bindings, and a Google
  project whose only purpose is to be planned against — to prove a code path the
  rehearsal is explicitly not trusted to prove.
- **A dummy `access_token` on the provider block.** One line, and it would have made the
  plan succeed. It also makes every rehearsal plan a configuration that believes it has
  a Google credential, so the first `terraform apply` with `enable_gmail_push` set by
  mistake would fail somewhere inside Google's API instead of at the variable, and the
  rehearsal role's `fss-rh-*` boundary does not exist in Google Cloud to stop it.

## What this does not prove, and already said so

`docs/archive/decisions/g12-what-the-rehearsal-cannot-prove.md` already states that the
rehearsal does not prove Gmail: its Gmail is the recorded fake
(`readGmailDeployment`'s `recorded` branch answers from a fixture and reaches nothing),
and Appendix G 27 — a valid Google signature with the wrong audience or service account
— is exercised offline in `test/release/scenario27.check.ts` with tokens signed by a
fixture key pair. Removing the provider removes a credential requirement, not a proof.
Gmail push is proved in production, at the point where the runbook prints
`gmail_push_topic_id` and the operator makes the `users.watch` grant by hand.
