import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { expect, type Page } from 'playwright/test';
import { z } from 'zod';
import { callingWrapInputSchema, callingWrapResultSchema, callingFollowUpListSchema, callingFollowUpReadSchema, callingFollowUpSavedSchema, callingReceiptSchema, uuid } from '@fss/contracts';
import { browserRequest } from './browser.ts';
import { privateDraftCanonicalJson } from '../../src/client/PrivateDraftCustody.ts';
import { assertGlassStorage, navigateGlass, type GlassWorkspaceApp } from './glassWorkspaceApp.ts';
import type { GlassWorkspaceSeed } from './glassWorkspaceSeed.ts';

export const glassWrapAcceptance = z.strictObject({ status: z.literal('accepted'), replayed: z.boolean(), result: callingWrapResultSchema });
export const glassSaveAcceptance = z.strictObject({ status: z.literal('accepted'), replayed: z.boolean(), result: callingFollowUpSavedSchema });
const fingerprint = (value: unknown) => createHash('sha256').update(privateDraftCanonicalJson(value)).digest('hex');

async function canonicalSnapshot(app: GlassWorkspaceApp): Promise<Record<string, unknown[]>> {
  const snapshot: Record<string, unknown[]> = {};
  for (const table of ['firms', 'contacts', 'phone_routes', 'email_addresses', 'call_logs', 'callbacks', 'today_items', 'sequence_enrollments', 'step_executions', 'outbound_messages', 'suppression_events', 'jobs', 'provider_reservations']) {
    snapshot[table] = (await app.fixture.db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return snapshot;
}

/** Exact new route contracts over signed browser API/domain, not a frontend fake.
 * This complements, never substitutes for, the mounted Calling-to-Email path. */
export async function acceptGlassCandidateContract(page: Page, app: GlassWorkspaceApp, seed: GlassWorkspaceSeed): Promise<void> {
  const note = 'FICTIONAL PRIVATE NOTE 783, never copy into promised email.';
  const subject = 'FICTIONAL 783 explicitly edited promise';
  const body = 'FICTIONAL independent message. This is a private draft, not a send.';
  await navigateGlass(page, 'Prospects');
  await page.getByRole('button', { name: 'Retained review', exact: true }).click();
  await page.locator(`#manual-row-${seed.otherCandidateId}`).click();
  await expect(page.getByRole('article', { name: `Manual prospect ${seed.otherCandidateId}`, exact: true })).toBeVisible();
  await page.locator(`#manual-row-${seed.candidateId}`).click();
  await expect(page.getByRole('article', { name: `Manual prospect ${seed.candidateId}`, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open calling brief', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Current calling brief' })).toContainText('Retained observation · unverified');
  await page.getByRole('combobox', { name: 'Actual outcome', exact: true }).selectOption('conversation');
  await page.getByRole('textbox', { name: 'Private call notes', exact: true }).fill(note);
  await page.getByRole('combobox', { name: 'Next action', exact: true }).selectOption('promised_email');
  await expect(page.getByRole('textbox', { name: 'Promised email body', exact: true })).toHaveValue('');
  await page.getByRole('textbox', { name: 'Promised email subject', exact: true }).fill(subject);
  await page.getByRole('textbox', { name: 'Promised email body', exact: true }).fill(body);
  // Fictional simulation only. No real phone attempt is being asserted.
  await page.getByRole('checkbox', { name: 'I personally performed this manual phone attempt and am reporting what happened.', exact: true }).check();
  const before = await canonicalSnapshot(app);
  const responseReady = page.waitForResponse(response => new URL(response.url()).pathname === '/browser/api/calling/wrap' && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save outcome and promised email', exact: true }).click();
  const response = await responseReady;
  const first = { status: response.status(), body: await response.json() as unknown };
  const { commandId: rawCommandId, clientVersion, ...payload } = response.request().postDataJSON() as Record<string, unknown>;
  const commandId = uuid.parse(rawCommandId), input = callingWrapInputSchema.parse(payload);
  expect(clientVersion).toBeUndefined();
  expect(input).toMatchObject({ kind: 'candidate', candidateId: seed.candidateId, expectedCandidateRevision: 1, report: { result: 'conversation', note } });
  if (input.kind !== 'candidate' || !input.promisedEmail) throw Error('Exact candidate promised wrap required');
  const attemptId = input.attemptId, draftId = input.promisedEmail.draftId;
  expect(first.status).toBe(200);
  const accepted = glassWrapAcceptance.parse(first.body);
  expect(accepted.replayed).toBe(false);
  expect(accepted.result).toMatchObject({ kind: 'candidate', activity: { candidateId: seed.candidateId, candidateRevision: 1, attemptId, activityRevision: 1 }, staleIntroductions: 'not_applicable', followUp: { state: 'queued_for_review', draftId, revision: 1 } });
  expect(JSON.stringify(first.body)).not.toContain(note);
  expect(JSON.stringify(first.body)).not.toContain(subject);
  expect(JSON.stringify(first.body)).not.toContain(body);
  const duplicate = await browserRequest(page, '/calling/wrap', { body: { ...input, commandId } });
  expect(duplicate.status).toBe(200);
  expect(glassWrapAcceptance.parse(duplicate.body)).toEqual({ ...accepted, replayed: true });
  const receipt = await browserRequest(page, '/calling/follow-ups/receipt', { body: { operation: 'wrap', commandId, payloadSHA256: fingerprint(input) } });
  expect(receipt.status).toBe(200);
  expect(callingReceiptSchema.parse(receipt.body)).toEqual({ state: 'accepted', acceptance: { operation: 'wrap', result: accepted.result } });
  const unknown = await browserRequest(page, '/calling/follow-ups/receipt', { body: { operation: 'wrap', commandId: randomUUID(), payloadSHA256: fingerprint(input) } });
  expect(callingReceiptSchema.parse(unknown.body)).toEqual({ state: 'unknown' });
  const list = await browserRequest(page, '/calling/follow-ups/list', { body: {} });
  expect(list.status).toBe(200);
  expect(callingFollowUpListSchema.parse(list.body).drafts).toContainEqual(expect.objectContaining({ draftId, revision: 1, source: { kind: 'candidate', candidateId: seed.candidateId, candidateRevision: 1, attemptId } }));
  for (const privateText of [note, subject, body]) expect(JSON.stringify(list.body)).not.toContain(privateText);
  const current = await browserRequest(page, '/calling/follow-ups/read', { body: { draftId, expectedRevision: 1 } });
  expect(current.status).toBe(200);
  expect(callingFollowUpReadSchema.parse(current.body).draft).toMatchObject({ draftId, revision: 1, availability: 'available', content: { subject, body }, recipient: 'unresolved', sendAuthority: 'not_granted' });
  const edit = { operation: 'update', draftId, expectedRevision: 1, subject: `${subject} saved`, body: `${body} Independently edited again.` };
  const saved = await browserRequest(page, '/calling/follow-ups/save', { body: { ...edit, commandId: randomUUID() } });
  expect(saved.status).toBe(200);
  expect(glassSaveAcceptance.parse(saved.body).result).toEqual({ draftId, revision: 2 });
  await page.reload();
  const reopened = await browserRequest(page, '/calling/follow-ups/read', { body: { draftId, expectedRevision: 2 } });
  expect(reopened.status).toBe(200);
  expect(callingFollowUpReadSchema.parse(reopened.body).draft).toMatchObject({ availability: 'available', revision: 2, content: { subject: edit.subject, body: edit.body } });
  expect(await canonicalSnapshot(app)).toEqual(before);
  const stored = (await app.fixture.db.query<{ content: unknown }>('SELECT content FROM calling_follow_up_drafts WHERE id=$1', [draftId])).rows[0];
  assert(stored);
  expect(stored.content).toEqual({ subject: edit.subject, body: edit.body });
  const receipts = (await app.fixture.db.query('SELECT result FROM command_receipts WHERE command_id=$1', [commandId])).rows;
  expect(JSON.stringify(receipts)).not.toContain(note);
  expect(JSON.stringify(receipts)).not.toContain(body);
  await assertGlassStorage(page, [note, subject, body, edit.body]);
  const withdraw = await browserRequest(page, '/calling/follow-ups/save', { body: { operation: 'withdraw', draftId, expectedRevision: 2, commandId: randomUUID() } });
  expect(withdraw.status).toBe(200);
  expect(glassSaveAcceptance.parse(withdraw.body).result).toEqual({ draftId, revision: 3 });
  const terminal = await browserRequest(page, '/calling/follow-ups/read', { body: { draftId, expectedRevision: 3 } });
  expect(callingFollowUpReadSchema.parse(terminal.body).draft.availability).toBe('withdrawn');
  expect(JSON.stringify(terminal.body)).not.toContain(body);
  expect((await app.fixture.db.query<{ content: unknown }>('SELECT content FROM calling_follow_up_drafts WHERE id=$1', [draftId])).rows[0]?.content).toBeNull();
}
