import { readFile } from 'node:fs/promises';
import tailwind from '@tailwindcss/postcss';
import postcss from 'postcss';

/**
 * Tailwind, compiled once, by the two things that need the window's stylesheet: the
 * packaging build (`scripts/bundle.ts`) and the Playwright harness
 * (`test/e2e/support/appServer.ts`).
 *
 * One function rather than a step in each, because a spec that ran against a stylesheet
 * built differently from the shipped one would prove nothing about the shipped one. It
 * is a build script, so it may import a development dependency; nothing here ships.
 *
 * PostCSS rather than the CLI: the CLI is a second process to spawn and a second place
 * for the input path to be written down. `from` is the real path, which is how every
 * `@import` in it resolves and how Tailwind knows where `@source` is relative to.
 */
export async function compileStylesheet(entry: string): Promise<string> {
  const source = await readFile(entry, 'utf8');
  const result = await postcss([tailwind()]).process(source, { from: entry });
  return result.css;
}
