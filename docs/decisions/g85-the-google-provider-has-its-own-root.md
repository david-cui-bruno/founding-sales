# g85: the Google provider has its own root

Lane g85, 25 September 2026. Audit item O01 (P0) of `GPT6-ASTRA-EXHAUSTIVE-20260925.md`,
"An unrelated Google login blocks every production image plan". David decided the
direction on 25 September: split the Google provider into a root of its own. This
records the choices the lane made inside that decision.

This lane changes no IAM policy, trust relationship or principal. It edits no file under
`infra/modules`, `infra/scripts`, `apps` or `packages`.

## The gap

`infra/roots/production/providers.tf` declared `provider "google"` for `module.pubsub`:
the Gmail push topic, its push subscription, the push service account, and Gmail's
publisher grant on the topic. Terraform configures every provider a configuration
requires before it plans anything. That holds even when no resource in the plan uses
the provider. So every production plan needed application-default credentials for
`callie@usecallie.com`, an image-only release included. The Workspace reauthentication
policy lapses those credentials about every 17 hours, and a lapsed login held back the
deployment of a worker fix. G12j had already removed the same dependency from the
rehearsal (`docs/decisions/g12j-the-rehearsal-has-no-google-provider.md`). Production
kept it, because production really owns the objects.

## Decision

### 1. `infra/roots/production-google` owns the four objects and nothing else

The new root calls `infra/modules/pubsub` with no `count`, passing exactly the arguments
the production root passed: the same service-account stem, endpoint, audience and
labels. It declares only the Google provider and no AWS provider, so it cannot touch an
AWS resource. Its state lives in the same bucket and lock table as production's, under
its own key, `fss/greenfield/production-google/terraform.tfstate`. The key follows the
`rehearsal-registry` precedent of naming the root. It is outside
`fss/greenfield/production/`, so the two production state objects have two locks. It is
also outside `fss/greenfield/rehearsal*`, the only key space `fss-rh-deploy` may touch.

The root is planned and applied rarely: only when a push object itself has to change.
It needs application-default credentials, renewed as `infra-apply-runbook.md` 1.3a
says, and never a key file. `gcp_project_id` defaults to `callie-fss` and `name_prefix`
is fixed at `fss-prod`. So a plan names the objects that exist without anybody typing
either value. `api_hostname` is required, as it is in the production root. Its outputs
are the public identifiers: the topic id and name, the subscription name, the service
account, the audience and the project.

### 2. The production root takes the identifiers as variables, not from remote state

The production root loses the Google provider, its requirement, `module.pubsub`, and
the `enable_gmail_push`, `gcp_project_id` and `gcp_region` variables. It gains two
variables that mirror the rehearsal root's:

| Variable | Default | Validation |
|---|---|---|
| `gmail_push_topic` | `projects/callie-fss/topics/fss-prod-gmail-push` | `^projects/<project id>/topics/fss-prod-gmail-push$` |
| `gmail_push_service_account` | `fss-prod-gmail-push@callie-fss.iam.gserviceaccount.com` | `^fss-prod-gmail-push@<project id>\.iam\.gserviceaccount\.com$` |

The audience is still derived from the root's own `api_hostname` and `gmail_push_path`.
It is a property of the webhook, not of Google, and the Google root builds the
subscription's endpoint and token audience with the same expression.

**Defaults rather than a committed tfvars file.** `infra/.gitignore` ignores every
`*.tfvars`, and `docs/decisions/g12c-the-topology-answers-are-root-defaults.md` settled
that the committed place for a value an apply uses when nobody types anything is the
variable's default. The two identifiers are public, and they are fixed for the life of
the objects: a topic id is its project and name, and a service account's email is its
id and project. The validations refuse the rehearsal's no-push placeholders, a blank,
and any other identity.

**Why not `terraform_remote_state`.** The brief asked whether the deploy role can
already read the Google root's state. It cannot, and it is not meant to.
`infra/scripts/render-deployment-role-policy.sh` renders the state statements
(`ThisNamespacesStateObjects`, `ThisNamespacesStateList`, `ThisNamespacesStateDynamoLock`,
`UseTerraformStateKmsKey`) for `fss-rh` only, through `RENDER_ONLY_FOR`. For `fss-prod`
it renders `NoDeploymentDataAccess` from `infra/policies/deployment-role-policy.json.tftpl`:

```json
"Sid": "NoDeploymentDataAccess", "Effect": "Deny",
"Action": ["s3:GetObject*", "s3:BypassGovernanceRetention", "secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"],
"Resource": "*"
```

