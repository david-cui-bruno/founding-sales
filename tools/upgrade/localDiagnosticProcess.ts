/** Private launcher: process IDs are witnessed before either composition can authenticate. */
import { readFile } from "node:fs/promises";
const [side, path] = process.argv.slice(2);
if ((side !== "api" && side !== "worker") || !path)
  throw new Error("diagnostic_launcher_invalid");
let environment: Record<string, string> | undefined;
for (let attempt = 0; attempt < 100; attempt++) {
  try {
    environment = JSON.parse(await readFile(path, "utf8"));
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
if (!environment) throw new Error("diagnostic_launcher_timeout");
if (side === "api") {
  const { main } = await import("../../apps/api/src/bootstrap/main.ts");
  process.exitCode = await main([], environment);
} else {
  const { main } = await import("../../apps/worker/src/bootstrap/main.ts");
  process.exitCode = await main([], environment);
}
