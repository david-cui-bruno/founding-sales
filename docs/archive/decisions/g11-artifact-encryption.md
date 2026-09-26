# G11: the carry artifact is age-encrypted, not KMS-encrypted

The specification says the carry moves through "an encrypted artifact outside git"
(section 2, "Data carry") and does not say what encrypts it. The brief left the
choice to this lane. It is **age**, with a recipient public key, and the artifact is
a file on removable media rather than an S3 object.

Three reasons, in the order they decided it.

**The import must not need a cloud call.** KMS envelope encryption means the import
step calls `Decrypt` before it can read a byte. The import runs against production
PostgreSQL under an operator role at a moment when the old stack has just been
stopped; adding a second AWS dependency to the one step that must not fail halfway
buys nothing. `age` needs a binary and a file.

**No secret belongs in the runbook.** An age *recipient* is a public key. It can be
written into `docs/greenfield/carry-runbook.md`, pasted into a message and checked
against what David holds, and none of that is a disclosure. The private identity
lives on removable media David mounts for the import and unmounts afterwards; the
runbook names the path, never the key. A KMS key id is also public, but the IAM grant
that makes it usable is a standing capability on a role, and the carry is a one-time
operation that should leave no standing capability behind.

**The artifact is short-lived by design.** It exists between the export and the
shred, it is audited when it is deleted (`carry.artifact_deleted`), and the
protection that matters is that it never sat in plaintext and that the key that opens
it is not on the machine that made it. Key *rotation*, *grants* and *audit of
decryption* — the things KMS is better at — are properties of a long-lived object,
and this one is measured in hours.

## What is in the code

`ArtifactCipher` is a port with two methods. `ageCipher` spawns the `age` command
with `--encrypt --recipient <public key>` or `--decrypt --identity <file>`; no key
material passes through the process, no environment variable holds one, and the
command's own stderr is not echoed because it can name a key path.

`aesGcmCipher` is a real AES-256-GCM over a 32-byte key from a file. It is what every
test uses — a fake that returned the plaintext would have proved nothing about the
tamper checks — and it is the rehearsal path on a machine with no `age`. It is not
the production choice, because it would put key handling in this tool's hands.

## What the receipt may hold

Counts, digests and identifiers: the artifact id, the watermark, the four per-kind
counts, the manifest digest, the sealed sha256 and the byte count. Not the per-item
hashes, which are inside the sealed body: a hash of a firm's fields is not the
fields, but eight hundred of them beside the ciphertext are a correlation surface for
no benefit, and parity is checked at import where both sides are already in memory.

## What would change this

A carry that had to be resumed across days, or run by somebody who is not the person
holding the identity, would want KMS and its grant model. Neither is true of a
one-salesperson cutover.
