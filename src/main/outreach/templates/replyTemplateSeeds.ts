import { REPLY_TEMPLATE_SIGN_OFF, replyTemplateContentHash, replyTemplateSchema, type ReplyTemplate, type ReplyTemplateId, type ReplyTemplateVariable } from '../../../shared/contracts/replyTemplateContract';

/**
 * T1 to T5 exactly as David drafted them on 17 September 2026 (`.context/FSS-Follow-up-Templates-20260917.md`).
 * Migration 0030 seeds these five as `draft`: a migration never approves anything, and the worker is never
 * told about a template until David presses Approve in Settings. The booking link is his public Google
 * Workspace appointment schedule page, copied from that file; it is a page anyone may open, not a credential.
 *
 * Editing any of this text in place is a product decision, not a refactor: the seeds are the text he read.
 */
const BOOKING_LINK = 'https://calendar.google.com/calendar/appointments/schedules/AcZssZ039qbjGv7W4_iAOzrPcHz6nrIFpHvaPsEJzag4PlOvi189ZhduhAfyHoUx2Hot_tLoxume_haU';
type Seed = Readonly<{ id: ReplyTemplateId; name: string; purpose: ReplyTemplate['purpose']; subject: string; body: string; variables: readonly ReplyTemplateVariable[] }>;
export const REPLY_TEMPLATE_SEEDS: readonly Seed[] = Object.freeze([
  Object.freeze({
    id: 'T1', name: 'After a conversation', purpose: 'after_conversation',
    subject: 'Following up on our call, {firm}',
    body: `Thanks for the time today. As discussed, Callie is a 24/7 maintenance agent for property managers: it handles tenant requests and coordinates contractors, including calling them when needed.

Next step from our call: {next_step}. If a 20-minute walkthrough works, pick a time here: ${BOOKING_LINK}

${REPLY_TEMPLATE_SIGN_OFF}`,
    variables: Object.freeze(['firm', 'next_step'] as const),
  }),
  Object.freeze({
    id: 'T2', name: 'Sorry I missed you', purpose: 'missed_you',
    subject: 'Tried to reach you, {firm}',
    body: `I called {firm} today and missed you. I work on Callie, a 24/7 maintenance agent for property managers: it handles tenant requests and coordinates contractors, including calling them when needed.

Would a 15-minute call this week make sense? Reply with a time, or tell me who handles maintenance coordination at {firm} and I will reach out to them instead.

${REPLY_TEMPLATE_SIGN_OFF}`,
    variables: Object.freeze(['firm'] as const),
  }),
  Object.freeze({
    id: 'T3', name: 'Check back later', purpose: 'check_back_later',
    subject: 'Checking back around {callback_date}, {firm}',
    body: `Thanks for taking my call. You mentioned the timing is not right yet, so I will check back around {callback_date}.

If anything changes before then, this is the one line on what Callie does: a 24/7 maintenance agent for property managers that handles tenant requests and coordinates contractors, including calling them when needed. If you would rather just see it, book a 20-minute walkthrough here: ${BOOKING_LINK}

${REPLY_TEMPLATE_SIGN_OFF}`,
    variables: Object.freeze(['firm', 'callback_date'] as const),
  }),
  Object.freeze({
    id: 'T4', name: 'Short value note', purpose: 'short_value_note',
    subject: 'One question about maintenance calls at {firm}',
    body: `Quick question: when a tenant reports a leak at 9 pm, who at {firm} takes that call and finds the plumber?

That handoff is what Callie does. It is a 24/7 maintenance agent for property managers: it handles tenant requests and coordinates contractors, including calling them when needed.

If that is a real cost for {firm} in {city}, I would like 15 minutes to show you how it works. Reply with a time.

${REPLY_TEMPLATE_SIGN_OFF}`,
    variables: Object.freeze(['firm', 'city'] as const),
  }),
  Object.freeze({
    id: 'T5', name: 'Last note, door open', purpose: 'last_note',
    subject: 'Closing the loop, {firm}',
    body: `I have reached out a few times and do not want to crowd your inbox. I will stop here.

If after-hours tenant requests and contractor coordination become a priority at {firm}, reply to this email and I will pick it up. Callie is a 24/7 maintenance agent for property managers that handles both.

${REPLY_TEMPLATE_SIGN_OFF}`,
    variables: Object.freeze(['firm'] as const),
  }),
]);
/**
 * The sha256 of each seeded revision one, pinned on 18 September 2026. Migration 0030 seeds from the text
 * above rather than from a copy inside the migration, so these pins are what keeps the migration immutable:
 * any edit to the text above fails the seed check instead of silently changing what a fresh workspace gets.
 * Changing the text David approved is a new migration, not an edit to these lines.
 */
export const REPLY_TEMPLATE_SEED_HASHES: Readonly<Record<ReplyTemplateId, string>> = Object.freeze({
  T1: '3822659c1373e7fd81cfc7f0ce1ecb9ccf2c73e062b86f04b01cf5352a56c5cf',
  T2: '5059a5d4f9e78f96416c599556aa8e94385f10258834628a2e08889f61b22ffa',
  T3: 'db729d696fd49924b833fc40785a0dbea0f16a0aef734939f5d8ea914edf88d3',
  T4: 'b8a9cc58953dc080597abcd1df86bb8272d9c90a222e755bb9a6c347fbf33856',
  T5: '73f745e240544434fa253bd031c0e186de6e4824e7fc3cd753a0039e8e6c3368',
});
/** The sha256 of each seeded revision one, for a test or a migration check that never retypes the text. */
export const seededReplyTemplateHash = (id: ReplyTemplateId): string => {
  const seed = REPLY_TEMPLATE_SEEDS.find(entry => entry.id === id);
  if (!seed) throw new Error('reply_template_seed_unknown');
  return replyTemplateContentHash({ id: seed.id, revision: 1, subject: seed.subject, body: seed.body });
};
/** The seeded revision-one templates, parsed by the contract, so a seed that broke a body rule never ships. */
/** The instant migration 0030 records as `created_at` / `updated_at` for the five seeded drafts and the settings row.
 * A constant, not the wall clock: a migration must produce the same rows on every machine and every day, and every
 * later write (a fixed test instant or a real edit) must satisfy `updated_at >= created_at`. The wall clock here made
 * the packaged release gate fail after 13:00 UTC on 18 Sep 2026. */
export const REPLY_TEMPLATE_SEED_AT = '2026-09-18T00:00:00.000Z';

export function seededReplyTemplates(seededAt: string): ReplyTemplate[] {
  return REPLY_TEMPLATE_SEEDS.map(seed => {
    if (seededReplyTemplateHash(seed.id) !== REPLY_TEMPLATE_SEED_HASHES[seed.id]) throw new Error('reply_template_seed_text_changed');
    return replyTemplateSchema.parse({ ...seed, variables: [...seed.variables], revision: 1,
      approval: { state: 'draft', approvedRevision: null, approvedAt: null, contentHash: null }, updatedAt: seededAt });
  });
}
