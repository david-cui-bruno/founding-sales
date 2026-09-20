# G2: one command id per workspace

**The brief says** lane G2 does not own G0's foundation tables and may "add columns
only by additive migration and only if a decision note explains why". This is that
note, for something smaller than a column: one unique constraint.

**What the specification says.** Section 5.3: "Same ID and payload returns the
original result; **a different payload or device is rejected**."

**What migration 0001 gives.** `command_receipts` has the primary key
`(workspace_id, device_id, command_id)`. Under that key, a second device presenting a
command id the first device already used does not collide — it starts a second
receipt. The command id is reused successfully, which is the thing the sentence above
says is rejected.

**Decision.** Migration 0003 adds

```sql
ALTER TABLE command_receipts
  ADD CONSTRAINT command_receipts_command_id_unique UNIQUE (workspace_id, command_id);
```

and `runCommand` looks receipts up by `(workspace_id, command_id)`, comparing the
device and the payload hash to decide between `command_device_mismatch`,
`command_payload_mismatch` and a genuine replay.

**Why a constraint rather than a check in the middleware.** Two devices racing one
command id is either an attack or a bug, and in both cases the outcome should not
depend on which read happened first. With the constraint, the loser's `INSERT` raises
`23505`, the transaction rolls back, and the middleware re-reads and answers from the
receipt that committed — so at most one mutation ever happened. That branch is
exercised in `commands.ts` and is the reason the unique-violation handler exists.

**Why it is additive and safe.** No release has shipped, so there is no data to
violate it, and no deployed binary writes two rows that would. Under expand, migrate,
contract this is the expand step and nothing else is needed: the primary key from
0001 stays, redundant but harmless, and a later release may contract it if anyone
minds.

**One consequence worth knowing.** The existing `command_receipts_pkey` failing-insert
case in `constraints.test.ts` inserts the same `(workspace, device, command_id)` twice.
Both unique indexes are now violated by that row; PostgreSQL checks them in index
order and the primary key's index is older, so it is the one named in the error and
the existing case still passes unchanged. That is an ordering fact rather than a
guarantee, so the new constraint has its own case that uses two different devices,
where only it can fire.
