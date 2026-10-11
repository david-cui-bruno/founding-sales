/** Read the same checked source declaration used by normal release tooling.
 * Plain Node operator commands must not load TypeScript runtime dependencies.
 */
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../../packages/domain/db/schemaRange.ts", import.meta.url),
  "utf8",
);
const declarations = [...source.matchAll(/^export const REQUIRED_SCHEMA = (\d+);$/gmu)];
const schema = Number(declarations[0]?.[1]);
if (
  source.length > 32768 ||
  declarations.length !== 1 ||
  !Number.isSafeInteger(schema) ||
  schema < 90 ||
  schema > 2147483647 ||
  !["API", "WORKER"].every((side) =>
    new RegExp(
      `^export const ${side}_SCHEMA_RANGE:\\s*SchemaRange\\s*=\\s*\\{\\s*minimum:\\s*REQUIRED_SCHEMA,\\s*maximum:\\s*REQUIRED_SCHEMA\\s*\\};$`,
      "mu",
    ).test(source),
  )
)
  throw new Error("diagnostic_schema_contract_invalid");

export const REQUIRED_SCHEMA = schema;
