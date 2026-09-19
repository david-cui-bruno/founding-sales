import { z } from 'zod';
import { TERRITORY_CLEARANCE_STATEMENTS, TERRITORY_RULES_REVISION, TERRITORY_STATE_RULES } from '../../../../../src/shared/contracts/territoryClearanceContract';
import { googleGrantViewSchema, researchViewSchema, sendingViewSchema, settingsTemplateSchema, settingsViewSchema,
  type GoogleGrantView, type ResearchView, type SendingView, type SettingsTemplate, type SettingsView } from '../../../../../src/shared/contracts/v1Contract';
import type { DynamoStore } from '../dynamoStore';
import { callPolicyView, readCallPolicy } from './callPolicy';
import { descriptorStatusAt, RESEARCH_DAILY_BUDGET_CEILING, readResearchSettings, remainingResearchToday } from './pool';
import { V1Devices } from './devices';
import { GOOGLE_GRANT_PREFIX, grantPairingIds } from './mailbox';
import { phoneSetupView, pausedView, readPausedRecord, readPhoneSetup } from './phoneSetup';
import { postureHistory, postureSummary, readPostures } from './postures';
import { footerBlock, readSendingSettings, readSendUsage, readTemplates, SENDING_CEILING, sendingCapForDay, templateApprovalIssues,
  templateApproved } from './templates';

/**
 * `GET /v1/settings` in full (FSS target design section 3; slice S5). Every control the design's
 * "Controls you use today, mapped" table keeps has a section here:
 *
 *   States      the postures per state with their review dates and every earlier decision, and the reference texts
 *   Templates   the five templates, their standing approval and the footer check (S3's records)
 *   Sending     the daily limit, the ramp, the ceiling fixed in code, the postal address and today's cap line (S3)
 *   Research    S4's `SETTINGS#research`: the queries, the daily budget and the descriptor window David renews
 *   Calls       the hours inside the code floor and the per-state narrowing (S5)
 *   Phone       whether the Phone.app setup was confirmed and the digest of the proof (S5)
 *   Google      the grant as the table holds it, read without a refresh and without a network call
 *   Devices     the paired devices with their expiry (S0)
 *   Paused      whether everything is stopped and why (S5)
 *
 * Reading Settings decides nothing and touches no provider. Every section that cannot be read is said plainly —
 * "not connected", "not set", "read-only until S4" — and never shown as a working setting with an empty value.
 */

/** The clearance statements and per-state texts at `TERRITORY_RULES_REVISION`, copied out of the frozen contract objects. */
export function referenceTexts(): SettingsView['referenceTexts'] {
  return {
    revision: TERRITORY_RULES_REVISION,
    statements: { ...TERRITORY_CLEARANCE_STATEMENTS },
    states: Object.values(TERRITORY_STATE_RULES).map(rule => ({ state: rule.state, name: rule.name, summary: rule.summary,
      citation: { ...rule.citation }, furtherCitations: rule.furtherCitations.map(citation => ({ ...citation })) })),
  };
}

/**
 * The research section: S4's `SETTINGS#research` read through S4's own reader, so a field this view shows and a
 * field that record carries are the same field by construction. Nothing here is parsed loosely or guessed at; a
 * shape this module and S4 disagree about is a type error, not a quietly empty section.
 */
export async function readResearchView(store: DynamoStore): Promise<ResearchView> {
  const now = store.now();
  const [{ record }, today] = await Promise.all([readResearchSettings(store, now), remainingResearchToday(store, now)]);
  return researchViewSchema.parse({
    queries: [...record.queries],
    dailyBudget: record.dailyBudget,
    budgetCeiling: RESEARCH_DAILY_BUDGET_CEILING,
    descriptor: record.descriptor === null ? null
      : { reviewedAt: record.descriptor.reviewedAt, expiresAt: record.descriptor.expiresAt,
        // Recomputed at this instant, so a window that expired since the record was written reads as expired here.
        status: descriptorStatusAt(record.descriptor, now) ?? 'expired' },
    todaySpend: { date: today.date, spent: today.spent, budget: today.budget, remaining: today.remaining },
    revision: record.revision,
    updatedAt: record.updatedAt,
  });
}

