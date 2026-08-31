# Encrypted SQLite Driver Decision

**Runtime:** Electron 44.0.0, Node 24, Darwin arm64

**Verdict:** PASS — use `better-sqlite3-multiple-ciphers@12.11.1`

**Cipher profile:** `cipher=sqlcipher`, `legacy=4`, 32-byte raw key

| Candidate | Synchronous | Encrypted | Kysely built-in dialect | Electron 44 arm64 result |
|---|---:|---:|---:|---|
| `better-sqlite3@13.0.3` | Yes | No | Yes | Rejected: no encryption |
| `@journeyapps/sqlcipher@6.0.0` | No | Yes | No | Rejected: async API boundary |
| `better-sqlite3-multiple-ciphers@12.11.1` | Yes | Yes | Yes | Accepted only after probe passes |

## Retained evidence

The probe ran under Electron 44.0.0 on Darwin arm64 and returned:

```json
{"packageVersion":"12.11.1","electronVersion":"44.0.0","platform":"darwin","architecture":"arm64","cipher":"sqlcipher","legacy":"4","synchronousRow":{"value":"encrypted"},"reopenedRow":{"value":"encrypted"},"journalMode":"wal","ftsRow":{"content":"searchable encrypted content"},"integrity":"ok","encryptedHeader":true,"wrongKeyRejected":true}
```

The loaded native addon was inspected after the Electron rebuild:

```text
better-sqlite3-multiple-ciphers.node: Mach-O 64-bit bundle arm64
```

The retained probe requires the exact installed package metadata and Electron
runtime, plus authoritative `cipher` and `legacy` pragma readbacks. It also proves
keyed creation, non-plaintext header, wrong-key rejection, WAL, FTS5, integrity
checking, Kysely queries, reopen persistence, and Electron 44 arm64 native loading.
Re-run the probe before any driver or Electron major upgrade.
