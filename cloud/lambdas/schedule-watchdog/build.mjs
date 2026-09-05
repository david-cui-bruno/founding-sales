import { build } from "esbuild";
import { writeFile } from "node:fs/promises";

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

await writeFile("dist/package.json", '{"type":"commonjs"}\n');
