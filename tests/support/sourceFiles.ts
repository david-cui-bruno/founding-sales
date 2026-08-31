import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const isSourceFile = (name: string): boolean =>
  (name.endsWith('.ts') || name.endsWith('.tsx')) &&
  !name.endsWith('.test.ts') &&
  !name.endsWith('.test.tsx') &&
  !name.endsWith('.spec.ts') &&
  !name.endsWith('.d.ts');

/**
 * Recursively collects sorted production `.ts`/`.tsx` paths under the given
 * roots, excluding test files, for static contract regressions.
 */
export async function workflowSourceFiles(
  roots: readonly string[],
): Promise<string[]> {
  const files: string[] = [];

  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() && isSourceFile(entry.name)) {
        files.push(path);
      }
    }
  };

  for (const root of roots) {
    await walk(join(process.cwd(), root));
  }

  return files.sort();
}

export { readFile };
