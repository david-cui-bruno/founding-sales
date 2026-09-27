import './renderer.ts';

/**
 * The window's entry point (1.0.12).
 *
 * `bundleScheme.ts` declares it and `scripts/bundle.ts` compiles it to `renderer.js`,
 * the one name `index.html` links and the closed scheme map serves. The file is `.tsx`
 * because the shell and the converted views are React; what it contains is the whole of
 * the renderer's boot and nothing else.
 */
