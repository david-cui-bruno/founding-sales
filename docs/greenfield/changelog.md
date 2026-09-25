# FSS changelog

One line per merged change, newest first:

```
- YYYY-MM-DD PR <n> (<lane>): <what changed for the founder or operator>
```

Add the line at the top, in the pull request that makes the change. Say what the founder or the operator will notice, not how it was built; the pull request and the code say how. From 25 September 2026 this replaces the numbered release records that `release.md` used to collect, and a decision is a line here too unless it changes an interface or a safety rule (`docs/decisions/README.md`). What is still unverified lives in `release.md` 8.1, not here.

The lines from 21 to 25 September 2026 were seeded from the release records 8.0 to 8.0av, one line each, dated as the record dates itself. The bracketed number ending each names its record in [`release-records.md`](release-records.md). Changes merged in those days without a record of their own are not listed; `git log --merges` has them.

- 2026-09-25 PR 231 (g90): an address added or imported from the Mac is checked by the worker (its domain's MX, or an A record) and becomes usable, or invalid when mail cannot reach it; the Firm page shows Checking…, Deliverable domain — usable, or Mail can’t reach this address — invalid, with Check again [8.0aw]
- 2026-09-25 PR 230 (g93): a rehearsal no longer runs the mutation check, which runs nightly only; mutation entries go in one file per area under `scripts/mutations/`; `release.md` is only the runbook, with the old records in `release-records.md`; and a change is one line here
- 2026-09-25 PR 229 (g89): the bare `npm test`, `npm run typecheck` and `npm run lint` at the root run the greenfield product, `npm ci` builds nothing of the old app, the old app's scripts are `legacy:*`, and its macOS CI jobs run only when a change touches it [8.0av]
- 2026-09-25 PR 227 (g86): a task that is not ready refuses every request with 503 `not_ready`, the upgrade notice names the real update channel, production plans stop showing a parameter-group change, the job-age alarms fire on the first minute past five and fifteen minutes, and the updater refuses a Mac below the build's minimum macOS [8.0at]
- 2026-09-25 PR 228 (g88): the founder can write, approve and publish a sequence and enrol a contact from the Mac, review the new dates before resuming, pick which conversation an ambiguous reply belongs to, confirm a captured number, and edit Settings with typed controls instead of JSON [8.0au]
- 2026-09-25 PR 226 (g87): a mailbox's cap raise has to be earned by sustained healthy sending, sends stop at the account's daily headroom counting a person's own sends, and the personal-Gmail guard counts sends in doubt and every recipient [8.0as]
- 2026-09-25 PR 224 (g85): the Gmail push objects moved to their own Terraform root, so a production plan, an image-only release included, no longer needs a Google login [8.0ar]
- 2026-09-25 PR 225 (g84): the founder can add firms and import them from the Mac and record calling postures in Settings, and Home keeps Today current without a Refresh [8.0aq]
- 2026-09-25 PR 223 (g83): Callie checks the update channel at launch and installs a verified update itself, relaunching without a question [8.0ap]
- 2026-09-25 PR 222 (g81): each critical alarm e-mails on its own, the load balancer asks readiness, each task gets only its own secrets, and a journal write failure fails the command and alarms [8.0an]
- 2026-09-25 PR 220 (g80): an app-only release is one rolling deployment that ends only when the running digests are the release's, one-off task records are bound to their invocation, and the smoke checks the sending state the operator expects [8.0am]
- 2026-09-25 PR 221 (g82): a sequence step held by a cap, a window or a pause runs again when it is due, and a step stranded by a worker crash is settled from its fence [8.0ao]
- 2026-09-25 PR 219 (g74): CI builds and publishes the images, a weekly full rehearsal runs against them, and a release manifest binds the record to the checkout, the run and the digests [8.0al]
- 2026-09-25 PR 218 (g79): a logged call applies its sequence step and keeps its ticket and number, a callback without a time or a wrong number is recorded instead of refused, and "just now" is the server's clock [8.0ak]
- 2026-09-25 PR 217 (g78): the Mac reads every API answer through the shared contracts, and the API's desktop version check is a ceiling, so a desktop-only release no longer needs an API deploy first [8.0aj]
- 2026-09-25 PR 216 (g77): a send rechecks replies, opt-outs, holds, the enrollment and the mailbox's sync under one lock just before it claims, closing six audit items before automated sending [8.0ai]
- 2026-09-25 PR 211 (g71): enabling sending needs the release record stored in production, and the send gate checks the running image digests against it (migration 0017) [8.0ag]
- 2026-09-25 PR 213 (g73): after a restore, the Sent-folder step tombstones a send whose fence the restore lost, so a restored sequence cannot send the same email twice [8.0ah]
- 2026-09-25 PR 210 (g70): a schema release stops both services before the Terraform apply, the apply no longer moves their counts, and the deploy refuses unless both are at zero [8.0af]
- 2026-09-25 PR 209 (g69): Administration's sending section shows again for admins, and Home asks to attest a saved calling number instead of saying there is none [8.0ae]
- 2026-09-25 PR 206 (g65): Home is Today, with the date, the four lanes, last-seven-days figures and a Needs you list (desktop 1.0.3) [8.0ad]
- 2026-09-25 PR 205 (g62): the mutation check runs nightly on main instead of on every pull request, and alarm e-mail comes only from the critical and warning composites [8.0ac]
- 2026-09-25 PR 201 (g60): a salesperson registers and attests the number they call from in Settings, so Today can offer Call, and the restore drill's dial probe has a subject [8.0ab]
- 2026-09-24 PR 199 (g56): a restored database opens restore holds, from the worker at startup on a generation mismatch or by `fss admin restore-holds open`, and the drill checks it at step 1a [8.0aa]
- 2026-09-24 PR 198 (g58): each connected mailbox is checked once a minute, so the heartbeat alarm stops flapping on a healthy worker, and Gmail watches renew daily [8.0z]
- 2026-09-24 PR 192 (g51): every worker metric carries a unit CloudWatch accepts, one refused datum no longer drops the rest, and the metrics loop no longer decides the worker's health check [8.0y]
- 2026-09-24 PR 191 (g50): the Mac's "This Mac" card has a Mailbox row with Connect Gmail (desktop 1.0.1), and the API accepts desktop 1.0.1 [8.0x]
- 2026-09-24 PR 190 (g49): recorded the thirteenth full run, which passed every step but the drill; the drill stopped at the baseline handoff (no code change) [8.0w]
- 2026-09-24 PR 188 (g47): the production-untouched guard compares durable resources and sets aside ECS tasks, which ECS forgets about an hour after they stop [8.0v]
- 2026-09-24 PR 187 (g45): the API accepts Google's real discovery document, so production sign-in works, and a refused token exchange says why [8.0u]
- 2026-09-24 PR 186 (g44): a full rehearsal renews its AWS session before the drill and before the teardown, so a run longer than an hour still cleans up and checks production [8.0t]
- 2026-09-24 PR 185 (g43): production deployed and verified at `66203322`, smoke six of six; a redeploy no longer re-puts the runtime database secret, and two rehearsal runs cannot overlap [8.0s]
- 2026-09-23 PR 184 (g41): the canary-age metric is the newest canary's scheduler-to-worker latency, so the production smoke no longer fails in the gap between quarter-hour canaries [8.0r]
- 2026-09-23 PR 183 (g40): the rehearsal seeds the evidence the restore drill reconstructs (a send, a reply, an opt-out, a manual suppression, a CRM edit); production is never seeded [8.0q]
- 2026-09-23 PR 182 (g39): a script bootstraps the first workspace and its admin, and the admin's first sign-in adopts that account [8.0p]
- 2026-09-23 PR 181 (g38): the schema-range refusal checks launch the real images and read the container's exit code, and a first release with no previous image records `skipped_no_previous` [8.0o]
- 2026-09-23 PR 180 (g37): the deployment role may list its suppression-journal bucket but never read it, so an apply no longer mistakes the bucket for gone and recreates it [8.0n]
- 2026-09-23 PR 179 (g36): every secret entry is filled before any task names it; the rehearsal fills all eight, and production fills every entry before section 4.1 [8.0m]
- 2026-09-23 PR 178 (g34): the commands that run as the migration identity are one list, and the deploy script is checked against it [8.0l]
- 2026-09-23 PR 177 (g33): the API, the worker and the `fss` tool connect to the database over verified TLS (`verify-full` and the RDS certificate bundle) [8.0k]
- 2026-09-23 PR 175 (g32): `fss migrate` runs without the runtime connection, and a failed one-off task's log is fetched and kept [8.0j]
- 2026-09-22 PR 172 (g28): four deploy and full-stage stoppers found by the independent review fixed before the discovery pass: the migration entry's shape, the restore's placement, the rehearsal's DNS path and the teardown's order [8.0i]
- 2026-09-22 PR 170 (g25): the rehearsal role holds a guarded wide allow for one discovery pass, the exact policy is derived from its CloudTrail record, and production is never widened [8.0h]
- 2026-09-22 PR 169 (g24): the rehearsal role reads the RDS-managed master secret under the global tag key, the one the IAM simulator evaluates [8.0g]
- 2026-09-22 PR 168 (g23): RDS may create its managed master secret in the deployment role's session, and the rehearsal keeps its reports artifact [8.0f]
- 2026-09-21 PR 164 (g19): both deployment roles may describe any KMS key, because RDS describes the AWS-managed Secrets Manager key while creating the database; PR 163's five-minute wait is removed [8.0e]
- 2026-09-21 PR 160 (g16): the first `create` run reached AWS and returned 25 errors; the deployment-role policies are rendered from code and checked by simulation before they are put [8.0d]
- 2026-09-21 PR 158 (g12k): the rehearsal has stages, plan, create, deploy and full, and only `full` is the release gate [8.0c]
- 2026-09-21 PR 156 (g12i): the rehearsal apply passes every variable the root requires, and the teardown gets them from `run.auto.tfvars.json` [8.0b]
- 2026-09-21 PR 155 (g12h): the deploy runs the migration, the drill runs as one-off tasks inside the VPC, and the release suite runs against the runner's own PostgreSQL [8.0a]
- 2026-09-21 PR 153 (g12f): the first credentialed rehearsal: the production-inventory read is exempt from the rehearsal's own guard and printed by the dry run, and the teardown tolerates a run that created nothing [8.0]
