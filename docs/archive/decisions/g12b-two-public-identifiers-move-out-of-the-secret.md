# Two public identifiers move into the task environment, and when the fallback goes

**Lane:** G12b · **Spec:** 5.1, 12.1, 12.3 · **Files:** `infra/modules/stack/{main,variables,outputs}.tf`, both roots, `apps/{api,worker}/src/bootstrap/deployment.ts`

## What was open

G12 needed two strings that nothing carried: the Pub/Sub topic `users.watch` registers
against (`gmail_push_topic_id`, which existed only as a Terraform *output*) and the
Workspace domain a connectable mailbox must belong to (nowhere at all). Carrying them
would have meant editing `infra/modules/stack`, which that lane could not do, so both
travelled in the JSON the operator pastes into `fss-prod/google-gmail-oauth-client`:

```json
{"client_id": "...", "client_secret": "...", "push_topic": "...", "hosted_domain": "usecallie.com"}
```

G12 said plainly that this was not ideal — two public identifiers living inside a
secret — and named the tidier fix. This is that fix.

## The decision

`infra/modules/stack`'s environment map gains two entries, so both services get both:

```
FSS_GMAIL_PUSH_TOPIC     = var.enable_gmail_push ? one(module.pubsub[*].topic_id) : ""
FSS_GOOGLE_HOSTED_DOMAIN = var.google_hosted_domain
```

`google_hosted_domain` is a new root variable on both roots, defaulting to
`usecallie.com`, with the same regex validation at the root and in the module. An empty
value is refused rather than defaulted: an empty `hd` restriction admits every Google
account there is, and a variable whose absence quietly widens an authorization boundary
is the kind of thing that is discovered later.

`FSS_GMAIL_PUSH_TOPIC` is empty rather than absent when push is off, so a bootstrap
reading the name gets "not configured" rather than an unknown key at plan time and a
surprise at boot. The stack also now outputs `worker_environment` beside
`api_environment`, because a root test that could only see the API's container could
not tell whether the worker had been given the same values.

### Three consequences worth stating

**The domain is one value, not two.** The API uses it for the `hd` restriction at
sign-in (5.1) *and* for which mailbox may be connected (12.1). Reading them from one
variable means the two cannot drift; the API test asserts
`auth.oidc.hostedDomain === mailConfig.hostedDomain`.

**Each Google secret is now two fields.** `client_id` and `client_secret`, required by
name. `google-oidc-client` no longer pretends to need a `push_topic` it has nothing to
do with.

**The bootstrap reads the environment first.** Not "instead": `resolvePublicIdentifier`
prefers the environment, falls back to the secret's field, and refuses when neither has
one, naming both places it looked. The environment wins when both are present so that
an operator who has re-applied the infrastructure does not also have to rewrite a
secret, and so that the apply is the single source once it has run.

## When the fallback goes

The fallback is deliberately temporary. It exists because expand-migrate-contract
applies to configuration as well as to schema: the images that read the environment and
the apply that supplies it do not land in the same instant, and a process that refused
the older shape would turn an ordering mistake into an outage.

Remove `push_topic` and `hosted_domain` from `readGoogleClientBundle` (making the
`optional()` helper unnecessary) and delete the `fallback` parameter of
`resolvePublicIdentifier` in both bootstraps **when all three of these are true**:

1. The production apply carrying the two environment entries has been applied, and both
   services have been redeployed on top of it.
2. A production `--selftest`, or the `api_configuration` / `worker_configuration`
   startup line of the running tasks, reports `push_topic_source: "environment"` and
   `hosted_domain_source: "environment"`. That is what the two source fields exist for;
   they are the observable that makes this condition checkable rather than assumed.
3. Both Secrets Manager entries have been rewritten to the two-field shape, so nothing
   downstream is still reading a field that is about to stop being read.

Until then, a deployment that satisfies only the old shape starts and says so. After
then, the refusal is the only behaviour and the release that removes the fallback is
the one that also drops the sentence from `docs/greenfield/release.md` 1.6. The
conservative default if this note is read and nobody is sure: leave the fallback. It
costs one branch and one boolean in a log line, and removing it early converts a
configuration lag into a refusal to start.

## What this does not change

The client secrets stay in Secrets Manager and are never in the environment as values —
only the *names* `google-gmail-oauth-client` and `google-oidc-client` appear there,
because that is how the ECS `secrets` block injects them. The cluster test still refuses
any environment variable name matching `password|secret|token|credential|private_key`,
and that assertion is untouched.
