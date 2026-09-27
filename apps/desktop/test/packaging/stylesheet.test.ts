import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileStylesheet } from '../../scripts/styles.ts';
import { BUNDLE_STYLESHEET_SOURCE } from '../../src/main/bundleScheme.ts';

/**
 * The one stylesheet, as the packaging build compiles it (1.0.12).
 *
 * The window's CSS is two halves that must not reach each other: Tailwind, for the
 * React views, and `legacy.css`, for the page modules that are still hand-rolled DOM.
 * The arrangement that keeps them apart is a layer order and a scope, and both are
 * properties of the compiled file rather than of the source — a `@scope` that some
 * transform dropped, or a preflight that landed in the wrong layer, would look exactly
 * like the source being right.
 */

const stylesheet = await compileStylesheet(
  fileURLToPath(new URL(`../../src/renderer/${BUNDLE_STYLESHEET_SOURCE}`, import.meta.url)),
);

describe('the compiled stylesheet', () => {
  it('declares the layer order the two halves depend on', () => {
    expect(stylesheet).toContain('@layer theme, base, legacy, components, utilities;');
  });

  it('keeps the hand-rolled views’ rules inside their scope, and nowhere else', () => {
    expect(stylesheet).toContain('@scope ([data-legacy])');
    // The rule that used to reach a React button: inside the scope, and only there.
    const scope = stylesheet.slice(stylesheet.indexOf('@scope ([data-legacy])'));
    expect(scope).toMatch(/\bbutton\s*\{[^}]*border:\s*1px solid var\(--line-strong\)/u);
  });

  it('ships preflight in the base layer, under the legacy rules', () => {
    expect(stylesheet).toContain('@layer base');
    // Preflight's universal reset is what takes the user agent's button and list
    // styles off the React views.
    expect(stylesheet).toMatch(/\*,\s*::after,\s*::before/u);
  });

  it('puts the list markers preflight removes back for the hand-rolled lists', () => {
    // A sequence's steps and a stage history are numbered lists; the rows-with-dividers
    // lists say `list-style: none` for themselves.
    const scope = stylesheet.slice(stylesheet.indexOf('@scope ([data-legacy])'));
    expect(scope).toMatch(/\bol\s*\{\s*list-style:\s*decimal;?\s*\}/u);
    expect(scope).toMatch(/\bul\s*\{\s*list-style:\s*disc;?\s*\}/u);
  });

  it('keeps the stop tone the import screen and Settings still ask for', () => {
    expect(stylesheet).toMatch(/\.tag-stop\s*\{[^}]*var\(--stop\)/u);
  });

  it('hides an element with `hidden`, whatever display class it also has', () => {
    // Unlayered, so it beats every utility: `class="flex" hidden` is not a visible row.
    expect(stylesheet).toMatch(/\[hidden\]\s*\{\s*display:\s*none;?\s*\}/u);
  });
});
