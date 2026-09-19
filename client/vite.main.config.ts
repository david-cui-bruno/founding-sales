import { defineConfig } from 'vite';

// https://vitejs.dev/config
// The thin client has no native module: nothing to copy, nothing to externalize beyond
// what the Forge Vite plugin already externalizes (electron and the Node builtins).
export default defineConfig({});
