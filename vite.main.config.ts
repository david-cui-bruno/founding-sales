import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  plugins: [{
    name: 'copy-safe-log-fs-native',
    closeBundle() {
      const destination = resolve('.vite/build/safe_log_fs.node');
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(
        resolve('native/safe-log-fs/build/Release/safe_log_fs.node'),
        destination,
      );
    },
  }],
  build: {
    rollupOptions: {
      external: ['better-sqlite3-multiple-ciphers'],
    },
  },
});
