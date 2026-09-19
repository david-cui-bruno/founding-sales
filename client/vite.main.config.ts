import { defineConfig } from 'vite';

// https://vitejs.dev/config
// The thin client has no native module: nothing to copy, nothing to externalize beyond
// what the Forge Vite plugin already externalizes (electron and the Node builtins).
// The shared /v1 contract lives one directory up and imports zod from the repository's
// node_modules; dedupe keeps one zod in the bundle, this package's.
export default defineConfig({
  resolve: { dedupe: ['zod'] },
});
