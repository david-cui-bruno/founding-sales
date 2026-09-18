# Rotating the pairing credential in place

David's Mac holds one device pairing for the pilot workspace. Its credential was issued with only
`commands:write` and `events:read`, so the worker refuses every `/google/*` route (`google:grant`) and
`/pairing/revoke` (`pairing:revoke`) for it: the mailbox cannot be connected and the sending limit, which
reads the grant, cannot be written. The pairing id itself is bound into many worker records
(`OWNER_RESEARCH_SOURCE`, `GUIDED_RESEARCH_SETUP`, `TERRITORY_CALL_POLICY#…`, every `OWNER_SOURCE#account-…`
and `OWNER_COMMAND_CLAIM#…` row, `GOOGLE_GRANT#<pairingId>`, the policy configuration identity check) and on
the desktop into `delegated_transport_state`, `delegated_local_configuration` and every table keyed by
`(workspace_id, pairing_id)`. A new pairing id would orphan all of it.

So the fix is a **credential rotation on the existing pairing**: same pairing id, generation `g → g+1`, new
device and emergency credentials, the scope set the pairing lacked. The old credentials die with generation
`g`. Nothing in this repository runs the rotation; the two steps below are explicit actions David takes.

Code: `cloud/lambdas/delegated-worker/src/workerAuth.ts` (`issueRotation`, the rotation branch of
`redeemPairing`), `operatorPairing.ts` (`--rotate`), `src/main/delegation/pairingStore.ts` (`describe`,
`rotate`), the `delegation-pairing` and `delegation-rotate-pairing` channels in
`src/main/ipc/registerOutreachIpc.ts`, `src/renderer/foundation/WorkerSetupSection.tsx` (the control), and
the shapes in `src/shared/contracts/ownerCommandContract.ts`.

## What changes and what does not

| | Before | After |
| --- | --- | --- |
| Pairing id | `e66a…` | unchanged |
| `PAIRING#<id>` generation | `g` | `g + 1`, `revoked: false` |
| Device credential (`TOKEN#`) | generation `g`, `commands:write, events:read` | new secret, generation `g + 1`, the scopes the rotation code names |
| Emergency credential (`TOKEN#`) | generation `g`, `emergency:stop` | new secret, generation `g + 1`, `emergency:stop` |
| Every worker record bound to the pairing id | | untouched |
| Desktop `pairing.json` (encrypted) | generation `g`, old credentials | generation `g + 1`, new credentials and scopes; endpoint and workspace unchanged |
| Every desktop row keyed by `(workspace_id, pairing_id)` | | untouched |

The previous device and emergency credentials fail the worker's generation check the moment the rotation
transaction commits. A request in flight with the old credential gets `worker_unauthorized`; the desktop
retries on its next sync once it has restarted with the new credential. The fenced store needs no change:
it re-reads the credential per request.

## Step 1: the operator mints a rotation code (names only)

Build the operator tool from the worker package with the repository Node 24, then dry-run before executing.
The dry run performs no IO and verifies nothing; `--execute` reserves the private output file first, checks
the STS identity and the table under the explicit environment credential (one attempt), reads the pairing,
and only then writes one `BOOTSTRAP#` record of kind `rotation`. The code is written only to the private
output file; nothing is printed.

```sh
cd cloud/lambdas/delegated-worker && node build-operator.mjs
node out/operator-pairing.cjs \
  --rotate <PAIRING_ID> \
  --account <AWS_ACCOUNT_ID> --region <AWS_REGION> --table <WORKER_TABLE> --workspace <WORKSPACE_ID> \
  --expires 300 \
  --scopes commands:write,events:read,google:grant,pairing:revoke \
  --output <PRIVATE_0700_DIRECTORY>/rotation-code
# review the dry-run line, then repeat the same command with --execute
```

