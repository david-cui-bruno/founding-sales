# Cutover runsheet (slice S6)

The exact commands David runs, in order, and what each prints when it worked. Every step is reversible or
re-runnable except the two marked otherwise. Nothing in this runsheet sends an email, dials a number or books
anything, and no step deletes an old record: deletion is S7, after three consecutive real mornings.

Read this once end to end before starting. Steps 1 to 5 can be done the evening before; steps 6 to 10 are the
morning of the cutover.

## Before you start

- The old app must be **closed** for step 1. It stays closed afterwards; you do not use it again.
- Your shell needs AWS credentials for the operator role (Identity Center or MFA, no static keys).
- Have the worker's API Gateway host to hand: you need it in step 7.
- Work from a clean checkout at the commit you intend to install. Every marker and verifier below refuses a dirty
  or untracked tree.

Throughout, `<ACCOUNT>` is the twelve-digit AWS account id, `<REGION>` the region, `<TABLE>` the DynamoDB table
name and `<WORKSPACE>` the workspace id. `$OP` is shorthand for the four of them:

```
export OP="--account <ACCOUNT> --region <REGION> --table <TABLE> --workspace <WORKSPACE>"
```

---

## 1. Export the three Mac-only record kinds

The one step that opens the old database. Read-only, and it refuses to run while the app is open.

```
cd <repository>
npm run legacy:export:cutover
```

**On success** it prints a JSON report and nothing else:

```json
{
  "kind": "cutover_export",
  "path": "/Users/<you>/Callie Backups/cutover-export-2026-09-__.json",
  "counts": { "callbacks": 0, "neverCall": 0, "templates": 0 },
  "bytes": 000,
  "sha256": "…64 hex…",
  "schemaVersion": 30,
  "phone": "confirmed"
}
```

Read the three counts. They are the callbacks you promised and have not made, the never-call marks you recorded,
and the template bodies you edited away from the seeded text. Zero is a perfectly good answer for any of them.

**Open the file and read it.** It is yours to check before anything uses it: firm ids, dates, your own notes, your
own template text and one sha256 digest of the local phone proof. There is no token, no key and no path in it.

If it prints `CUTOVER_EXPORT_FAILED lock`, the old app is still running — quit it and run again. A second export
on the same day is refused (`… write`) rather than replacing the first; the first file is the evidence.

## 2. Copy dry run

Reads the old sort keys and prints what it *would* write. It writes nothing at all.

```
node cloud/lambdas/delegated-worker/out/operator-pairing.cjs $OP --cutover-copy --dry-run
```

(Build the tool first with `node cloud/lambdas/delegated-worker/build-operator.mjs` if `out/` is empty.)

**On success** it prints a table and exits 0:

```
source                                                     target            count  would-write  already-present  refused
---------------------------------------------------------  ----------------  -----  -----------  ---------------  -------
ACCOUNT# (with the derived state and zone)                 FIRM#               nnn          nnn                0  0
ACCOUNT# sources, claims and research revision             EVIDENCE#           nnn          nnn                0  0
REPLY_TEMPLATE_STATE# and the seeded bodies                TEMPLATE#             5            5                0  0
DISPATCH_CAP_POLICY#                                       SETTINGS#sending      1            1                0  0
OWNER_RESEARCH_SOURCE and GUIDED_RESEARCH_SETUP            SETTINGS#research     1            1                0  0
MAIL_SUPPRESSION# and TERRITORY_RETIRED_ROUTE#             SUPPRESS#            nn           nn                0  0
CAMPAIGN_ENROLLMENT#, TERRITORY_ENROLLMENT# and …          SEQ#                 nn           nn                0  0

Dry run only. Nothing was written.
```

Check the `FIRM#` count against what you expect the pool to be, and check that `refused` is 0 on every row. A
non-zero `refused` names its closed code in brackets; do not run step 3 until you understand it.

## 3. Copy

The same plan, committed.

```
node cloud/lambdas/delegated-worker/out/operator-pairing.cjs $OP --cutover-copy --execute
```

**On success** it prints the same table with the same `would-write` numbers and ends:

```
Cutover copy executed. 0 refused.
```

Every write is an `attribute_not_exists` put, so this is re-runnable: run it again and every row reads
`already-present`, with `would-write` 0. It never deletes and it never overwrites. The Google grant, the event
log, the pairings and the device tokens are not touched.

## 4. Import dry run

```
node cloud/lambdas/delegated-worker/out/operator-pairing.cjs $OP \
  --cutover-import "/Users/<you>/Callie Backups/cutover-export-2026-09-__.json" --dry-run
```

**On success**, a four-row table and `Dry run only. Nothing was written.` The four rows are `CALLBACK#`,
`SUPPRESS#`, `TEMPLATE#` and `SETTINGS#phone`, and their `count` values match the three counts step 1 printed
(plus one for the phone row, which is always one).

If the file is refused you get exit code 2 and one closed reason: `file_not_json`, `file_too_large` or
`file_not_an_export`. The last one means the file does not match the schema exactly — an unknown key refuses the
whole file rather than travelling unnoticed. Do not hand-edit the file; export again.

## 5. Import

```
node cloud/lambdas/delegated-worker/out/operator-pairing.cjs $OP \
  --cutover-import "/Users/<you>/Callie Backups/cutover-export-2026-09-__.json" --execute
```

**On success**: the same table, then `Cutover import executed. 0 refused.`

