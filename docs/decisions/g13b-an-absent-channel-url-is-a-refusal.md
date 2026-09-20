# G13b: an absent update channel is a refusal, not a default

**The fact.** On 20 September 2026 David had set `FSS_API_BASE_URL`,
`FSS_DESKTOP_APP_VERSION` and `FSS_MAC_KEYCHAIN_PASSWORD`. `FSS_UPDATE_CHANNEL_URL` was
**absent**, and for a good reason rather than an oversight: the value is
`distribution_domain_name` from `infra/modules/updates`, which does not exist until the
first production apply, and GitHub will not store an empty repository variable.

**The temptation.** `apps/desktop/scripts/package.ts` already has a default:

```ts
updateChannelUrl: process.env['FSS_UPDATE_CHANNEL_URL'] ?? 'https://updates.usecallie.com/'
```

which is a hostname nobody has applied, pointing at a distribution nobody has created.
A release built on it would install cleanly, run cleanly, check that hostname every six
hours, fail to resolve it, and never update. There is no alarm for that. The only
symptom is a Mac that quietly stops receiving security-critical releases — which is the
one thing 5.3 raises the minimum client version for, and the app would then be blocked
with an update prompt that leads nowhere.

**Decision: the release job refuses, by name, before it builds.** A new step checks
`FSS_API_BASE_URL`, `FSS_UPDATE_CHANNEL_URL` and `FSS_DESKTOP_APP_VERSION`, lists every
absent one in the error, and additionally refuses the placeholder version `0.0.0`. The
default in `package.ts` is left alone: it is what a local smoke build uses, where an
unreachable channel is correct, and removing it would make the smoke path need
configuration it has no use for.

This costs one thing and it is worth stating. Until the production apply has run, **no
release can be built at all**. That is the right answer — there is nowhere to publish a
release to, and nothing to update from — and it is why the order in
`docs/greenfield/release.md` section 2 puts the apply before the desktop build rather
than beside it.

**The host job is unaffected.** It holds no secret and no variable, packages in
`local-smoke` mode with the defaults, and verifies with `--integrity`. It passes on
every pull request today and keeps doing so, which is the property that makes this
refusal safe to add: the path that runs on every change is not the path that needs the
variable.