`<PAIRING_ID>` is the lower-case UUID Settings → Worker connection shows under "Pairing id". The output
directory must already exist, be owned by the operator with mode 0700, and the file must not exist yet.
The credential comes only from `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and, for temporary credentials,
`AWS_SESSION_TOKEN` in the environment; profiles, shared files and SSO are ignored (`OPERATOR.md`).

The tool refuses, before any IO, a pairing id that is not a lower-case UUID and a `--scopes` set that drops
`commands:write` or `events:read`. After the identity checks it refuses an unknown or revoked pairing with
`Pairing unknown or revoked. No rotation issued. Reserved output retained.` and writes nothing. Until the
code is redeemed the current credential keeps working; the code expires after `--expires` seconds
(30 to 600). Do not mint two rotation codes for one pairing at once: each redeems into the next generation
and the second redemption would make the first Mac's fresh credential stale.

## Step 2: the two clicks on the Mac

Settings → **Worker connection**. The section now prints the stored pairing credential: pairing id,
credential generation and credential scopes. Below the Pair worker fields is **Rotate pairing credential**
with the endpoint and workspace prefilled and locked (they come from the stored pairing, never from the
screen), a **Rotation code** field and one confirmation sentence:

> This replaces the credential this Mac uses for pairing e66a… and keeps every record. The previous
> credential stops working.

1. Paste the code from the private output file into **Rotation code** and tick the confirmation sentence.
2. Click **Rotate pairing credential**.

The result line reads `Pairing credential rotated: pairing <PAIRING_ID> is now at generation 1 with scopes
commands:write, events:read, google:grant, pairing:revoke. The previous credential no longer works. Restart
the application normally so the running connection uses the new credential, then refresh worker status.`
The facts above it are re-read from disk and show the new generation and scopes.

Then restart the application normally. The running connection is startup-bound and still holds the old
credential until the restart, so a sync before the restart is refused with `worker_unauthorized`; that is
expected. After the restart, **Refresh worker status**, then go to **Remote Google connections** and
**Refresh**: the `worker_scope_denied` hold (whose text now names this control as the remedy) lifts and the
mailbox can be connected.

What the desktop refuses: a rotation when no pairing is stored; a request naming a pairing id or generation
other than the stored one (a stale screen); a worker reply for a different pairing id, a different
workspace, a generation other than exactly `g + 1`, or a scope set without both desktop scopes. In every
refused case `pairing.json` is left byte for byte as it was. The replacement is an atomic rename over the
file that still holds exactly the pairing id and generation the rotation was read against; **Pair worker**
keeps its write-once hard link and still refuses while a pairing is stored, so it can never rotate silently.

## The emergency credential caveat

The rotation replaces the stored **emergency** credential too. Any copy of the previous emergency
credential kept outside this Mac (printed instructions, a password manager entry, an operator runbook for
`/emergency`) stops working the moment the rotation commits. The new emergency credential exists only
inside the encrypted `pairing.json` on this Mac; nothing in this repository prints or exports it. If David
keeps printed emergency instructions, they must be refreshed after the rotation, and refreshing them is a
separate explicit step that this change does not provide a tool for.

## Tests

- Worker, real handler over the in-memory conditional harness (`test/workerAuth.test.ts`): a rotation
  redeems once with the same pairing id at the next generation and the new scopes; the old device and
  emergency credentials are refused the moment it commits; the consumed code is refused on replay; a
  rotation for a revoked or unknown pairing is refused at issue and at redeem; a scope set that drops a
  desktop scope or adds `emergency:stop` is refused; a plain bootstrap still creates a fresh pairing at
  generation 0; exactly one of two competing redemptions commits.
- Operator tool (`test/operatorPairing.test.ts`, `test/operatorPairingCli.test.ts`): `--rotate` parsing with
  each refusal, dry run without IO, execute writes one rotation bootstrap and saves only the code privately,
  unknown and revoked pairing refused after the identity checks, a failed write reported as uncertain, help
  text names the flag.
- Desktop (`tests/main/delegationPairingStore.test.ts`): rotation accepted only under the identity rule,
  refused for a different pairing id, a non-consecutive generation, another workspace or a narrowed scope
  set with the file unchanged byte for byte, refused before contacting the worker for a stale request, rows
  keyed by the pairing id still readable after rotation on a real migrated encrypted database.
- Renderer (`WorkerSetupSection.test.tsx`, `RemoteGoogleConnectionsSection.test.tsx`,
  `tests/integration/pairingRotationWorkflow.test.tsx`): the control through the real preload and IPC
  registrar with a fake worker, the confirmation sentence, the result line, the uncertain outcomes, the
  scope-denied hold naming the remedy.

No test contacts a live worker, DynamoDB or AWS, and no code, credential or pairing id of the live
deployment appears anywhere in code, tests or fixtures.
