// Retain the ESM entrypoint while sharing one implementation with the real
// Playwright CommonJS loader. Do not import the release-marker CLI here.
export { resolveReleaseArtifact, readArtifactIdentity, assertArtifactIdentity } from './releaseArtifactCore.cjs';
