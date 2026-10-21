/** Publish complete local diagnostic status snapshots without exposing truncation to readers. */
import { open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export async function writeLocalDiagnosticStatus(directory: string, value: unknown) {
  const bytes = JSON.stringify(value);
  const temporary = join(directory, `.status-${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  let publicationFailed = false;
  let publicationError: unknown;
  try {
    await file.writeFile(bytes);
    await file.sync();
    await file.close();
    // Same-directory rename keeps the old complete snapshot visible until this one is ready.
    await rename(temporary, join(directory, "status.json"));
  } catch (error) {
    publicationFailed = true;
    publicationError = error;
  }
  try {
    try {
      await file.close();
    } finally {
      await rm(temporary, { force: true });
    }
  } catch (error) {
    // Retain the original publication failure if cleanup also fails.
    if (!publicationFailed) throw error;
  }
  if (publicationFailed) throw publicationError;
}
