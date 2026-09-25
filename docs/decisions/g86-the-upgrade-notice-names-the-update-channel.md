# g86: the upgrade notice names the update channel, and production refuses the placeholder

Lane g86, 25 September 2026. A P2 item in the triage of the 25 September audits
("upgradeUrl").

## The gap

`/auth/client-version` published `upgradeUrl: https://callie.example/downloads/mac` from
every deployment, production included. `DEFAULT_UPGRADE_URL` was a placeholder, and
nothing could set anything else.

## Decision

1. **One variable, the API's alone.** `FSS_DESKTOP_UPGRADE_URL`
   (`DEPLOYMENT_ENVIRONMENT_VARIABLES.upgradeUrl`) is read by `readUpgradeUrl` in
   `apps/api/src/bootstrap/deployment.ts` and passed to `createApiServer` by
   `bootstrap/main.ts`. It rides the cluster module's existing `api_environment` input,
   which `infra/modules/stack` fills only when its `desktop_upgrade_url` is not null. No
   cluster variable was needed, and the worker never sees it.
2. **The production root supplies it.** `desktop_upgrade_url` in
   `infra/roots/production/variables.tf` defaults to
   `https://dlcmdaeskewt5.cloudfront.net/releases/darwin-arm64/latest.json`: the signed
   update manifest on production's updates distribution, at the path the desktop reads
   (`CHANNEL_MANIFEST_PATH`). It is a default rather than a tfvars entry, for the reason
   `cpu_architecture` gives. `nullable = false`, and its validation refuses a blank,
   anything but a plain https address, and the `callie.example` placeholder.
3. **Machine-facing, and documented as such.** The manifest is JSON for the updater.
   Since lane g83 the Mac installs from it itself, so the notice is the fallback path. The
   desktop's upgrade screen shows its own fixed sentence and never renders `upgradeUrl`.
   It never did, and `apps/desktop/test/e2e/desktop.spec.ts` now requires the screen to
   carry no address.
4. **Fail closed, in two places.** Outside production an unset variable is the
   placeholder, which is what a laptop, a route test and a rehearsal publish (the
   rehearsal root has no such variable). In production an unset variable, or the
   placeholder by value, is a refusal to start (`DeploymentConfigError`). That is the rule
   `deployment.ts` keeps for every default: a production process does not reach a
   fallback by omission. Any value that is set must be `https:` with no credentials, query
   or fragment, so never a signed URL. The startup line reports `upgrade_notice_source`
   (`environment` or `placeholder`), never the address.

## Why not derive it inside the stack

`module.updates.distribution_domain_name` is in the same stack, so the stack could build
the address itself. The brief asked for a root variable an operator reads in the plan,
and the literal has one owner: the root's default, checked by
`test/release/upgradeUrl.check.ts` against the desktop's manifest path and against the
API's own rule. If the distribution is ever replaced, this default changes with the
desktop's `FSS_UPDATE_CHANNEL_URL` repository variable, and both are the same hostname.

## Release order

The API task definition gains one environment entry, so the production plan replaces the
API task definition and the service rolls. The image that refuses an unset variable in
production only ever runs on a task definition from the same commit's root, which always
sets it. An older image ignores the variable.
