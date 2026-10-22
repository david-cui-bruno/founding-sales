import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

/** Ephemeral localhost-only certificate. Browser certificate ignoring is scoped to
 * this synthetic harness, never an authentication or cookie policy exception. */
export async function localCertificate(): Promise<{ key: Buffer; cert: Buffer; remove(): Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'fss-browser-tls-'));
  try {
    await promisify(execFile)('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost']);
    return { key: await readFile(join(directory, 'key.pem')), cert: await readFile(join(directory, 'cert.pem')), remove: async () => { await rm(directory, { recursive: true, force: true }); } };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