`fss-prod-deploy` therefore reads no state object, production's own included. Production
state is read by the backend with the operator's admin profile. A remote-state data
source would authenticate the same way, so it would work today. It is still worse on
three counts:

- It would make every production plan depend on a second state object being present,
  readable and decryptable. That is the same coupling O01 is about, one layer down.
- It would take the identifiers out of review. They would be data read at plan time,
  not a line in a diff.
- No session holding only `fss-prod-deploy` could ever plan production, because the
  deny forbids exactly that read.

Nothing in IAM was widened, and nothing needed to be.

### 3. The objects move by import in the new root and `state rm` in the old one

`terraform state mv` does not cross backends. `infra/roots/production-google/imports.tf`
holds four `import` blocks in the Google provider's documented import formats, built
from the names the module derives. Before anything is written, the new root's first
plan lists all four as imports, plus any attribute where the live object differs from
the configuration. Its apply writes only state.

The production state then drops `module.pubsub[0]` with `terraform state rm`, after a
`terraform state pull` backup. That step needs neither a Google credential nor the
production `-var` list, and it is not a production apply that could carry an unrelated
pending change. Each step can be run again. The alternatives are compared in
`docs/greenfield/google-root-migration-runbook.md`, which is the operator's procedure.
In short:

- carrying the state objects between local copies moves the exact objects, but writes
  before any plan can be read, so it is the runbook's fallback B;
- applying a `removed` block would need Google credentials and a full production apply.

The import blocks stay in the file. Once an address is in state its block is a no-op.
Against a project where the objects do not exist, the blocks refuse the plan rather
than create a second, empty set.

### 4. A `removed { destroy = false }` block is the net under the migration

`infra/roots/production/main.tf` carries `removed { from = module.pubsub  lifecycle {
destroy = false } }`. Without it, a production plan taken between the merge and the
migration's `state rm` would propose to **destroy** all four objects, because the
configuration no longer declares them and the state still does. With it, the same plan
shows them as "will no longer be managed by Terraform". Such a plan still needs
application-default credentials, because the state names Google objects, and applying it
would only do the state removal early.

Destroying the objects would matter:

- A deleted topic stops the Gmail watch until the next renewal names a new topic.
- Gmail's publisher grant needed a project-level exception to the organisation's
  domain-restricted sharing policy when it was first made (`docs/greenfield/release.md`
  8.0n), so a recreated grant may be refused outright.

After the migration the block matches nothing. A later lane may delete it once the
running log records the migration.

## What did not change

- **The rehearsal root.** It declared no Google provider before this lane, and still
  declares none. It still plans and applies with no Google credential.
  `greenfield-release.yml` is untouched.
- **The task definitions.** `FSS_GMAIL_PUSH_TOPIC`, `FSS_GMAIL_PUSH_SERVICE_ACCOUNT` and
  `FSS_GMAIL_PUSH_AUDIENCE` carry the same three strings they carried after the 23
  September apply. The migration's step 1 compares the defaults with the production
  state's recorded outputs before anything moves.
- **`infra/modules/pubsub`**, the state bucket, the lock table, every existing state
  object, and every IAM policy, trust and principal.

## What another lane owns

- **`infra/scripts/offline-gate.sh` (lane g80).** Its Google check still allows
  `^infra/roots/production/` and would flag the new root. It should allow
  `^infra/roots/production-google/` in place of `^infra/roots/production/`, and add the
  fourth state key to its distinctness list. The pull request body has the exact diff.
  CI's `greenfield-infra.yml` does not carry that check. `test/release/googleRoot.check.ts`
  holds the same rule in the gate every pull request runs, in its stricter,
  post-migration form.
- **Prose outside this lane's files.** `docs/greenfield/infra-apply-runbook.md` 1.3a,
  3.0 and 3.2, `release.md` 1.7 and its section 4 `gcp_project_id` row, the infra README's
  "three roots", `docs/greenfield/accounts.md`'s list of roots to re-initialise, and the
  `gmail_push_topic` and `gmail_push_service_account` descriptions in
  `infra/modules/stack/variables.tf` all describe the tree before this lane. `release.md`
  8.0ar says so.

## What this does not prove

Nothing here has run against a real backend or Google. Checked offline:

- `terraform fmt -check` and `terraform validate` (after `init -backend=false`) pass for
  both roots;
- the production root's provider lock lists only `hashicorp/aws`;
- the release check passes.

The `terraform test` runs in both roots are CI's (`greenfield-infra.yml`). Two things
only the migration will show:

- whether the Google provider's import records labels as empty, which is the runbook's
  acceptable label-only variant;
- that the first production plan without a Google credential runs to the end.
