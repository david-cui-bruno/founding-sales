import { readdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

// Runs after the runtime image's final code copy/removal, never against a checkout.
const root = resolve(process.argv[2] ?? '/app');
const paths = [];
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (/^(?:node_modules|testing|tests?|__tests__|fixtures)$/u.test(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory() && /^[A-Za-z0-9_-]+$/u.test(entry.name)) await visit(path);
    else if (entry.isFile() && /^[A-Za-z0-9_-]+\.ts$/u.test(entry.name)) paths.push(relative(root, path));
  }
}
await visit(join(root, 'apps'));
await visit(join(root, 'packages'));
if (!paths.length) throw new Error('Runtime contains no approved native code files');
await writeFile(join(root, 'packages/telemetry/source-files.json'), JSON.stringify(paths.sort()), { flag: 'wx', mode: 0o644 });
