import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CommandResult, CommandRunner, EntryKind, UpdateFiles } from '../../src/main/updateInstall.ts';
import type { UpdateManifest } from '../../src/main/updateChannel.ts';

/**
 * A filesystem, a `codesign`/`plutil`/`ditto` and a zip, all made of data (lane g83).
 *
 * The install is three renames and a handful of reads; what matters is their order, what
 * is where after each, and what happens when one fails. So the fake filesystem is a map
 * of paths with a log of every operation, a rename moves a whole subtree the way
 * rename(2) does, and any operation can be made to fail with the error a Mac would give.
 *
 * A bundle is a directory whose `Contents/Info.plist` holds its version and identifier as
 * JSON and whose `Contents/_CodeSignature/CodeResources` holds its Team ID and whether
 * its signature is intact. The fake tools read those files, so a bundle's identity moves
 * with it through every rename, exactly as a real signature does. A "zip" is JSON naming
 * the bundle inside it; the fake `ditto` writes that bundle out.
 */

export interface FakeBundle {
  readonly version: string;
  readonly identifier?: string;
  /** Null for an ad-hoc signature (`TeamIdentifier=not set`). */
  readonly team: string | null;
  /** False: the seal is broken, and `codesign --verify` fails whatever the requirement. */
  readonly intact?: boolean;
}

export const TEAM = 'R45248279P';
export const OTHER_TEAM = 'ZZZZZZZZZZ';
export const BUNDLE_ID = 'com.callie.fss.desktop';

type Entry = { readonly kind: 'directory' } | { readonly kind: 'file'; readonly bytes: Uint8Array };

export type Operation =
  | 'kind'
  | 'list'
  | 'makeDirectory'
  | 'readText'
  | 'writeText'
  | 'readBytes'
  | 'writeBytes'
  | 'rename'
  | 'remove';

/** A rule that makes one operation fail, once or every time. */
export interface FailureRule {
  readonly operation: Operation;
  readonly matches: (path: string, to?: string) => boolean;
  readonly code: string;
  readonly times?: number;
}

