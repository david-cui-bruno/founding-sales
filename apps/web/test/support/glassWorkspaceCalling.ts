import { expect, type Page } from 'playwright/test';
import { callingFollowUpReadSchema, callingFollowUpListSchema, callingWrapInputSchema, uuid } from '@fss/contracts';
import { browserRequest } from './browser.ts';
import { glassSaveAcceptance, glassWrapAcceptance } from './glassWorkspaceContracts.ts';
import { assertGlassStorage, navigateGlass, type GlassWorkspaceApp } from './glassWorkspaceApp.ts';
import { assertGlassIntroductionsStopped, type GlassIntroductions } from './glassWorkspaceHistory.ts';
import type { GlassWorkspaceSeed } from './glassWorkspaceSeed.ts';

/** The checkbox attestation below is an explicit fictional acceptance simulation.
 * It does not claim a business call occurred and never invokes a phone/provider. */
export async function saveGlassCanonicalWrap(page: Page, app: GlassWorkspaceApp, seed: GlassWorkspaceSeed, history: GlassIntroductions) {
  await page.getByRole('button', { name: 'Open calling brief', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Calling', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Current research proof' })).toHaveCount(0);
  const brief = page.getByRole('region', { name: 'Current calling brief' });
  await expect(brief).toContainText(seed.name);
  const outcome = page.getByRole('combobox', { name: 'Actual outcome', exact: true });
  await expect(outcome).toBeEnabled();
  const link = brief.getByRole('link', { name: /Open (?:source-backed|observed) website/u });
  await expect(link).toHaveAttribute('href', seed.website);
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  // A reached disposition is explicit, not inferred interest or consent.
  await outcome.selectOption('not_interested');
  const note = 'FICTIONAL 783 private call note. Do not copy into promised email.';
  await page.getByRole('textbox', { name: 'Private call notes', exact: true }).fill(note);
  await page.getByRole('combobox', { name: 'Next action', exact: true }).selectOption('promised_email');
  await expect(page.getByRole('textbox', { name: 'Promised email body', exact: true })).toHaveValue('');
  const subject = 'FICTIONAL 783 promised overview, independently authored';
  const body = 'FICTIONAL 783 overview. No booking, sending or real contact is requested.';
  await page.getByRole('textbox', { name: 'Promised email subject', exact: true }).fill(subject);
  await page.getByRole('textbox', { name: 'Promised email body', exact: true }).fill(body);
  await page.getByRole('checkbox', { name: 'I personally performed this manual phone attempt and am reporting what happened.', exact: true }).check();
  const responseReady = page.waitForResponse(response => new URL(response.url()).pathname === '/browser/api/calling/wrap' && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save outcome and promised email', exact: true }).click();
  const response = await responseReady;
  expect(response.status()).toBe(200);
  // Validate what the actual browser sent, not only the displayed company name.
  const { commandId, clientVersion, ...payload } = response.request().postDataJSON() as Record<string, unknown>;
  uuid.parse(commandId);
  expect(clientVersion).toBeUndefined(); // Existing browser gateway pins this server-side.
  const command = callingWrapInputSchema.parse(payload);
  expect(command).toMatchObject({ kind: 'firm', firmId: seed.preparedFirmId, report: { performedByUser: true, outcome: 'not_interested', note }, promisedEmail: { nextAction: 'promised_email', subject, body } });
  const acceptance = glassWrapAcceptance.parse(await response.json());
  expect(acceptance.result).toMatchObject({ kind: 'firm', firmId: seed.preparedFirmId, staleIntroductions: 'stopped', followUp: { state: 'queued_for_review', revision: 1 } });
  if (acceptance.result.kind !== 'firm' || acceptance.result.followUp.state !== 'queued_for_review') throw Error('Canonical saved follow-up required');
  const { draftId, revision } = acceptance.result.followUp;
  const call = (await app.fixture.db.query<{ firm_id: string; outcome: string; note: string }>('SELECT firm_id,outcome,note FROM call_logs WHERE id=$1', [acceptance.result.callLogId])).rows[0];
  expect(call).toMatchObject({ firm_id: seed.preparedFirmId, outcome: 'not_interested', note });
  await assertGlassIntroductionsStopped(app, history);
  const read = await browserRequest(page, '/calling/follow-ups/read', { body: { draftId, expectedRevision: revision } });
  expect(read.status).toBe(200);
  expect(callingFollowUpReadSchema.parse(read.body).draft).toMatchObject({ draftId, availability: 'available', source: { kind: 'firm', firmId: seed.preparedFirmId, callLogId: acceptance.result.callLogId }, content: { subject, body }, recipient: 'unresolved', sendAuthority: 'not_granted' });
  expect(JSON.stringify(read.body)).not.toContain(note);
  await expect(page.getByRole('article', { name: 'Recorded calling outcome' })).toContainText('Sent and uncertain history preserved.');
  await assertGlassStorage(page, [note, subject, body]);
  await page.getByRole('button', { name: 'Review promised email in Email →', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Email', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Call wrap-up' })).toHaveCount(0);
  return { draftId, revision, subject, body, note };
}

