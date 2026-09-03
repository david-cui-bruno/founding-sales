import { build } from "esbuild";

// Bundle for the Lambda nodejs22.x arm64 runtime. Everything is bundled in
// (including the AWS SDK v3, pinning its version instead of relying on the
// runtime-provided copy). Still far under Lambda zip limits.
await build({
  entryPoints: ["src/handler.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: "dist/handler.js",
  sourcemap: false,
  minify: false,
  logLevel: "info",
});
