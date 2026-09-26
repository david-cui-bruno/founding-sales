# G7: envelope encryption behind an interface, with one AWS adapter no test touches

**Date:** 20 September 2026 · **Lane:** G7 gmail · **Spec:** invariant 6, 10.3, Appendix F

## The requirement

"Refresh tokens are envelope-encrypted." A Gmail refresh token is the most dangerous
value in the system: it is a long-lived, silent key to a person's mail, and it has to
be stored, because the whole point of a mailbox connection is that it survives the
browser session that created it.

## The shape

Three pieces, in `packages/domain/mail`:

* `EnvelopeCipher` — `encrypt(plaintext)` and `decrypt(ciphertext)`. AES-256-GCM with
  a fresh 96-bit IV and a 128-bit authentication tag per record. This is the only
  thing `tokens.ts` knows about.
* `DataKeyWrapper` — `generate()` and `unwrap(wrapped)`. Two methods, because that is
  the whole of the envelope contract: mint a data key and give me back both its
  plaintext and the wrapped form to store, or take the wrapped form and return the
  plaintext.
* `envelopeCipher(wrapper)` — composes them. It zeroes every plaintext data key before
  returning.

There are exactly two wrappers. `localDataKeyWrapper` mints a master key from
`randomBytes` at construction and lives entirely in memory; every test uses it.
`kmsDataKeyWrapper`, in `envelopeKms.ts`, is the production one.

## Decision

`envelopeKms.ts` is the only file in the repository that may import the AWS KMS SDK, it
imports it through a variable specifier, and no test exercises it.

```ts
const specifier = '@aws-sdk/client-kms';
const module = await import(specifier);
```

The variable is not stylistic. A literal specifier is resolved by the bundler and by
every static analyser that walks the import graph, which would put the SDK — and its
transitive credential-provider chain — inside the closure of every process that can
encrypt anything. The variable defers it to the one call that needs it, which is the
same technique `packages/domain/jobs/metricsCloudWatch.ts` already uses and for the
same reason.

`KmsTransport` sits between `kmsDataKeyWrapper` and the SDK, with two methods that
mirror `GenerateDataKey` and `Decrypt`. So the adapter's *logic* — key-id checking,
algorithm checking, the error mapping — is testable against a fake transport, while
`loadKmsTransport` (the twelve lines that actually construct a `KMSClient`) is not
tested at all. That is deliberate: a test that exercised it would be a test that either
reached AWS or mocked the SDK, and the second proves nothing the fake transport does
not already prove.

## What the ciphertext records

`mailbox_tokens` stores `key_id`, `algorithm`, `wrapped_data_key`, `ciphertext`, `iv`
and `auth_tag`, with the IV constrained to twelve bytes and the tag to sixteen. The
key id is stored so a rotation is detectable rather than silently wrong: decrypting
with a wrapper whose key id differs raises `KEY_MISMATCH` instead of producing
plaintext nobody can account for. The algorithm is stored for the same reason, and
`ALGORITHM_UNKNOWN` is what a future migration to a different cipher will hit first.

The table permits DELETE — which almost nothing else in this schema does — because
`disconnectMailbox` must be able to destroy the material. Retention that keeps a
refresh token after the person revoked it is not retention.

## What a reviewer should check

The invariant is one grep: `@aws-sdk/client-kms` appears in `envelopeKms.ts` and
nowhere else, and never as a literal in an `import` statement. If that is true, no
process can acquire AWS credentials by accident, and no test can reach KMS however it
is configured.
