# G3b: the import commit takes the file, not the preview

**Date:** 20 September 2026 · **Lane:** G3b CRM surface · **Spec:** 7.2, 5.3,
Appendix G 38

Section 7.2 says admin CSV import "validates into a preview and commits through
ordinary business commands", and Appendix G 38 asks for "a preview and atomic per-row
commands without leakage". It does not say what travels between the two phases, and
the obvious answer is wrong.

## What was rejected

**Sending the preview back.** The client holds the preview it was given, ticks the
rows it wants and posts them. Every field in every row it posts is then a value the
client chose: the firm name, the owner, the canonical phone number. A client that
edited one would be committing a row the server never validated, and the validation
would look like it had happened, because the row carries the server's own `outcome:
'create'` on it.

**Storing the preview server-side under a token.** This works, and it costs a table,
an expiry, a cleanup job and a decision about what happens when the file is re-uploaded
while a preview is open. All of that to avoid re-running a pure function over half a
megabyte.

## What was built

The commit carries **the file again** and a list of `{ rowNumber, commandId }`. The
server re-previews the same bytes under the caller's own scope — the preview is a pure
function of the file and the workspace — and commits the rows it named.

`commitImportRow` still re-checks what it is given rather than trusting `outcome`,
because the domain function is callable from somewhere other than this route, and the
API-level re-derivation is what makes the re-check cheap to satisfy rather than the
only thing standing between a client and an unvalidated write.

## One row, one command

Each row runs inside its own `runCommand`. That is what makes Appendix G 38's two
hardest words true at the same time:

* **atomic per row** — the receipt, the firm, the contact and both routes commit in
  one transaction, so the half-imported row that nobody can find and nobody can clean
  up cannot exist;
* **partial failures** — a row that refuses takes only its own work back, and the rows
  either side of it are already committed.

The payload the receipt is hashed over is the *row as the server re-derived it*, which
gives a third property nobody asked for and everybody wants: retrying the whole file
with the same command ids replays the rows that landed and attempts the ones that did
not, and editing a line and retrying it under its old id is `command_payload_mismatch`
rather than a silent second import of a different firm.

The rows are committed sequentially rather than in a `Promise.all`. `auth.db` is one
connection and two overlapping transactions on one backend is not a thing PostgreSQL
offers; a pool would let them overlap and would also let two rows of one file land in
different transactions than their receipts.

## Why a whole row is invalid when one route is

A row with a malformed phone number could import the firm and the contact and drop the
number. It refuses instead.

The argument for dropping it is that the firm is still worth having. The argument
against is what the CRM looks like afterwards: a firm with no phone route, no record
that a number was ever offered, and an administrator who believes the import worked.
The next person to look at that firm concludes the prospect has no number. Refusing
the row puts the fault in front of the only person who can fix it, in the preview,
before anything is written.

## Leakage

Every lookup the preview makes — the owner, the existing names, the existing external
ids — goes through `RepositoryContext` and is scoped. There is no code path that could
report an external id belonging to another workspace, because there is no query that
could see it. A colliding id is `create` here in exactly the words an id that exists
nowhere gets, and a test asserts that the serialized preview contains neither the other
workspace's id nor its firm's.