const GRANT_NOTES = Object.freeze({
  connected: 'Connected through the pairing-bound grant the old worker holds. It is replaced by a fresh consent at cutover.',
  not_connected: 'No usable Google grant. Nothing can send or poll until the mailbox is connected.',
  revoked: 'Every Google grant on this workspace is revoked. Nothing can send or poll.',
  multiple_grants: 'More than one usable grant is stored, so the worker cannot say which mailbox is the one. Nothing sends until exactly one remains.',
});
const grantRowSchema = z.object({ revoked: z.boolean().optional(), grant: z.object({ email: z.string().max(320) }).optional() });

/**
 * The grant status from the table alone. No refresh and no network call: a view is never an action, so a grant
 * whose refresh token the provider has since rejected reads as connected here and as `mailbox_not_connected` at
 * the moment a send asks for a token. The Diagnostics attempt log is where that difference shows up.
 */
export async function readGoogleGrantView(store: DynamoStore): Promise<GoogleGrantView> {
  const rows = (await store.list<unknown>(GOOGLE_GRANT_PREFIX)).filter(row => !row.key.includes('#personal_availability'));
  const parsed = rows.map(row => ({ key: row.key, data: grantRowSchema.safeParse(row.stored.data) }));
  const live = parsed.filter(row => row.data.success && row.data.data.revoked !== true && row.data.data.grant !== undefined);
  const status = live.length === 1 ? 'connected' : live.length > 1 ? 'multiple_grants' : rows.length > 0 ? 'revoked' : 'not_connected';
  const email = status === 'connected' && live[0]?.data.success ? live[0].data.data.grant?.email ?? null : null;
  return googleGrantViewSchema.parse({ status, email, grants: grantPairingIds(live.map(row => row.key)).length, reconsentAtCutover: true, note: GRANT_NOTES[status] });
}

/** One template with the footer check and every reason it could not be approved as it stands. Pure over the records. */
export function settingsTemplate(record: Awaited<ReturnType<typeof readTemplates>>[number], postalAddress: string | null): SettingsTemplate {
  return settingsTemplateSchema.parse({
    templateId: record.templateId, name: record.name, subject: record.subject, body: record.body,
    variables: [...record.variables], revision: record.revision,
    state: record.approval.state, approvedAt: record.approval.approvedAt, approvedRevision: record.approval.approvedRevision,
    approved: templateApproved(record, postalAddress),
    footerPresent: postalAddress !== null && record.body.endsWith(footerBlock(postalAddress)),
    issues: templateApprovalIssues({ subject: record.subject, body: record.body, postalAddress }),
  });
}

/** The sending section with the ceiling fixed in code beside the settings, and today's cap line from the counter. */
export async function readSendingView(store: DynamoStore): Promise<SendingView> {
  const now = store.now();
  const [{ settings }, usage] = await Promise.all([readSendingSettings(store), readSendUsage(store, now)]);
  const cap = sendingCapForDay(settings, usage.firstSendAt, now);
  return sendingViewSchema.parse({
    dailyLimit: settings.dailyLimit, ramp: { ...settings.ramp }, ceiling: { ...SENDING_CEILING },
    postalAddress: settings.postalAddress, revision: settings.revision, updatedAt: settings.updatedAt,
    capLine: { date: usage.date, cap: cap.today, day: cap.day, used: usage.used, remaining: Math.max(0, cap.today - usage.used) },
    footerBlock: settings.postalAddress === null ? null : footerBlock(settings.postalAddress),
  });
}

export async function readSettingsView(store: DynamoStore): Promise<SettingsView> {
  const now = store.now();
  const [postures, templates, { settings }, sending, research, calls, phone, google, devices, paused] = await Promise.all([
    readPostures(store),
    readTemplates(store),
    readSendingSettings(store),
    readSendingView(store),
    readResearchView(store),
    readCallPolicy(store),
    readPhoneSetup(store),
    readGoogleGrantView(store),
    new V1Devices(store).listDevices(),
    readPausedRecord(store),
  ]);
  return settingsViewSchema.parse({
    postures: postures.map(record => postureSummary(record, now)),
    postureHistory: postures.filter(record => record.history.length > 0).map(record => ({ state: record.state, entries: postureHistory(record) })),
    referenceTexts: referenceTexts(),
    templates: templates.map(record => settingsTemplate(record, settings.postalAddress)),
    sending,
    research,
    calls: callPolicyView(calls.record),
    phone: phoneSetupView(phone.record),
    google,
    devices,
    paused: pausedView(paused),
  });
}
