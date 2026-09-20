import { execFileSync } from 'node:child_process';

/**
 * What macOS thinks can open a URL scheme (specification 17: "personal-phone `tel:`
 * handoff with one-use tickets"; 14.2: "`tel:` handoff with a verified local-setup
 * check", and "secure deep links").
 *
 * The check has to be a read. Asking macOS to open `tel:+1...` in order to find out
 * whether anything handles it would place a call, and asking the person to try is
 * not a check. Launch Services has no public query tool, so this reads the database
 * `lsregister` dumps and looks for bundles that claim the scheme.
 *
 * The dump is large — a third of a million lines on a working Mac — and slow, so
 * the parser is separated from the process call: the pure half is unit-tested
 * against a fixture, and the host layer runs the real thing once.
 */

export const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

export type SchemeHandlers =
  | { readonly kind: 'available'; readonly bundleIds: readonly string[] }
  | { readonly kind: 'absent' }
  /** Not macOS, or the database could not be read. Never "absent", which would be a claim. */
  | { readonly kind: 'unknown' };

/**
 * Bundle identifiers claiming `scheme`, from an `lsregister -dump`.
 *
 * Records are separated by rules of dashes. A bundle record carries `identifier:`
 * and, when it claims schemes, `claimed schemes:` with a comma-separated list of
 * `name:` entries. Claim records (the `bindings:` lines) are ignored: they name the
 * bundle by display name rather than by identifier, and every scheme that appears
 * in one appears in a bundle's claim list too.
 */
export function handlersForScheme(dump: string, scheme: string): readonly string[] {
  const wanted = `${scheme}:`;
  const found = new Set<string>();
  for (const record of dump.split(/^-{10,}$/m)) {
    const claimed = /^claimed schemes:\s+(.*)$/m.exec(record);
    if (claimed === null) continue;
    const schemes = (claimed[1] ?? '').split(',').map(entry => entry.trim());
    if (!schemes.includes(wanted)) continue;
    const identifier = /^identifier:\s+(\S+)/m.exec(record);
    if (identifier !== null) found.add(identifier[1] ?? '');
  }
  return [...found].filter(value => value.length > 0).sort();
}

export type DumpRunner = (command: string, args: readonly string[]) => string;

const defaultRunner: DumpRunner = (command, args) =>
  String(
    execFileSync(command, [...args], {
      encoding: 'utf8',
      timeout: 120_000,
      // The dump is tens of megabytes on a Mac with a normal number of apps.
      maxBuffer: 256 * 1024 * 1024,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    }),
  );

export function dumpLaunchServices(run: DumpRunner = defaultRunner): string | null {
  if (process.platform !== 'darwin') return null;
  try {
    return run(LSREGISTER, ['-dump']);
  } catch {
    return null;
  }
}

/** The local-setup check. A read, and one that never launches anything. */
export function probeSchemeHandlers(scheme: string, run: DumpRunner = defaultRunner): SchemeHandlers {
  const dump = dumpLaunchServices(run);
  if (dump === null) return { kind: 'unknown' };
  const bundleIds = handlersForScheme(dump, scheme);
  return bundleIds.length === 0 ? { kind: 'absent' } : { kind: 'available', bundleIds };
}
