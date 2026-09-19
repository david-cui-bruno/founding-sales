import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import {
  developmentContentSecurityPolicy,
  developmentViteServer,
  productionContentSecurityPolicy,
} from '../src/main/contentSecurityPolicy';

// The renderer imports the shared `/v1` contract from the repository's `src/shared`, one directory above
// this package, so the dev server must be allowed to serve files from the repository root.
const repositoryRoot = resolve(__dirname, '..');

export default defineConfig(({ command }) => ({
  root: 'src/renderer',
  build: {
    outDir: resolve(__dirname, '.vite/renderer/main_window'),
  },
  resolve: { dedupe: ['zod', 'react', 'react-dom'] },
  server: {
    host: developmentViteServer.host,
    port: developmentViteServer.port,
    strictPort: true,
    hmr: {
      host: developmentViteServer.host,
      port: developmentViteServer.port,
      protocol: 'ws',
    },
    fs: { allow: [repositoryRoot] },
  },
  plugins: [
    {
      name: 'callie-csp',
      transformIndexHtml(html) {
        const content =
          command === 'serve'
            ? developmentContentSecurityPolicy
            : productionContentSecurityPolicy;

        return html.replace('__CALLIE_CSP__', content);
      },
    },
    react(),
  ],
}));
