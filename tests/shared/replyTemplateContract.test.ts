import { describe, expect, it } from 'vitest';
import {
  REPLY_TEMPLATE_HOLD_REASONS, REPLY_TEMPLATE_IDS, REPLY_TEMPLATE_MAX_WORDS, REPLY_TEMPLATE_SIGN_OFF, REPLY_TEMPLATE_SUBJECT,
  REPLY_TEMPLATE_VARIABLES, editReplyTemplateSchema, renderReplyTemplate, replyTemplateCommandPayloadSchema, replyTemplateContentHash,
  replyTemplateDraftId, replyTemplateRequestSchema, replyTemplateSchema, replyTemplateSnapshotSchema, replyTemplateTextIssues,
  type ReplyTemplateApproval,
} from '../../src/shared/contracts/replyTemplateContract';
import { CALLIE_OUTREACH_PRODUCT_CAPABILITY, CALLIE_OUTREACH_PRODUCT_SENTENCE, CALLIE_PRODUCT_FACTS } from '../../src/shared/product/callieProductFacts';
import { REPLY_TEMPLATE_SEEDS, seededReplyTemplateHash, seededReplyTemplates } from '../../src/main/outreach/templates/replyTemplateSeeds';

const SEEDED_AT = '2026-09-18T12:00:00.000Z';
const seeds = () => seededReplyTemplates(SEEDED_AT);
const words = (count: number) => Array.from({ length: count }, (_, index) => `word${index}`).join(' ');

