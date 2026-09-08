import { closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { UpstreamObjectStore } from './upstreamSync';

const PREFIX = 'upstream/enrichment-requests/';
const REQUEST_KEY = /^upstream\/enrichment-requests\/(\d{4}-\d{2}-\d{2})-[0-7][0-9A-HJKMNP-TV-Z]{25}\.ndjson$/;
const MAX_REQUEST_BYTES = 64 * 1024;

function requireDirectory(path: string): void {
  // lstat deliberately rejects an existing directory symlink rather than following it.
  if (!lstatSync(path).isDirectory()) throw new Error('Invalid enrichment fixture directory.');
}

/** TEST-ONLY transport for CALLIE_SOURCING_FIXTURE_DIR. No credentials or network.
 * The real writer still owns validation, eligibility and the request ledger.
 * Small bounded synchronous writes avoid yielding between directory checks and
 * exclusive creation. This is not a general-purpose hostile-filesystem sandbox.
 */
export function createFileSystemEnrichmentRequestStore(rootDirectory: string): UpstreamObjectStore {
  return {
    async putObjectText({ key, body, contentType, signal }) {
      signal.throwIfAborted();
      const match = REQUEST_KEY.exec(key);
      if (match === null || match[0] !== key || contentType !== 'application/x-ndjson'
        || Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) {
        throw new Error('Invalid enrichment fixture request.');
      }
      const date = new Date(`${match[1]}T00:00:00.000Z`);
      if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== match[1]) {
        throw new Error('Invalid enrichment fixture request date.');
      }
      if (!isAbsolute(rootDirectory)) throw new Error('Enrichment fixture root must be absolute.');
      const root = resolve(rootDirectory); // Strip trailing slashes before lstat, including on symlinks.
      requireDirectory(root); // Do not create a missing root or trust a cached realpath.
      let directory = realpathSync(root);
      for (const component of ['upstream', 'enrichment-requests']) {
        signal.throwIfAborted();
        directory = join(directory, component);
        try { mkdirSync(directory, { mode: 0o700 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        requireDirectory(directory);
      }
      signal.throwIfAborted();
      const fd = openSync(join(directory, key.slice(PREFIX.length)),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, body, 'utf8'); }
      finally { closeSync(fd); }
    },
  };
}
