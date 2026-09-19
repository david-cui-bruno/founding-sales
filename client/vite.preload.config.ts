import { defineConfig } from 'vite';

// https://vitejs.dev/config
// One zod in the preload bundle (the shared contract imports the repository's copy).
export default defineConfig({
  resolve: { dedupe: ['zod'] },
});
