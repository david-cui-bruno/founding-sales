import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import {
  developmentContentSecurityPolicy,
  developmentViteServer,
  productionContentSecurityPolicy,
} from './src/main/contentSecurityPolicy';

export default defineConfig(({ command }) => ({
  root: 'src/renderer',
  server: {
    host: developmentViteServer.host,
    port: developmentViteServer.port,
    strictPort: true,
    hmr: {
      host: developmentViteServer.host,
      port: developmentViteServer.port,
      protocol: 'ws',
    },
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
