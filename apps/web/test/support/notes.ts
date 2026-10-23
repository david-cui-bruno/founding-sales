import { expect, type Page } from 'playwright/test';
import type { LocalBrowserApp } from './appServer.ts';
import { browserSession } from './browser.ts';

/** Operates only the real mounted notes editor. Its retained UUID is non-secret. */
export async function leaveUncertainNotes(page: Page, app: LocalBrowserApp, note: string): Promise<{ commandId: string; revision: number }> {
  app.dropNextNotesResponse();
  await page.getByLabel('Your notes', { exact: true }).fill(note);
  const sent = page.waitForRequest(request => request.url().endsWith('/browser/api/meetings/notes') && request.method() === 'POST');
  await page.getByRole('button', { name: 'Save notes', exact: true }).click();
  const command = (await sent).postDataJSON() as { commandId: string; expectedRevision: number };
  await expect(page.getByText('Save outcome is unresolved.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry save', exact: true })).toBeEnabled();
  expect((await app.fixture.db.query('SELECT 1 FROM command_receipts WHERE command_id=$1', [command.commandId])).rows).toHaveLength(1);
  return { commandId: command.commandId, revision: command.expectedRevision + 1 };
}

export async function revokeCurrentDevice(page: Page, app: LocalBrowserApp): Promise<void> {
  const session = await browserSession(page);
  if (session.status !== 'signed_in') throw new Error('Expected real authenticated browser');
  await app.fixture.db.query("UPDATE devices SET status='revoked',revoked_at=now() WHERE workspace_id=$1 AND id=$2", [session.workspaceId, session.deviceId]);
}
