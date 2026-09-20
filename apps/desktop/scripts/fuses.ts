/**
 * The Electron fuses the build burns into the binary, as plain data.
 *
 * A fuse is a byte in the executable, so it survives into the shipped bundle and can
 * be read back out of it — which is why the verifier compares against this object
 * rather than trusting that the build step ran. The names are the ones
 * `@electron/fuses` prints, so a mismatch names the fuse a person can look up.
 *
 * `LoadBrowserProcessSpecificV8Snapshot` is off for the reason the old client
 * recorded in `build/electronFuses.ts`: Electron 44's stock arm64 bundle ships no
 * `browser_v8_context_snapshot` file, and enabling the fuse makes that supported
 * runtime die with SIGTRAP at launch.
 */

export const DESKTOP_FUSES = Object.freeze({
  /** `ELECTRON_RUN_AS_NODE` would turn the signed, notarized bundle into a shell. */
  RunAsNode: false,
  EnableCookieEncryption: true,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  /** The asar's hash is checked against one embedded in the signed Info.plist. */
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
  LoadBrowserProcessSpecificV8Snapshot: false,
  /** Nothing is served from `file://`; the renderer is loaded from the bundle. */
  GrantFileProtocolExtraPrivileges: false,
  /** V8's guard-page trap handling on arm64. Turning it off is a slower, not safer, build. */
  WasmTrapHandlers: true,
});

export type DesktopFuseName = keyof typeof DESKTOP_FUSES;

export type FuseComparison =
  | { readonly ok: true }
  | { readonly ok: false; readonly mismatched: readonly string[] };

export function compareFuses(found: Readonly<Record<string, boolean>>): FuseComparison {
  const mismatched = Object.entries(DESKTOP_FUSES)
    .filter(([name, expected]) => found[name] !== expected)
    .map(([name]) => name)
    .sort();
  return mismatched.length === 0 ? { ok: true } : { ok: false, mismatched };
}
