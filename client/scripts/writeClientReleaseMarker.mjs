import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeReleaseMarker } from '../../scripts/writeReleaseMarker.mjs';

// The same release marker the old app embeds, written under this package's own `build/generated/` so the
// client's Forge run and `scripts/verifyClientPackage.mjs` read the marker that belongs to this package.
// A dirty or untracked working tree refuses the marker, exactly as at the root.
const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try {
  console.log(JSON.stringify(writeReleaseMarker({ root: clientRoot })));
} catch {
  console.error('RELEASE_PROVENANCE_FAILED');
  process.exitCode = 1;
}