export interface FakeFiles {
  readonly files: UpdateFiles;
  /** Every mutating operation, in order: `rename <from> -> <to>`, `remove <path>`, `write <path>`. */
  readonly log: string[];
  fail(rule: FailureRule): void;
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  readJson(path: string): unknown;
  writeJson(path: string, value: unknown): void;
  writeFile(path: string, text: string): void;
  makeDirectory(path: string): void;
  placeBundle(path: string, bundle: FakeBundle): void;
  /** The bundle at `path`, as its Info.plist and signature say, or null. */
  bundleAt(path: string): FakeBundle | null;
  children(path: string): string[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function fsError(code: string, path: string): Error {
  return Object.assign(new Error(`${code}: ${path}`), { code });
}

export function createFakeFiles(): FakeFiles {
  const tree = new Map<string, Entry>([['/', { kind: 'directory' }]]);
  const log: string[] = [];
  const rules: { rule: FailureRule; left: number }[] = [];

  const within = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`);
  const check = (operation: Operation, path: string, to?: string): void => {
    for (const entry of rules) {
      if (entry.rule.operation !== operation || entry.left === 0) continue;
      if (!entry.rule.matches(path, to)) continue;
      entry.left -= 1;
      throw fsError(entry.rule.code, path);
    }
  };
  const ensureDirectory = (path: string): void => {
    if (tree.get(path)?.kind === 'directory') return;
    if (tree.has(path)) throw fsError('ENOTDIR', path);
    ensureDirectory(dirname(path));
    tree.set(path, { kind: 'directory' });
  };
  const requireParent = (path: string): void => {
    if (tree.get(dirname(path))?.kind !== 'directory') throw fsError('ENOENT', dirname(path));
  };
  const put = (path: string, bytes: Uint8Array): void => {
    requireParent(path);
    if (tree.get(path)?.kind === 'directory') throw fsError('EISDIR', path);
    tree.set(path, { kind: 'file', bytes });
  };
  const childrenOf = (path: string): string[] => {
    const prefix = path === '/' ? '/' : `${path}/`;
    const names = new Set<string>();
    for (const key of tree.keys()) {
      if (key === path || !key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (!rest.includes('/')) names.add(rest);
    }
    return [...names].sort();
  };
  const readFileText = (path: string): string | null => {
    const entry = tree.get(path);
    return entry?.kind === 'file' ? decoder.decode(entry.bytes) : null;
  };

  const files: UpdateFiles = {
    kind: async path => {
      check('kind', path);
      const entry = tree.get(path);
      return await Promise.resolve(entry === undefined ? null : (entry.kind as EntryKind));
    },
    list: async path => {
      check('list', path);
      return await Promise.resolve(tree.get(path)?.kind === 'directory' ? childrenOf(path) : []);
    },
    makeDirectory: async path => {
      check('makeDirectory', path);
      ensureDirectory(path);
      await Promise.resolve();
    },
    readText: async path => {
      check('readText', path);
      return await Promise.resolve(readFileText(path));
    },
    writeText: async (path, text) => {
      check('writeText', path);
      put(path, encoder.encode(text));
      log.push(`write ${path}`);
      await Promise.resolve();
    },
    readBytes: async path => {
      check('readBytes', path);
      const entry = tree.get(path);
      return await Promise.resolve(entry?.kind === 'file' ? entry.bytes : null);
    },
    writeBytes: async (path, bytes) => {
      check('writeBytes', path);
      put(path, bytes);
      log.push(`write ${path}`);
      await Promise.resolve();
    },
    rename: async (from, to) => {
      check('rename', from, to);
      if (!tree.has(from)) throw fsError('ENOENT', from);
      requireParent(to);
      if (tree.has(to)) {
        // rename(2) replaces a file, and refuses a directory that is not empty.
        if (tree.get(to)?.kind === 'directory' && childrenOf(to).length > 0) throw fsError('ENOTEMPTY', to);
      }
      const moved = [...tree.entries()].filter(([key]) => within(key, from));
      for (const [key] of moved) tree.delete(key);
      for (const key of [...tree.keys()]) if (within(key, to)) tree.delete(key);
      for (const [key, entry] of moved) tree.set(`${to}${key.slice(from.length)}`, entry);
      log.push(`rename ${from} -> ${to}`);
      await Promise.resolve();
    },
    remove: async path => {
      check('remove', path);
      let removed = false;
      for (const key of [...tree.keys()]) {
        if (within(key, path)) {
          tree.delete(key);
          removed = true;
        }
      }
      if (removed) log.push(`remove ${path}`);
      await Promise.resolve();
    },
  };

  const placeBundle = (path: string, bundle: FakeBundle): void => {
    ensureDirectory(join(path, 'Contents', 'MacOS'));
    ensureDirectory(join(path, 'Contents', '_CodeSignature'));
    put(join(path, 'Contents', 'MacOS', 'Callie'), encoder.encode(`Callie ${bundle.version}`));
    put(
      join(path, 'Contents', 'Info.plist'),
      encoder.encode(
        JSON.stringify({ CFBundleShortVersionString: bundle.version, CFBundleIdentifier: bundle.identifier ?? BUNDLE_ID }),
      ),
    );
    put(
      join(path, 'Contents', '_CodeSignature', 'CodeResources'),
      encoder.encode(JSON.stringify({ team: bundle.team, intact: bundle.intact ?? true })),
    );
  };

  return {
    files,
    log,
    fail: rule => {
      rules.push({ rule, left: rule.times ?? Number.POSITIVE_INFINITY });
    },
    exists: path => tree.has(path),
    isDirectory: path => tree.get(path)?.kind === 'directory',
    readJson: path => {
      const text = readFileText(path);
      return text === null ? null : (JSON.parse(text) as unknown);
    },
    writeJson: (path, value) => {
      ensureDirectory(dirname(path));
      put(path, encoder.encode(JSON.stringify(value)));
    },
    writeFile: (path, text) => {
      ensureDirectory(dirname(path));
      put(path, encoder.encode(text));
    },
    makeDirectory: ensureDirectory,
    placeBundle,
    bundleAt: path => {
      const info = readFileText(join(path, 'Contents', 'Info.plist'));
      const seal = readFileText(join(path, 'Contents', '_CodeSignature', 'CodeResources'));
      if (info === null || seal === null) return null;
      const plist = JSON.parse(info) as { CFBundleShortVersionString: string; CFBundleIdentifier: string };
      const signature = JSON.parse(seal) as { team: string | null; intact: boolean };
      return {
        version: plist.CFBundleShortVersionString,
        identifier: plist.CFBundleIdentifier,
        team: signature.team,
        intact: signature.intact,
      };
    },
    children: childrenOf,
  };
}

/** The bytes of a "zip" holding `bundle` as `Callie.app`. */
export function fakeZip(bundle: FakeBundle): Uint8Array {
  return encoder.encode(JSON.stringify({ fakeZip: 1, bundle }));
}

/** What the fake tools read bundles from and write them to: the fake filesystem, or a real directory. */
export interface BundleStore {
  readonly files: Pick<UpdateFiles, 'readBytes'>;
  placeBundle(path: string, bundle: FakeBundle): void;
  bundleAt(path: string): FakeBundle | null;
}

/** The same bundle layout on the real filesystem, for the test of the real `node:fs` port. */
export function realBundleStore(): BundleStore {
  const read = (path: string): string | null => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  };
  return {
    files: {
      readBytes: async path => {
        try {
          return await Promise.resolve(new Uint8Array(readFileSync(path)));
        } catch {
          return null;
        }
      },
    },
    placeBundle: (path, bundle) => {
      mkdirSync(join(path, 'Contents', 'MacOS'), { recursive: true });
      mkdirSync(join(path, 'Contents', '_CodeSignature'), { recursive: true });
      writeFileSync(join(path, 'Contents', 'MacOS', 'Callie'), `Callie ${bundle.version}`);
      writeFileSync(
        join(path, 'Contents', 'Info.plist'),
        JSON.stringify({ CFBundleShortVersionString: bundle.version, CFBundleIdentifier: bundle.identifier ?? BUNDLE_ID }),
      );
      writeFileSync(
        join(path, 'Contents', '_CodeSignature', 'CodeResources'),
        JSON.stringify({ team: bundle.team, intact: bundle.intact ?? true }),
      );
    },
    bundleAt: path => {
      const info = read(join(path, 'Contents', 'Info.plist'));
      const seal = read(join(path, 'Contents', '_CodeSignature', 'CodeResources'));
      if (info === null || seal === null) return null;
      const plist = JSON.parse(info) as { CFBundleShortVersionString: string; CFBundleIdentifier: string };
      const signature = JSON.parse(seal) as { team: string | null; intact: boolean };
      return { version: plist.CFBundleShortVersionString, identifier: plist.CFBundleIdentifier, ...signature };
    },
  };
}

export interface FakeTools {
  readonly run: CommandRunner;
  /** Every command, as `tool arg arg …`. */
  readonly calls: string[];
  /** The next `ditto` fails with this status. */
  failExtract(): void;
}

/**
 * `codesign`, `plutil` and `ditto`, answering from the fake filesystem the way the real
 * ones answer from a real one: `codesign -dv` prints `TeamIdentifier=` on standard error,
 * `--verify -R` passes only for an intact seal whose team the requirement names, and
 * `plutil -extract … raw` prints one value.
 */
export function createFakeTools(fake: BundleStore): FakeTools {
  const calls: string[] = [];
  let extractFails = false;
  const done = (status: number, stdout = '', stderr = ''): CommandResult => ({ status, stdout, stderr });

  const run: CommandRunner = async (command, args) => {
    calls.push([command, ...args].join(' '));
    await Promise.resolve();
    if (command === '/usr/bin/plutil') {
      const [, key, , , , plist] = args;
      const bundle = plist === undefined ? null : fake.bundleAt(dirname(dirname(plist)));
      if (bundle === null) return done(1, '', 'file does not exist');
      if (key === 'CFBundleShortVersionString') return done(0, `${bundle.version}\n`);
      if (key === 'CFBundleIdentifier') return done(0, `${bundle.identifier ?? BUNDLE_ID}\n`);
      return done(1, '', 'no value');
    }
    if (command === '/usr/bin/codesign') {
      const target = args.at(-1) ?? '';
      const bundle = fake.bundleAt(target);
      if (args[0] === '-dv') {
        if (bundle === null) return done(1, '', `${target}: code object is not signed at all`);
        const team = bundle.team ?? 'not set';
        return done(0, '', `Executable=${target}/Contents/MacOS/Callie\nIdentifier=${bundle.identifier ?? BUNDLE_ID}\nTeamIdentifier=${team}\n`);
      }
      if (args[0] === '--verify') {
        const requirement = args[args.indexOf('-R') + 1] ?? '';
        if (bundle === null || bundle.intact === false) return done(1, '', `${target}: a sealed resource is missing or invalid`);
        const named = bundle.team !== null && requirement.includes(`certificate leaf[subject.OU] = "${bundle.team}"`);
        if (!requirement.startsWith('=anchor apple generic') || !named) {
          return done(3, '', 'test-requirement: code failed to satisfy specified code requirement(s)');
        }
        return done(0);
      }
      return done(2, '', 'unexpected codesign call');
    }
    if (command === '/usr/bin/ditto') {
      const [, , zip, destination] = args;
      if (extractFails) {
        extractFails = false;
        return done(1, '', 'ditto: Couldn’t read PKZip signature');
      }
      if (zip === undefined || destination === undefined) return done(1);
      const bytes = await fake.files.readBytes(zip);
      if (bytes === null) return done(1, '', 'ditto: no such file');
      const parsed = JSON.parse(decoder.decode(bytes)) as { bundle: FakeBundle };
      fake.placeBundle(join(destination, 'Callie.app'), parsed.bundle);
      return done(0);
    }
    return done(-1, '', `no such tool ${command}`);
  };

  return {
    run,
    calls,
    failExtract: () => {
      extractFails = true;
    },
  };
}

export function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export const CHANNEL = 'https://updates.callie.test/';

export function manifestFor(bytes: Uint8Array, releaseVersion: string): UpdateManifest {
  return {
    format: 'fss-desktop-update',
    version: 1,
    channel: 'release',
    releaseVersion,
    commitSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    publishedAt: '2026-09-25T09:00:00.000Z',
    minimumSystemVersion: '13.0.0',
    artifact: {
      url: `${CHANNEL}releases/darwin-arm64/${releaseVersion}/Callie-${releaseVersion}-arm64.zip`,
      sizeBytes: bytes.byteLength,
      sha256: sha256Of(bytes),
    },
  };
}