**Write down anything with a non-zero `refused`.** That is the "record anything the import flagged" step: the
count and its closed code, per row, so you know what did not come across and can decide what to do about it. It
is also visible afterwards in Diagnostics, as `operator` attempts.

Note what the import does to your edited template bodies: each one lands **unapproved**. That is deliberate — an
edited body has never passed the footer check — and you re-approve it in step 10.

## 6. Redeploy the worker with the three switches

Terraform, additive only. Set all three coexistence switches false:

```
delegated_worker_legacy_email_enabled    = false   # S3: no mailbox poll, no sequence email walk on the old tick
delegated_worker_legacy_research_enabled = false   # S4: no research, configurations or territory backfill phases
delegated_worker_legacy_tick_enabled     = false   # S6: the old tick does nothing; the function answers HTTP only
```

```
cd cloud/worker-terraform
terraform plan   # expect Lambda environment changes only: no resource created or destroyed
terraform apply
```

**On success** the plan shows changes to the API function's `environment.variables` and nothing else. No schedule,
no grant, no permission and no table changes. All three variables are documented together in
`cloud/lambdas/delegated-worker/OPERATOR.md`; each one is reversible on its own by setting it back to `true`.

From this apply, the morning list is built by the scheduler's `day` job and the old function serves HTTP only.

## 7. Install the packaged client

Full detail in `docs/cutover/INSTALL-CLIENT.md`; the short form:

```
cd client
npm run verify:package
```

**On success** it prints a JSON report. Three fields matter: `releaseMarker.commitSha` is the commit you are
installing; `notarization.notarized` is `false` with the reason stated (this build is signed, not notarized, so
Gatekeeper asks once); and `fuses` lists the nine fuse states.

Then drag the `.app` from `client/out/` to `/Applications`, and open it once from Finder with Control-click →
Open. Before first launch, create the endpoint file:

```
mkdir -p ~/Library/Application\ Support/Callie/client
printf '{ "endpoint": "https://<worker host>" }\n' > ~/Library/Application\ Support/Callie/client/worker-endpoint.json
```

**On success** the app opens on the Pair page and names the endpoint it read.

## 8. Pair

Mint a device code (it goes to a private file; it is never printed):

```
node cloud/lambdas/delegated-worker/out/operator-pairing.cjs $OP --mint-device-code \
  --label "David MacBook" --expires 600 --output /Users/<you>/.callie-private/device-code --execute
```

**On success**: `Device code saved to private output. No code printed.`

Paste the code — or the absolute path `/Users/<you>/.callie-private/device-code` — into the Pair page and press
Pair.

**On success** the app moves to Today and says whether it deleted the code file. If Today has no list yet, it
says so honestly (`not_built_yet` before 05:00 Eastern); that is not a failure.

## 9. Continue to Google, then revoke the old grant

In the client: **Settings → Google → Continue to Google**.

**On success** your default browser opens on Google's consent screen. Finish the consent there. The app never sees
your password, the authorization code or the token. (If this Mac cannot open a browser, the page shows the
address instead of claiming it opened one — open it yourself.)

Come back to Settings. Within a minute (the page re-reads on its own) the Google section says
**connected**, names the mailbox, and adds: *"Connected through the fresh consent of the cutover. The old
pairing-bound grant is still live: revoke it."*

Press **Revoke the old grant**.

**On success**: *"Revoked the old grant. The fresh consent is unaffected."* The button disappears, and the note
becomes *"…This grant is bound to the workspace, not to a pairing."*

This is the one deliberately irreversible step of the cutover: the old grant is gone and the new one is the
mailbox. Until the consent reads ready, every send holds `mailbox_not_connected` — which is the honest state, not
a failure.

## 10. Record anything the import flagged, and re-approve edited templates

Two small things, in the client:

- **Settings → Sending**: set the postal address if it is not set. No template can be approved without one,
  because the footer block carries it.
- **Settings → Templates**: any template whose body you had edited is now unapproved and says which check it
  fails. Read the body with the footer in front of you and approve it. Approving is never sending.
- Anything step 5 flagged: write it down beside this runsheet, with the row and the closed code.

Then run one real morning: read Today, dial a card, log the outcome, and let one templated email go out under the
standing approval. All four are visible in Diagnostics as attempts.

---

## What to check the next morning

- Today shows a list built at 05:00 Eastern with four lanes.
- Diagnostics shows a `list` attempt for the date and no failed `tick_phase` attempts from the old function.
- The Week view counts yesterday's call and send.

Three consecutive real mornings on the new build is the gate for S7, which opens the deletion PR.

## If something goes wrong

| Symptom | What it means | What to do |
| --- | --- | --- |
| `CUTOVER_EXPORT_FAILED lock` | The old app is open. | Quit it; run step 1 again. |
| `CUTOVER_EXPORT_FAILED write` | An export for today already exists. | Use that file; it is the evidence. |
| Copy row with `refused` > 0 | Named by a closed code in the table. | Do not re-run blindly; read the code, fix the cause, re-run — the copy is re-runnable. |
| `Identity mismatch or table not active` | The credential or the table is not the one named. | Check the role and the table; nothing was written. |
| `file_not_an_export` | The export file does not match the schema exactly. | Do not edit it; export again. |
| Today says `not_built_yet` | Before 05:00 Eastern, or the scheduler has not run. | Wait; check Diagnostics for the `day` job. |
| Sends hold `mailbox_not_connected` | The fresh consent is not ready. | Finish step 9. |
| Sends hold `template_not_approved` | The postal address or the footer check. | Step 10. |
