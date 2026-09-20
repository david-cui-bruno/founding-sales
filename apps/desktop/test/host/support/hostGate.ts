import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The host layer, and why it is not in the per-change gate.
 *
 * `docs/decisions/g2-desktop-test-layers.md` left these as the only untested seam:
 * the real Keychain, real Launch Services, a real packaged bundle and a real
 * `codesign`. All four need macOS, three of them need the 300 MB Electron binary
 * that the documented `--ignore-scripts` install does not fetch, and one of them
 * spends a minute packaging. So they run behind an explicit opt-in, on macOS only:
 *
 *   FSS_HOST_TESTS=1 npm run test:desktop:host
 *
 * and in the macOS job of `.github/workflows/greenfield-desktop.yml`. In the ordinary
 * greenfield gate they report as skipped, which is honest: they did not run.
 */

export const HOST_TESTS_ENABLED = process.platform === 'darwin' && process.env.FSS_HOST_TESTS === '1';

/** `apps/desktop`, from this file rather than from the working directory. */
export const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const REPOSITORY_ROOT = resolve(DESKTOP_ROOT, '..', '..');
