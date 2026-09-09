import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PHONE_SETUP_ERROR, confirmPhoneSetupSchema, phoneSetupSchema, type PhoneSetup, type PhoneSetupApi, type PhoneSetupStatus } from '../../shared/contracts/phoneSetupContract';

const failure = () => new Error(PHONE_SETUP_ERROR);
const empty = (state: 'unconfigured' | 'unavailable'): PhoneSetupStatus => ({ state, candidateFingerprint: null, confirmedAt: null });

/** Main-process-only, bounded proof. No credentials, targets or account identifiers. */
export class PhoneRouteSettings {
  constructor(private readonly path: string) {
    if (!isAbsolute(path)) throw failure();
  }
  read(): PhoneSetup | null {
    let fd: number | undefined;
    try {
      if (lstatSync(dirname(this.path)).isSymbolicLink()) return null;
      fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0
        || (process.getuid && stat.uid !== process.getuid())) return null;
      const buffer = Buffer.alloc(4097);
      const count = readSync(fd, buffer, 0, buffer.length, 0);
      if (count > 4096) return null;
      const raw = buffer.subarray(0, count).toString('utf8');
      if ([...raw.matchAll(/"(?:\\.|[^"\\])*"\s*:/g)].length !== 3) return null;
      return phoneSetupSchema.parse(JSON.parse(raw));
    } catch { return null; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  confirm(input: PhoneSetup): void {
    const record = phoneSetupSchema.parse(input);
    let temporary: string | undefined;
    let fd: number | undefined;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const parent = lstatSync(dirname(this.path));
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw failure();
      try {
        const existing = lstatSync(this.path);
        if (!existing.isFile() || existing.isSymbolicLink()) throw failure();
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      temporary = `${this.path}.${randomUUID()}.tmp`;
      fd = openSync(temporary, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify(record), 'utf8');
      fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temporary, this.path); temporary = undefined;
      fd = openSync(dirname(this.path), constants.O_RDONLY | constants.O_NOFOLLOW);
      fsyncSync(fd);
    } catch { throw failure(); }
    finally {
      if (fd !== undefined) closeSync(fd);
      if (temporary !== undefined) { try { unlinkSync(temporary); } catch { /* Failed private temp cleanup cannot authorize a route. */ } }
    }
  }
  clear(): void {
    let fd: number | undefined;
    try {
      const parent = lstatSync(dirname(this.path));
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw failure();
      unlinkSync(this.path);
      fd = openSync(dirname(this.path), constants.O_RDONLY | constants.O_NOFOLLOW);
      fsyncSync(fd);
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw failure(); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
}

export type PhoneSetupService = PhoneSetupApi & {
  invalidate(locked?: boolean): void;
  dispose(): void;
};
export function createPhoneSetupService(input: {
  settings: PhoneRouteSettings;
  inspectCandidate(): Promise<string | null>;
  now(): string;
  onChange(): void;
}): PhoneSetupService {
  let epoch = 0;
  let locked = false;
  let closed = false;
  const current = (version: number) => !closed && !locked && epoch === version;
  const invalidate = (suspended?: boolean) => {
    ++epoch;
    if (suspended !== undefined) locked = suspended;
  };
  return {
    async status() {
      const version = epoch;
      if (!current(version)) return empty('unavailable');
      let fingerprint: string | null;
      try { fingerprint = await input.inspectCandidate(); } catch { return empty('unavailable'); }
      if (!current(version) || fingerprint === null) return empty('unavailable');
      const proof = input.settings.read();
      return proof?.fingerprint === fingerprint
        ? { state: 'configured', candidateFingerprint: fingerprint, confirmedAt: proof.confirmedAt }
        : { state: 'needs_confirmation', candidateFingerprint: fingerprint, confirmedAt: null };
    },
    async confirm(request) {
      try {
        const { expectedFingerprint } = confirmPhoneSetupSchema.parse(request);
        if (closed || locked) throw failure();
        invalidate(); input.onChange();
        const version = epoch;
        const fingerprint = await input.inspectCandidate();
        if (!current(version) || fingerprint === null || fingerprint !== expectedFingerprint) throw failure();
        const confirmedAt = input.now();
        if (!current(version)) throw failure();
        input.settings.confirm({ version: 1, fingerprint, confirmedAt });
        return { state: 'configured', candidateFingerprint: fingerprint, confirmedAt };
      } catch { throw failure(); }
    },
    async clear() {
      if (closed || locked) throw failure();
      invalidate(); input.onChange(); input.settings.clear();
      return empty('unconfigured');
    },
    invalidate,
    dispose() { closed = true; invalidate(); },
  };
}
