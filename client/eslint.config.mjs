// ESLint 9 flat configuration for the client package. It reuses the repository's root configuration so
// `npm run lint` here and the root `npm run lint:tracked` (which lints these files with the root config)
// agree, and only adds the ignores this package's own output directories need.
import root from '../eslint.config.mjs';

export default [
  {
    ignores: ['out/**', 'node_modules/**', '**/.*/', 'build/generated/**'],
  },
  ...root,
];
