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

// A semantic token such as --bauhaus-red is an identifier, not a named-color
// literal. Strip only the var() identifier, never its fallback value.
const colorWords = (value: string): string[] => value
  .replace(/var\(\s*--[a-z][a-z0-9-]*/gi, 'var(')
  .split(/[^a-zA-Z]+/);

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
  it('keeps shared presentation ownership independent of feature descendants', async () => {
    const native = await readFile(join(rendererRoot, 'features/today/nativeDesk.css'), 'utf8');
    expect(native).not.toMatch(/\.app-shell|\.nav-rail|--nav-rail-width\s*:/);
    for (const path of ['app.css', 'app/shell.css', 'design/tokens.css', 'design/themes.css']) {
      const content = await readFile(join(rendererRoot, path), 'utf8');
      expect(content, path).not.toMatch(/native-desk|startup-presentation|data-workflow-mode/);
    }
    const tokens = await readFile(join(rendererRoot, 'design/tokens.css'), 'utf8');
    expect(tokens).toContain(".presentation-root[data-presentation='native-a']");
  });

  it('distinguishes semantic color identifiers from literal fallback colors', () => {
    expect(colorWords('var(--bauhaus-red)')).not.toContain('red');
    expect(colorWords('var(--bauhaus-yellow, red)')).toContain('red');
    expect(colorWords('1px solid red')).toContain('red');
    expect(colorWords('color-mix(in srgb, var(--bauhaus-blue), yellow)')).toContain('yellow');
  });

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

  const designDir = `${join('renderer', 'design')}`;

  async function featureCssFiles(): Promise<string[]> {
    const files = await walk(rendererRoot);
    return files.filter(
      (file) => file.endsWith('.css') && !file.includes(designDir),
    );
  }

  /** Strip comments so prose like "indigo #5e6ad2" never trips the rules. */
  const withoutComments = (css: string): string =>
    css.replace(/\/\*[\s\S]*?\*\//g, '');

  it('keeps color literals out of feature CSS (hex, rgb/hsl/oklch, named)', async () => {
    // Only design/themes.css declares colors. Feature CSS consumes semantic
    // tokens; color-mix() over var() tokens plus the keywords transparent,
    // currentColor, and inherit are the sanctioned escape hatches.
    const NAMED_COLORS = new Set([
      'aqua', 'beige', 'black', 'blue', 'brown', 'coral', 'crimson', 'cyan',
      'fuchsia', 'gold', 'gray', 'green', 'grey', 'indigo', 'ivory', 'khaki',
      'lavender', 'lime', 'magenta', 'maroon', 'navy', 'olive', 'orange',
      'orchid', 'pink', 'plum', 'purple', 'red', 'salmon', 'silver', 'teal',
      'tomato', 'turquoise', 'violet', 'white', 'yellow',
    ]);
    const violations: string[] = [];

    for (const cssFile of await featureCssFiles()) {
      const path = relative(process.cwd(), cssFile);
      const content = withoutComments(await readFile(cssFile, 'utf8'));

      for (const match of content.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
        violations.push(`${path}: hex literal ${match[0]}`);
      }
      for (const match of content.matchAll(/\b(?:rgba?|hsla?|oklch)\(/g)) {
        violations.push(`${path}: color function ${match[0]}…)`);
      }
      for (const declaration of content.matchAll(
        /([a-z-]+)\s*:\s*([^;{}]+)[;}]/g,
      )) {
        const property = declaration[1]!;
        if (property.startsWith('--') || property === 'font-family') continue;
        const value = declaration[2]!;
        for (const word of colorWords(value)) {
          if (NAMED_COLORS.has(word.toLowerCase())) {
            violations.push(
              `${path}: named color "${word}" in ${property}: ${value.trim()}`,
            );
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps px font-size literals out of feature CSS', async () => {
    // The type scale lives in design/tokens.css; features pick a semantic
    // step (--text-*) instead of restating pixel sizes.
    const violations: string[] = [];

    for (const cssFile of await featureCssFiles()) {
      const path = relative(process.cwd(), cssFile);
      const content = withoutComments(await readFile(cssFile, 'utf8'));
      for (const match of content.matchAll(
        /font-size\s*:\s*([0-9][0-9.]*px)/g,
      )) {
        violations.push(`${path}: font-size ${match[1]}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps primitive-layer tokens out of feature CSS (semantic only)', async () => {
    // tokens.css and themes.css label their layers with /* PRIMITIVE */ and
    // /* SEMANTIC */ markers. Feature CSS may only reference the semantic
    // layer, so the ramp can be retuned without touching features.
    const designRoot = join(rendererRoot, 'design');
    const primitiveTokens = new Set<string>();

    for (const name of ['tokens.css', 'themes.css']) {
      const content = await readFile(join(designRoot, name), 'utf8');
      expect(content, `${name} must label its PRIMITIVE layer`).toContain(
        '/* PRIMITIVE */',
      );
      expect(content, `${name} must label its SEMANTIC layer`).toContain(
        '/* SEMANTIC */',
      );
      for (const section of content.split('/* PRIMITIVE */').slice(1)) {
        const primitiveOnly = section.split('/* SEMANTIC */')[0]!;
        for (const match of primitiveOnly.matchAll(/(--[a-z][a-z0-9-]*)\s*:/g)) {
          primitiveTokens.add(match[1]!);
        }
      }
    }

    expect(primitiveTokens.size).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const cssFile of await featureCssFiles()) {
      const path = relative(process.cwd(), cssFile);
      const content = await readFile(cssFile, 'utf8');
      for (const match of content.matchAll(/var\((--[a-z][a-z0-9-]*)[,)]/g)) {
        if (primitiveTokens.has(match[1]!)) {
          violations.push(`${path}: primitive token ${match[1]}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
