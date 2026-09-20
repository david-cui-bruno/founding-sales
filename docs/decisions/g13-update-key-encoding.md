# G13a: the update-signing key is base64 DER, and there is no PEM path

**Spec silence.** Nothing says how the key that signs update manifests is encoded.

**Decision.** Base64 PKCS#8 DER, on the private side and the public side, and the
publisher accepts nothing else. A value that begins with five hyphens, or that is not
base64, is refused as `update_signing_key_not_der` with the `openssl` line that
converts it.

**Why, and how it was found.** The first version accepted both: base64 DER, or a PEM,
by wrapping bare base64 in PEM armour before handing it to `createPrivateKey`. That
required the file to contain PEM armour — the five-hyphen `BEGIN`/`END` header pair
that wraps a PKCS#8 key — and `npm run verify:secrets` refused it. That was gitleaks'
`private-key` detector, correctly: a repository has no business containing that
header whether or not a key follows it. Measured: two findings in the history scan
(the added line, and the same line again in a merge diff) and one in the working-tree
scan. This note does not reproduce the header either, for the same reason.

`.gitleaks.toml` says "Do not extend defaults again", and `test/verifySecretsConfig.
test.mjs` pins parity with the upstream configuration, so an allowlist entry was never
an option — and would have been the wrong answer anyway. The detector was not wrong;
the code was.

**Why one encoding is better regardless.** A repository secret holding a PEM keeps its
newlines only by luck, so base64 had to be accepted in any case. Accepting both meant
two paths into `createPrivateKey`, only one of which an operator would ever use, and a
string-surgery step between the secret and the key. Now the public key and the private
key are written the same way, by two lines of the same `openssl` invocation, and the
publisher's check that they are halves of one pair is a plain comparison.

**What an operator sees.** `docs/greenfield/install.md` gives both commands. A PEM
pasted into the secret produces the refusal above, by name, before anything is built —
not a signature failure on somebody's Mac.

**Where the armour is now.** In one test, assembled from fragments at runtime, so that
"an armoured key is refused" is a case with a test and no file in the repository holds
the literal.