export async function editGlassPromisedEmail(page: Page, saved: Awaited<ReturnType<typeof saveGlassCanonicalWrap>>): Promise<void> {
  const editor = page.getByRole('region', { name: 'Private follow-up editor', exact: true });
  await expect(editor.getByRole('textbox', { name: 'Follow-up subject', exact: true })).toHaveValue(saved.subject);
  await expect(editor.getByRole('textbox', { name: 'Follow-up body', exact: true })).toHaveValue(saved.body);
  await expect(editor).toContainText('Recipient unresolved');
  await expect(editor).not.toContainText(saved.note);
  const subject = `${saved.subject} · revised`, body = `${saved.body} Independently edited in Email.`;
  await editor.getByRole('textbox', { name: 'Follow-up subject', exact: true }).fill(subject);
  await editor.getByRole('textbox', { name: 'Follow-up body', exact: true }).fill(body);
  const responseReady = page.waitForResponse(response => new URL(response.url()).pathname === '/browser/api/calling/follow-ups/save' && response.request().method() === 'POST');
  await editor.getByRole('button', { name: 'Save private follow-up', exact: true }).click();
  const response = await responseReady;
  expect(response.status()).toBe(200);
  expect(response.request().postDataJSON()).toMatchObject({ operation: 'update', draftId: saved.draftId, expectedRevision: saved.revision, subject, body });
  expect(glassSaveAcceptance.parse(await response.json()).result).toEqual({ draftId: saved.draftId, revision: saved.revision + 1 });
  await expect(editor.getByRole('textbox', { name: 'Follow-up body', exact: true })).toHaveValue(body);
  const metadata = await browserRequest(page, '/calling/follow-ups/list', { body: {} });
  expect(metadata.status).toBe(200);
  expect(callingFollowUpListSchema.parse(metadata.body).drafts).toContainEqual(expect.objectContaining({ draftId: saved.draftId, revision: saved.revision + 1 }));
  for (const text of [saved.note, subject, body]) expect(JSON.stringify(metadata.body)).not.toContain(text);
  await assertGlassStorage(page, [saved.note, subject, body]);
  await page.reload();
  await navigateGlass(page, 'Email');
  await page.getByRole('navigation', { name: 'Email views' }).getByRole('button', { name: 'Follow-ups', exact: true }).click();
  const list = page.locator('[aria-label="Follow-up metadata"]');
  await expect(list).not.toContainText(subject);
  await expect(list).not.toContainText(body);
  await list.getByRole('button', { name: new RegExp(`^Draft ${saved.draftId}\\b`, 'u') }).click();
  await expect(editor.getByRole('textbox', { name: 'Follow-up subject', exact: true })).toHaveValue(subject);
  await expect(editor.getByRole('textbox', { name: 'Follow-up body', exact: true })).toHaveValue(body);
  await expect(editor.getByRole('heading', { name: 'Private promised email', exact: true })).toBeFocused();
  await editor.getByRole('button', { name: 'Back to follow-ups', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Calling follow-ups', exact: true })).toBeFocused();
}
