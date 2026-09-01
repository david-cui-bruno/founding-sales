import { build } from "esbuild";

// Bundle for the Lambda nodejs22.x arm64 runtime. Everything bundled in
// (including the AWS SDK v3, pinning its version). terraform zips dist/.
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
