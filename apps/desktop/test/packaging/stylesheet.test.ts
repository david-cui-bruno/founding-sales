import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileStylesheet } from '../../scripts/styles.ts';
import { BUNDLE_STYLESHEET_SOURCE } from '../../src/main/bundleScheme.ts';

/**
 * The one stylesheet, as the packaging build compiles it (1.0.12; 1.0.13).
 *
 * 1.0.12 compiled two halves that had to be kept apart — Tailwind for the React views,
 * and `legacy.css`, in a layer of its own scoped to `[data-legacy]`, for the views that
 * were still hand-rolled DOM. 1.0.13 converted the last of them, so the file, the
 * scope, the attribute and the layer are gone and there is one reset.
 *
 * What is asserted here is still a property of the *compiled* file rather than of the
 * source, because that is the difference this suite exists for: a `@layer` some
 * transform reordered, or a preflight that landed outside `base`, would look exactly
 * like the source being right.
 */

const stylesheet = await compileStylesheet(
  fileURLToPath(new URL(`../../src/renderer/${BUNDLE_STYLESHEET_SOURCE}`, import.meta.url)),
);

describe('the compiled stylesheet', () => {
  it('declares the layer order, with no layer for the views 1.0.13 deleted', () => {
    expect(stylesheet).toContain('@layer theme, base, components, utilities;');
    expect(stylesheet).not.toContain('legacy');
  });

  it('carries no scope and nothing addressed to the attribute the shell no longer sets', () => {
    expect(stylesheet).not.toContain('@scope');
    expect(stylesheet).not.toContain('[data-legacy]');
  });

  it('ships preflight in the base layer, so it is the only reset', () => {
    expect(stylesheet).toContain('@layer base');
    // Preflight's universal reset is what takes the user agent's button and list
    // styles off the views.
    expect(stylesheet).toMatch(/\*,\s*::after,\s*::before/u);
  });

  it('keeps the window’s own four base rules under the utilities', () => {
    const base = stylesheet.slice(stylesheet.indexOf('@layer base'));
    expect(base).toMatch(/html,\s*body\s*\{\s*height:\s*100%;?\s*\}/u);
    expect(base).toMatch(/\*:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--ring\)/u);
  });

  it('hides an element with `hidden`, whatever display class it also has', () => {
    // Unlayered, so it beats every utility: `class="flex" hidden` is not a visible row.
    expect(stylesheet).toMatch(/\[hidden\]\s*\{\s*display:\s*none;?\s*\}/u);
  });
});
