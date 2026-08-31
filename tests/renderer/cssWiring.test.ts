import { readdir, readFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Regression guard for a real shipped bug: feature pages rendered completely
 * unstyled because their colocated CSS file was written but never imported.
 * jsdom applies no CSS, so no component test can catch this. This static
 * check closes that hole permanently.
 */

const rendererRoot = join(process.cwd(), 'src', 'renderer');

async function walk(directory: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(path)));
    } else if (entry.isFile()) {
      out.push(path);
    }
  }
  return out;
}

describe('renderer CSS wiring', () => {
  it('imports every non-design CSS file from a sibling module or aggregator', async () => {
    const files = await walk(rendererRoot);
    const cssFiles = files.filter(
      (file) =>
        file.endsWith('.css') &&
        !file.includes(`${join('renderer', 'design')}`) &&
        basename(file) !== 'app.css',
    );
    const sources = await Promise.all(
      files
        .filter((file) => /\.(tsx?|css)$/.test(file))
        .map(async (file) => ({ file, content: await readFile(file, 'utf8') })),
    );

    const unimported: string[] = [];
    for (const cssFile of cssFiles) {
      const name = basename(cssFile);
      const isImported = sources.some(({ file, content }) => {
        if (file === cssFile) return false;
        return (
          content.includes(`'./${name}'`) ||
          content.includes(`"./${name}"`) ||
          content.includes(`/${name}'`) ||
          content.includes(`/${name}"`)
        );
      });
      if (!isImported) {
        unimported.push(relative(process.cwd(), cssFile));
      }
    }

    expect(unimported).toEqual([]);
  });

  it('has every feature route/page module import a colocated stylesheet', async () => {
    const featureRoot = join(rendererRoot, 'features');
    const features = await readdir(featureRoot, { withFileTypes: true });
    const missing: string[] = [];

    for (const feature of features) {
      if (!feature.isDirectory()) continue;
      const directory = join(featureRoot, feature.name);
      const files = await walk(directory);
      const cssFiles = files.filter((file) => file.endsWith('.css'));
      if (cssFiles.length === 0) continue;

      const modules = files.filter(
        (file) => file.endsWith('.tsx') && !file.includes('.test.'),
      );
      const anyImportsCss = await Promise.all(
        modules.map(async (module) => {
          const content = await readFile(module, 'utf8');
          return cssFiles.some((cssFile) =>
            content.includes(`'./${basename(cssFile)}'`),
          );
        }),
      );

      if (!anyImportsCss.some(Boolean)) {
        missing.push(relative(process.cwd(), directory));
      }
    }

    expect(missing).toEqual([]);
  });

  it('references only defined CSS custom properties in renderer styles', async () => {
    const files = await walk(rendererRoot);
    const cssFiles = files.filter((file) => file.endsWith('.css'));
    const defined = new Set<string>();
    const used = new Map<string, string>();

    for (const cssFile of cssFiles) {
      const content = await readFile(cssFile, 'utf8');
      for (const match of content.matchAll(/(--[a-z][a-z0-9-]*)\s*:/g)) {
        defined.add(match[1]!);
      }
      for (const match of content.matchAll(/var\((--[a-z][a-z0-9-]*)[,)]/g)) {
        if (!used.has(match[1]!)) {
          used.set(match[1]!, relative(process.cwd(), cssFile));
        }
      }
    }

    const undefinedTokens = [...used.entries()]
      .filter(([token]) => !defined.has(token))
      .map(([token, file]) => `${token} used in ${file}`);

    expect(undefinedTokens).toEqual([]);
  });
});