describe('reply template seeds', () => {
  it('seeds exactly the five templates David drafted, every one a draft at revision one', () => {
    const templates = seeds();
    expect(templates.map(template => template.id)).toEqual([...REPLY_TEMPLATE_IDS]);
    expect(templates.map(template => template.purpose)).toEqual(['after_conversation', 'missed_you', 'check_back_later', 'short_value_note', 'last_note']);
    expect(templates.map(template => template.revision)).toEqual([1, 1, 1, 1, 1]);
    expect(templates.map(template => template.approval)).toEqual(Array.from({ length: 5 },
      (): ReplyTemplateApproval => ({ state: 'draft', approvedRevision: null, approvedAt: null, contentHash: null })));
    expect(templates.map(template => template.subject)).toEqual([
      'Following up on our call, {firm}', 'Tried to reach you, {firm}', 'Checking back around {callback_date}, {firm}',
      'One question about maintenance calls at {firm}', 'Closing the loop, {firm}',
    ]);
  });

  it('states the one approved product sentence verbatim in every seeded body, and the full capability in the four one-sentence templates', () => {
    for (const template of seeds()) expect(template.body).toContain(CALLIE_OUTREACH_PRODUCT_SENTENCE);
    expect(seeds().filter(template => template.body.includes(CALLIE_OUTREACH_PRODUCT_CAPABILITY)).map(template => template.id))
      .toEqual(['T1', 'T2', 'T3', 'T4']);
    // T5 states the same capability across two sentences ("after-hours tenant requests and contractor coordination … handles both").
    expect(seeds().find(template => template.id === 'T5')!.body).toContain('after-hours tenant requests and contractor coordination');
    expect(CALLIE_PRODUCT_FACTS.sourceRef).toBe('docs/archive/superpowers/specs/2026-09-08-meeting-first-fss-design.md#1-the-product-in-one-minute');
  });

  it('keeps every seeded body under ninety words, plain text, at most one URL, and signed with the pinned sign-off', () => {
    for (const template of seeds()) {
      expect(replyTemplateTextIssues(template)).toEqual([]);
      expect(template.body.trim().split(/\s+/).length).toBeLessThanOrEqual(REPLY_TEMPLATE_MAX_WORDS);
      expect((template.body.match(/https?:\/\//g) ?? []).length).toBeLessThanOrEqual(1);
      expect(template.body.endsWith(REPLY_TEMPLATE_SIGN_OFF)).toBe(true);
    }
    expect(REPLY_TEMPLATE_SEEDS.filter(seed => seed.body.includes('https://')).map(seed => seed.id)).toEqual(['T1', 'T3']);
  });

  it('declares exactly the variables its text names, all from the allowed set', () => {
    expect(seeds().map(template => template.variables)).toEqual([['firm', 'next_step'], ['firm'], ['firm', 'callback_date'], ['firm', 'city'], ['firm']]);
    for (const template of seeds()) for (const variable of template.variables) expect(REPLY_TEMPLATE_VARIABLES).toContain(variable);
  });

  it('parses as a snapshot and hashes each seeded revision one', () => {
    const snapshot = replyTemplateSnapshotSchema.parse({ templates: seeds(), settings: { paused: false, revision: 1, updatedAt: SEEDED_AT } });
    expect(snapshot.templates).toHaveLength(5);
    for (const template of snapshot.templates) expect(seededReplyTemplateHash(template.id)).toBe(replyTemplateContentHash(template));
    expect(seededReplyTemplateHash('T1')).not.toBe(seededReplyTemplateHash('T2'));
  });
});

describe('reply template body rules', () => {
  const template = (overrides: Partial<{ subject: string; body: string; variables: string[]; revision: number; approval: unknown }> = {}) =>
    replyTemplateSchema.safeParse({ id: 'T4', name: 'Short value note', purpose: 'short_value_note', ...seeds()[3]!, ...overrides });
  const body = (text: string) => `${text}\n\n${REPLY_TEMPLATE_SIGN_OFF}`;

  it('refuses a body of ninety-one words', () => {
    const long = body(`Callie is ${CALLIE_OUTREACH_PRODUCT_SENTENCE}. ${words(74)}`);
    expect(long.trim().split(/\s+/).length).toBe(91);
    expect(replyTemplateTextIssues({ subject: 'Subject', body: long })).toEqual(['template_body_too_long']);
    expect(template({ body: long, variables: [] }).success).toBe(false);
  });

  it('refuses a second URL, markup, a carriage return and a missing sign-off', () => {
    const two = `Callie is ${CALLIE_OUTREACH_PRODUCT_SENTENCE}. See https://usecallie.com and https://example.test`;
    expect(replyTemplateTextIssues({ subject: 'Subject', body: body(two) })).toEqual(['template_body_multiple_urls']);
    expect(replyTemplateTextIssues({ subject: 'Subject', body: body(`Callie is ${CALLIE_OUTREACH_PRODUCT_SENTENCE}. <b>Bold</b>`) })).toEqual(['template_body_markup']);
    expect(replyTemplateTextIssues({ subject: 'Subject', body: body(`Callie is ${CALLIE_OUTREACH_PRODUCT_SENTENCE}.\r`) })).toEqual(['template_body_not_plain_text']);
    expect(replyTemplateTextIssues({ subject: 'Subject', body: `Callie is ${CALLIE_OUTREACH_PRODUCT_SENTENCE}.` })).toEqual(['template_sign_off_missing']);
  });

  it('refuses pricing and guarantee language, and a body that drops the approved product sentence', () => {
    for (const phrase of ['We guarantee a faster response', 'Our pricing starts at $99', 'A 20% discount applies', 'We will answer every call']) {
      expect(replyTemplateTextIssues({ subject: 'Subject', body: body(`Callie is ${CALLIE_OUTREACH_PRODUCT_SENTENCE}. ${phrase}`) }))
        .toEqual(['template_pricing_or_guarantee_language']);
    }
    // "cost" describes what the firm already pays and stays allowed; T4 uses it.
    expect(replyTemplateTextIssues({ subject: 'Subject', body: body(`Callie is ${CALLIE_OUTREACH_PRODUCT_SENTENCE}. That is a real cost.`) })).toEqual([]);
    expect(replyTemplateTextIssues({ subject: 'Subject', body: body('Callie answers the phone.') })).toEqual(['template_product_sentence_missing']);
  });

  it('refuses an unknown variable anywhere and a subject that carries a URL or a newline', () => {
    expect(replyTemplateTextIssues({ subject: 'Hello {owner_name}', body: body(`Callie is ${CALLIE_OUTREACH_PRODUCT_SENTENCE}.`) })).toEqual(['template_unknown_variable']);
    expect(replyTemplateTextIssues({ subject: 'Book at https://usecallie.com', body: body(`Callie is ${CALLIE_OUTREACH_PRODUCT_SENTENCE}.`) })).toEqual(['template_subject_url']);
    expect(replyTemplateTextIssues({ subject: 'Two\nlines', body: body(`Callie is ${CALLIE_OUTREACH_PRODUCT_SENTENCE}.`) })).toEqual(['template_subject_not_one_line']);
  });

  it('refuses a declared variable list that does not cover the text, and an approval that does not match its revision', () => {
    expect(template({ variables: ['firm'] }).success).toBe(false);
    const seed = seeds()[0]!;
    expect(replyTemplateSchema.safeParse({ ...seed, approval: { state: 'approved', approvedRevision: 1, approvedAt: SEEDED_AT, contentHash: seededReplyTemplateHash('T1') } }).success).toBe(true);
    expect(replyTemplateSchema.safeParse({ ...seed, approval: { state: 'approved', approvedRevision: 1, approvedAt: SEEDED_AT, contentHash: seededReplyTemplateHash('T2') } }).success).toBe(false);
    expect(replyTemplateSchema.safeParse({ ...seed, approval: { state: 'approved', approvedRevision: 2, approvedAt: SEEDED_AT, contentHash: seededReplyTemplateHash('T1') } }).success).toBe(false);
    expect(replyTemplateSchema.safeParse({ ...seed, approval: { state: 'revoked', approvedRevision: 1, approvedAt: SEEDED_AT, contentHash: seededReplyTemplateHash('T1') } }).success).toBe(false);
    expect(replyTemplateSchema.safeParse({ ...seed, approval: { state: 'revoked', approvedRevision: null, approvedAt: null, contentHash: null } }).success).toBe(true);
  });
});

describe('reply template rendering and commands', () => {
  it('fills only the named variables from supplied values and never invents one', () => {
    const t3 = seeds()[2]!;
    const held = renderReplyTemplate(t3, { firm: 'Lenox Property Group' });
    expect(held).toEqual({ hold: 'template_variable_missing', missing: ['callback_date'] });
    const filled = renderReplyTemplate(t3, { firm: 'Lenox Property Group', callback_date: '2026-10-05' });
    expect('rendered' in filled && filled.rendered.subject).toBe('Checking back around 2026-10-05, Lenox Property Group');
    expect('rendered' in filled && filled.rendered.body).toContain('check back around 2026-10-05.');
    expect('rendered' in filled && filled.rendered.body.includes('{')).toBe(false);
    // A value for a variable the template does not name changes nothing.
    const t5 = seeds()[4]!;
    const extra = renderReplyTemplate(t5, { firm: 'Lenox Property Group', city: 'Atlanta' });
    expect('rendered' in extra && extra.rendered.body).toBe(t5.body.replace(/\{firm\}/g, 'Lenox Property Group'));
    expect(REPLY_TEMPLATE_HOLD_REASONS).toEqual(['template_not_approved', 'mailbox_not_connected', 'sender_cap_reached', 'no_business_email', 'template_variable_missing']);
  });

  it('accepts exactly the three command payloads and the four renderer requests', () => {
    expect(REPLY_TEMPLATE_SUBJECT).toBe('reply-templates');
    const seed = REPLY_TEMPLATE_SEEDS[0]!;
    for (const payload of [{ kind: 'template-approve', templateId: 'T1', revision: 1, subject: seed.subject, body: seed.body, contentHash: seededReplyTemplateHash('T1') },
      { kind: 'template-revoke', templateId: 'T1', revision: 1 }, { kind: 'template-pause', paused: true }]) {
      expect(replyTemplateCommandPayloadSchema.parse(payload)).toEqual(payload);
    }
    // A hash that does not match the text it carries, and a body that breaks a rule, are both refused.
    expect(replyTemplateCommandPayloadSchema.safeParse({ kind: 'template-approve', templateId: 'T1', revision: 1, subject: seed.subject, body: seed.body, contentHash: seededReplyTemplateHash('T2') }).success).toBe(false);
    expect(replyTemplateCommandPayloadSchema.safeParse({ kind: 'template-approve', templateId: 'T1', revision: 2, subject: seed.subject, body: seed.body, contentHash: seededReplyTemplateHash('T1') }).success).toBe(false);
    expect(replyTemplateCommandPayloadSchema.safeParse({ kind: 'template-read' }).success).toBe(false);
    expect(replyTemplateCommandPayloadSchema.safeParse({ kind: 'template-approve', templateId: 'T1', revision: 1, contentHash: 'short' }).success).toBe(false);
    expect(replyTemplateCommandPayloadSchema.safeParse({ kind: 'template-send' }).success).toBe(false);
    expect(replyTemplateRequestSchema.parse({ kind: 'read' })).toEqual({ kind: 'read' });
    const commandId = '3f1a2b3c-4d5e-4f60-8a1b-2c3d4e5f6071';
    expect(replyTemplateRequestSchema.parse({ kind: 'approve', commandId, templateId: 'T2', expectedRevision: 1 }).kind).toBe('approve');
    expect(replyTemplateRequestSchema.safeParse({ kind: 'approve', commandId, templateId: 'T2', expectedRevision: 1, body: 'x' }).success).toBe(false);
    expect(editReplyTemplateSchema.safeParse({ templateId: 'T2', expectedRevision: 0, subject: 'a', body: 'b' }).success).toBe(false);
  });

  it('derives one draft id per firm, template and source call', () => {
    const base = { accountId: 'account-one', templateId: 'T2', sourceCommandId: 'command-one' };
    expect(replyTemplateDraftId(base)).toBe(replyTemplateDraftId({ ...base }));
    expect(replyTemplateDraftId(base)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(replyTemplateDraftId(base)).not.toBe(replyTemplateDraftId({ ...base, templateId: 'T4' }));
    expect(replyTemplateDraftId(base)).not.toBe(replyTemplateDraftId({ ...base, sourceCommandId: 'command-two' }));
  });
});
