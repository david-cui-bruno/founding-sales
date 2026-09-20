import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CARRY_ARTIFACT_SCHEMA,
  ageDecryptArguments,
  ageEncryptArguments,
  aesGcmCipher,
  ageCipher,
  openArtifact,
  sealArtifact,
} from '../../tools/carry/artifact.ts';
import { buildManifest, compareParity, recordContentHash } from '../../tools/carry/manifest.ts';
import { readOldRecord } from '../../tools/carry/oldShapes.ts';
import { FIXTURE_WATERMARK, goodOldTable } from '../fixtures/carry/oldTable.ts';

/**
 * The artifact, its manifest and the cipher seam (lane G11).
 *
 * The cipher is a port for one reason: the production choice is the `age` command,
 * which is a binary this machine may not have and which the gate must never need.
 * `aesGcmCipher` is a real AES-256-GCM over a random key, so the round trip below is
 * over real ciphertext with a real authentication tag — a fake that returned the
 * plaintext would have proved nothing about tampering.
 *
 * See `docs/decisions/g11-artifact-encryption.md`.
 */

const records = goodOldTable().flatMap(item => {
  const read = readOldRecord(item);
  return read.ok ? [read.value] : [];
});

const manifest = buildManifest({
  artifactId: 'carry-artifact-test',
  watermarkAt: FIXTURE_WATERMARK,
  createdAt: '2026-09-21T14:00:00.000Z',
  records,
});

describe('the sealed artifact', () => {
  it('round-trips through a real cipher', async () => {
    const cipher = aesGcmCipher(randomBytes(32));
    const sealed = await sealArtifact({ manifest, records, cipher });
    const opened = await openArtifact({ sealed: sealed.sealed, receipt: sealed.receipt, cipher });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.manifest).toEqual(manifest);
    expect(opened.value.records).toEqual(records);
    expect(sealed.receipt.schema).toBe(CARRY_ARTIFACT_SCHEMA);
  });

  it('reports counts and digests in the receipt and no business data at all', async () => {
    const cipher = aesGcmCipher(randomBytes(32));
    const sealed = await sealArtifact({ manifest, records, cipher });
    expect(sealed.receipt.counts).toEqual({ firm: 4, evidence: 3, suppression: 4, template: 2 });
    expect(sealed.receipt.sealedSha256).toHaveLength(64);
    expect(sealed.receipt.sealedBytes).toBe(sealed.sealed.byteLength);
    const text = JSON.stringify(sealed.receipt);
    expect(text).not.toContain('Alpha');
    expect(text).not.toContain('5550');
    expect(text).not.toContain('example.test');
  });

  it('refuses a sealed file whose bytes do not match the receipt', async () => {
    const cipher = aesGcmCipher(randomBytes(32));
    const sealed = await sealArtifact({ manifest, records, cipher });
    const tampered = Buffer.from(sealed.sealed);
    tampered[tampered.length - 1] ^= 0xff;
    const opened = await openArtifact({ sealed: tampered, receipt: sealed.receipt, cipher });
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.reason).toBe('artifact_digest_mismatch');
  });

  it('refuses a sealed file the key cannot open', async () => {
    const sealed = await sealArtifact({ manifest, records, cipher: aesGcmCipher(randomBytes(32)) });
    const opened = await openArtifact({
      sealed: sealed.sealed,
      receipt: sealed.receipt,
      cipher: aesGcmCipher(randomBytes(32)),
    });
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.reason).toBe('artifact_unreadable');
  });

  it('refuses a manifest that does not hash to the digest in the receipt', async () => {
    const cipher = aesGcmCipher(randomBytes(32));
    const sealed = await sealArtifact({ manifest, records, cipher });
    const opened = await openArtifact({
      sealed: sealed.sealed,
      receipt: { ...sealed.receipt, manifestDigest: 'f'.repeat(64) },
      cipher,
    });
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.reason).toBe('manifest_digest_mismatch');
  });
});

describe('the manifest', () => {
  it('hashes an item from what it carries, not from when it was exported', () => {
    const first = recordContentHash(records[0]!);
    const second = recordContentHash(JSON.parse(JSON.stringify(records[0])) as typeof records[0]);
    expect(first).toBe(second);
    expect(first).toHaveLength(64);
  });

  it('gives a different hash to a different value', () => {
    const [firm] = records.filter(record => record.kind === 'firm');
    expect(firm).toBeDefined();
    const changed = { ...firm!, firm: { ...(firm as { firm: { name: string } }).firm, name: 'Another Name' } };
    expect(recordContentHash(changed as typeof records[0])).not.toBe(recordContentHash(firm!));
  });

  it('matches parity when the same records land', () => {
    const report = compareParity(manifest, records.map(record => ({ kind: record.kind, oldId: record.oldId, contentHash: recordContentHash(record) })));
    expect(report.matched).toBe(true);
    expect(report.perKind.suppression).toEqual({ expected: 4, observed: 4, missing: 0, unexpected: 0, hashMismatches: 0 });
  });

  it('fails parity when one item is missing', () => {
    const observed = records
      .filter(record => record.kind !== 'suppression' || record.oldId !== records.find(entry => entry.kind === 'suppression')?.oldId)
      .map(record => ({ kind: record.kind, oldId: record.oldId, contentHash: recordContentHash(record) }));
    const report = compareParity(manifest, observed);
    expect(report.matched).toBe(false);
    expect(report.perKind.suppression.missing).toBe(1);
  });

  it('fails parity when an item arrives with different content', () => {
    const observed = records.map(record => ({
      kind: record.kind,
      oldId: record.oldId,
      contentHash: record.kind === 'firm' ? 'f'.repeat(64) : recordContentHash(record),
    }));
    const report = compareParity(manifest, observed);
    expect(report.matched).toBe(false);
    expect(report.perKind.firm.hashMismatches).toBe(4);
  });
});

describe('the age cipher', () => {
  it('encrypts to a recipient and never to a passphrase', () => {
    expect(ageEncryptArguments('age1exampleexamplerecipientkeynotreal')).toEqual([
      '--encrypt',
      '--recipient',
      'age1exampleexamplerecipientkeynotreal',
    ]);
  });

  it('decrypts with an identity file the operator holds, never an inline key', () => {
    expect(ageDecryptArguments('/Volumes/carry/identity.txt')).toEqual([
      '--decrypt',
      '--identity',
      '/Volumes/carry/identity.txt',
    ]);
  });

  it('runs the command it says it runs, and reports what came back', async () => {
    const calls: { command: string; args: readonly string[]; input: Buffer }[] = [];
    const cipher = ageCipher({
      command: 'age',
      recipient: 'age1exampleexamplerecipientkeynotreal',
      identityFile: '/Volumes/carry/identity.txt',
      run: async (command, args, input) => {
        calls.push({ command, args, input });
        return Buffer.concat([Buffer.from('sealed:'), input]);
      },
    });
    const sealed = await cipher.seal(Buffer.from('plain'));
    expect(sealed.toString()).toBe('sealed:plain');
    expect(calls[0]?.command).toBe('age');
    expect(calls[0]?.args).toEqual(['--encrypt', '--recipient', 'age1exampleexamplerecipientkeynotreal']);
    expect(cipher.description).toBe('age');
  });
});
