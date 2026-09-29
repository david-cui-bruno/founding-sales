import { describe, expect, it } from 'vitest';
import { resolveStepDue, type SequenceStep } from '../../src/rules/cadence.ts';
import { evaluateCallingWindow, narrowCallingWindow } from '../../src/rules/callingWindow.ts';
import {
  applyModelSuggestion,
  authoredText,
  classifyReply,
  type ReplyMessage,
} from '../../src/rules/replyClassification.ts';
import {
  FEDERAL_CITATIONS,
  POSTURE_STATEMENTS,
  STATE_POSTURE_RULES,
  isMultiZoneState,
  postureReviewAt,
  resolveFirmZone,
  selectApplicablePosture,
  stateDefaultZone,
  type FirmZoneSource,
  type StatePostureRecord,
} from '../../src/rules/statePosture.ts';
import {
  CANONICALIZER_VERSION,
  MANUAL_SUPPRESSION_CORRECTION_MILLISECONDS,
  canonicalizeEmail,
  canonicalizeHandle,
  canonicalizePhone,
  canonicalizeRoutes,
  isSupportedCanonicalizerVersion,
  mayCorrectSuppression,
} from '../../src/rules/suppressionCanonicalization.ts';
import {
  SENDING_STOP_LINE,
  SENT_BODY_MAX_LENGTH,
  composeSendBody,
  decideTemplateApproval,
  hasOptOutLink,
  renderTemplate,
  sendBodyIssue,
  sendFooterBlock,
  templateContentHash,
  templateTextIssues,
  templateTextWarnings,
} from '../../src/rules/templates.ts';

const NEW_YORK = 'America/New_York';

// A fictional workspace sign-off. No repository file carries a real contact detail.
const FOOTER = {
  signOff: 'Best,\nA. Salesperson\nFounder, Example\nexample.test',
};

/** A fictional postal address, of the shape the `postal_address` setting holds. */
const ADDRESS = '1 Example Way, Suite 2\nProvidence, RI 02903';

describe('suppression canonicalisation', () => {
  it('makes one spelling of a United States number', () => {
    for (const input of ['(401) 555-0123', '401.555.0123', '4015550123', '1 401 555 0123', '+1 (401) 555-0123']) {
      const result = canonicalizePhone(input);
      expect(result.ok, input).toBe(true);
      if (result.ok) expect(result.handle.value, input).toBe('+14015550123');
    }
  });

  it('refuses rather than guesses', () => {
    expect(canonicalizePhone('+44 20 7946 0000 ext 3')).toEqual({
      ok: false,
      refusal: 'phone_not_canonical_international',
    });
    expect(canonicalizePhone('555012')).toEqual({ ok: false, refusal: 'phone_ambiguous' });
    expect(canonicalizePhone('call me')).toEqual({ ok: false, refusal: 'phone_invalid' });
    expect(canonicalizePhone('   ')).toEqual({ ok: false, refusal: 'empty' });
  });

  it('lower-cases and validates an address', () => {
    const result = canonicalizeEmail('  Someone.Else@Example.TEST ');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.handle).toEqual({
      channel: 'email',
      value: 'someone.else@example.test',
      canonicalizerVersion: CANONICALIZER_VERSION,
    });
    for (const bad of ['no-at-sign', 'a..b@example.test', '.a@example.test', 'a.@example.test', 'a@b']) {
      expect(canonicalizeEmail(bad), bad).toEqual({ ok: false, refusal: 'email_invalid' });
    }
  });

  it('chooses the channel by the @ sign, as the old module did', () => {
    expect(canonicalizeHandle('a@example.test').ok).toBe(true);
    const phone = canonicalizeHandle('4015550123');
    expect(phone.ok && phone.handle.channel).toBe('phone');
  });

  it('de-duplicates routes into a stable order and drops what it cannot read', () => {
    const routes = canonicalizeRoutes([
      { channel: 'email', value: 'B@Example.test' },
      { channel: 'phone', value: '(401) 555-0123' },
      { channel: 'email', value: 'b@example.test' },
      { channel: 'phone', value: 'nonsense' },
      { channel: 'fax', value: '4015550124' },
    ]);
    expect(routes.map(route => route.value)).toEqual(['+14015550123', 'b@example.test']);
  });

  it('records the canonicalizer version and refuses an unsupported one', () => {
    expect(isSupportedCanonicalizerVersion(CANONICALIZER_VERSION)).toBe(true);
    expect(isSupportedCanonicalizerVersion('some-future-rule.9')).toBe(false);
  });

  it('lets a salesperson correct only their own manual suppression, inside ten minutes', () => {
    const event = { source: 'salesperson_manual', actorUserId: 'user-1', recordedAt: '2026-09-19T12:00:00.000Z' };
    expect(mayCorrectSuppression({ event, actorUserId: 'user-1', now: '2026-09-19T12:09:59.000Z' })).toEqual({
      allowed: true,
    });
    expect(mayCorrectSuppression({ event, actorUserId: 'user-1', now: '2026-09-19T12:10:00.000Z' })).toEqual({
      allowed: false,
      refusal: 'window_expired',
    });
    expect(mayCorrectSuppression({ event, actorUserId: 'user-2', now: '2026-09-19T12:01:00.000Z' })).toEqual({
      allowed: false,
      refusal: 'not_your_event',
    });
    // Appendix G 30: a prospect opt-out cannot use the salesperson correction path.
    expect(
      mayCorrectSuppression({
        event: { ...event, source: 'prospect_opt_out' },
        actorUserId: 'user-1',
        now: '2026-09-19T12:01:00.000Z',
      }),
    ).toEqual({ allowed: false, refusal: 'not_salesperson_originated' });
    expect(MANUAL_SUPPRESSION_CORRECTION_MILLISECONDS).toBe(600_000);
  });
});

describe('deterministic reply classification', () => {
  const message = (text: string, overrides: Partial<ReplyMessage> = {}): ReplyMessage => ({
    id: 'message-1',
    headers: {},
    bodyParts: [{ text }],
    ...overrides,
  });

  it('keeps a quoted earlier message out of the authored text', () => {
    const authored = authoredText('Please stop emailing me.\nOn Tue someone wrote:\n> anything at all');
    expect(authored).toBe('Please stop emailing me.');
  });

  it('suppresses immediately on explicit opt-out language', () => {
    const result = classifyReply(message('Please stop emailing me.'));
    expect(result.class).toBe('opt_out');
    expect(result.requiresConfirmation).toBe(false);
  });

  it('holds ambiguous opt-out wording for confirmation instead of suppressing', () => {
    // Appendix G 35.
    const result = classifyReply(message('I might want to stop hearing about this at some point, who knows.'));
    expect(result.class).toBe('uncertain');
    expect(result.requiresConfirmation).toBe(true);
  });

  it('never treats a truncated body as proof of an opt-out', () => {
    const result = classifyReply({
      id: 'm',
      headers: {},
      bodyParts: [{ text: 'Please stop emailing me.', truncated: true }],
    });
    expect(result.class).toBe('uncertain');
  });

  it('recognises an opt-out quoted inside a later sentence as not an instruction', () => {
    const result = classifyReply(message('My colleague asked me to unsubscribe from a different newsletter.'));
    expect(result.class).toBe('uncertain');
  });

  it('classifies delivery status notifications as bounces', () => {
    expect(classifyReply(message('', { headers: { contentType: 'multipart/report; report-type=delivery-status' } })).class).toBe('bounce');
    expect(classifyReply(message('Delivery has failed to these recipients.')).class).toBe('bounce');
  });

  it('classifies RFC headers, vacation replies and ticket acknowledgements as automated', () => {
    expect(classifyReply(message('hello', { headers: { autoSubmitted: 'auto-replied' } })).class).toBe('automated');
    expect(classifyReply(message('hello', { headers: { autoSubmitted: 'no' } })).class).toBe('uncertain');
    expect(classifyReply(message('hello', { headers: { listId: '<news.example.test>' } })).class).toBe('automated');
    expect(classifyReply(message('I am out of the office until Monday.')).class).toBe('automated');
    expect(classifyReply(message('Your request has been received, ticket #4412.')).class).toBe('automated');
  });

  it('does not retain the body of an out-of-office, only the rule that fired', () => {
    const result = classifyReply(message('Automatic reply: I am at a conference in Lisbon until the 30th.'));
    expect(result.signals).toEqual([{ rule: 'vacation_pattern', evidence: 'matched' }]);
  });

  it('defaults to uncertain and suggests a disposition without asserting one', () => {
    const result = classifyReply(message('What does this cost, and can we talk Tuesday?'));
    expect(result.class).toBe('uncertain');
    expect(result.suggestedDisposition).toBe('interested');
    expect(result.requiresConfirmation).toBe(true);
  });

  it('returns human only on a salesperson confirmation', () => {
    const result = classifyReply(message('anything'), {
      confirmedByUser: { userId: 'user-1', disposition: 'interested' },
    });
    expect(result.class).toBe('human');
    expect(result.requiresConfirmation).toBe(false);
  });

  it('lets a confident model label a message without changing its class', () => {
    // Appendix G 34: the LLM labels a human reply automated with high confidence and
    // the gate prevents release; malformed output becomes uncertain.
    const deterministic = classifyReply(message('Can you send more detail?'));
    const labelled = applyModelSuggestion(deterministic, { class: 'automated', confidence: 0.99 });
    expect(labelled.class).toBe('uncertain');
    expect(labelled.requiresConfirmation).toBe(true);

    const malformed = applyModelSuggestion(deterministic, { class: 'nonsense' });
    expect(malformed.class).toBe('uncertain');

    // A deterministic opt-out is never weakened by a model suggestion.
    const optOut = classifyReply(message('Please unsubscribe me.'));
    expect(applyModelSuggestion(optOut, { class: 'automated', confidence: 1 })).toEqual(optOut);
  });
});

describe('state posture', () => {
  it('keeps the confirmed statements and citations verbatim', () => {
    expect(POSTURE_STATEMENTS.businessToBusiness).toContain('business-to-business calls placed from my Mac');
    expect(FEDERAL_CITATIONS).toHaveLength(3);
    for (const citation of FEDERAL_CITATIONS) expect(citation.url.startsWith('https://')).toBe(true);
    expect(STATE_POSTURE_RULES.RI.citation.quote).toContain('"Telephone solicitation" means the engagement');
    expect(STATE_POSTURE_RULES.MA.citation.quote).toContain('an individual who is a resident of the commonwealth');
    expect(STATE_POSTURE_RULES.TX.citation.quote).toContain('A seller may not make a telephone solicitation');
    for (const rule of Object.values(STATE_POSTURE_RULES)) {
      for (const citation of [rule.citation, ...rule.furtherCitations]) {
        expect(citation.url.startsWith('https://'), citation.title).toBe(true);
        expect(citation.quote.length, citation.title).toBeGreaterThan(20);
      }
    }
  });

  it('offers a state default only for a single-zone state', () => {
    expect(stateDefaultZone('RI')).toBe('America/New_York');
    expect(stateDefaultZone('ma')).toBe('America/New_York');
    expect(isMultiZoneState('TX')).toBe(true);
    // Texas was a single zone in the old build's map; revision 3 refuses the shortcut.
    expect(stateDefaultZone('TX')).toBeNull();
    expect(stateDefaultZone('ZZ')).toBeNull();
  });

  it('resolves a firm zone from the firm, not from its state, when it can', () => {
    expect(resolveFirmZone({ recordedZone: 'America/Chicago', state: 'RI' })).toEqual({
      kind: 'resolved',
      zone: 'America/Chicago',
      source: 'recorded',
      confidence: 'high',
      ruleVersion: 'firm-zone.1',
    });

    const postal: FirmZoneSource = {
      name: 'postal',
      resolve: location => (location.postalCode === '79901' ? 'America/Denver' : null),
    };
    expect(resolveFirmZone({ state: 'TX', postalCode: '79901' }, [postal])).toMatchObject({
      kind: 'resolved',
      zone: 'America/Denver',
      source: 'postal',
    });
  });

  it('blocks calling rather than guessing when the zone cannot be established', () => {
    expect(resolveFirmZone({ state: 'TX' })).toMatchObject({ kind: 'unresolved', reason: 'state_spans_zones' });
    expect(resolveFirmZone({})).toMatchObject({ kind: 'unresolved', reason: 'no_location' });
    expect(resolveFirmZone({ state: 'ZZ' })).toMatchObject({ kind: 'unresolved', reason: 'state_unknown' });
    expect(resolveFirmZone({ state: 'RI' })).toMatchObject({
      kind: 'resolved',
      zone: 'America/New_York',
      source: 'state_default',
      confidence: 'medium',
    });
  });

  it('allows exactly one applicable posture and fails closed on zero or two', () => {
    // Appendix G 25.
    const base: StatePostureRecord = {
      state: 'RI',
      revision: 1,
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      effectiveTo: null,
      reviewAt: '2027-01-01T00:00:00.000Z',
      revokedAt: null,
    };
    const now = '2026-09-19T12:00:00.000Z';
    expect(selectApplicablePosture([], 'RI', now)).toEqual({ kind: 'refused', reason: 'posture_missing' });
    expect(selectApplicablePosture([base], 'RI', now)).toEqual({ kind: 'applies', posture: base });
    expect(selectApplicablePosture([base, { ...base, revision: 2 }], 'RI', now)).toEqual({
      kind: 'refused',
      reason: 'posture_overlapping',
    });
    // No yearly expiry since wave 2 (S4.2): a stored review date that has passed is read
    // and ignored, so an old posture row still applies.
    const pastReview = { ...base, reviewAt: '2026-09-01T00:00:00.000Z' };
    expect(selectApplicablePosture([pastReview], 'RI', now)).toEqual({ kind: 'applies', posture: pastReview });
    expect(selectApplicablePosture([{ ...base, revokedAt: now }], 'RI', now)).toEqual({
      kind: 'refused',
      reason: 'posture_missing',
    });
  });

  it('stores a review date one calendar year after confirmation, for the schema 18 CHECK', () => {
    expect(postureReviewAt('2026-09-19T12:00:00.000Z')).toBe('2027-09-19T12:00:00.000Z');
  });
});

describe('the calling window', () => {
  it('lets configuration narrow the floor and never widen it', () => {
    expect(narrowCallingWindow(null)).toEqual({ startMinute: 480, endMinute: 1200 });
    expect(narrowCallingWindow({ startMinute: 9 * 60, endMinute: 17 * 60 })).toEqual({
      startMinute: 540,
      endMinute: 1020,
    });
    // A window that would widen the floor is clamped back to it.
    expect(narrowCallingWindow({ startMinute: 0, endMinute: 24 * 60 })).toEqual({ startMinute: 480, endMinute: 1200 });
    // A window that leaves nothing is the floor itself, not an empty window.
    expect(narrowCallingWindow({ startMinute: 19 * 60, endMinute: 9 * 60 })).toEqual({
      startMinute: 480,
      endMinute: 1200,
    });
  });

  it('refuses a firm with no established zone rather than placing it on a clock', () => {
    expect(evaluateCallingWindow('2026-09-16T14:00:00Z', null)).toMatchObject({
      allowed: false,
      refusal: 'zone_unknown',
      localTime: null,
    });
  });

  it('allows a weekday inside the window and refuses outside it', () => {
    // Wednesday 10:00 local.
    expect(evaluateCallingWindow('2026-09-16T14:00:00Z', NEW_YORK)).toMatchObject({
      allowed: true,
      localTime: '10:00',
      openNow: true,
    });
    // Wednesday 07:00 local.
    expect(evaluateCallingWindow('2026-09-16T11:00:00Z', NEW_YORK)).toMatchObject({
      allowed: false,
      refusal: 'outside_calling_window',
      openNow: false,
    });
    // Saturday midday.
    expect(evaluateCallingWindow('2026-09-19T16:00:00Z', NEW_YORK)).toMatchObject({
      allowed: false,
      refusal: 'outside_calling_window',
    });
  });
});

describe('templates', () => {
  const rules = { footer: FOOTER, allowedVariables: ['firm', 'city'] };
  const body = `Hi {firm}, a short note about resident maintenance requests in {city}.\n\n${sendFooterBlock(FOOTER)}`;
  /** The pre-0023 ending: the block, and the stop line under it. */
  const legacyBlock = `${FOOTER.signOff}\n${SENDING_STOP_LINE}`;

  it('hashes the exact text that may be sent, and nothing else', () => {
    const one = templateContentHash({ templateId: 'T1', version: 3, subject: 'A note', body });
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(templateContentHash({ templateId: 'T1', version: 3, subject: 'A note', body })).toBe(one);
    // A new version of identical words hashes differently: an approval cannot drift.
    expect(templateContentHash({ templateId: 'T1', version: 4, subject: 'A note', body })).not.toBe(one);
    expect(templateContentHash({ templateId: 'T2', version: 3, subject: 'A note', body })).not.toBe(one);
  });

  it('is the sign-off, and nothing after it (David, 29 September 2026)', () => {
    const footer = sendFooterBlock(FOOTER);
    expect(footer).toBe(FOOTER.signOff);
    expect(footer).not.toContain(SENDING_STOP_LINE);
  });

  it('approves a body in today’s shape and in the pre-0023 one, neither carrying an address', () => {
    const withoutAddress = `Hi {firm}, a short note about {city}.\n\n${FOOTER.signOff}`;
    expect(templateTextIssues({ subject: 'A note', body: withoutAddress }, rules)).not.toContain(
      'template_footer_missing',
    );
    expect(
      decideTemplateApproval({ templateId: 'T1', version: 1, subject: 'A short note', body: withoutAddress }, rules),
    ).toMatchObject({ approved: true });
    const legacyShape = `Hi {firm}, a short note about {city}.\n\n${legacyBlock}`;
    expect(templateTextIssues({ subject: 'A note', body: legacyShape }, rules)).toEqual([]);
  });

  it('refuses a visible opt-out link and approves the bare word (migration 0023)', () => {
    const refusals = (subject: string, text: string): string[] => templateTextIssues({ subject, body: text }, rules);
    expect(refusals('A note', `Stop at https://mail.example.test/unsubscribe/1\n\n${FOOTER.signOff}`)).toContain(
      'template_optout_link',
    );
    expect(refusals('A note', `Click here to opt out: https://x.example.test\n\n${FOOTER.signOff}`)).toContain(
      'template_optout_link',
    );
    expect(refusals('Opt out at www.x.example.test', body)).toContain('template_optout_link');
    // The sentence the old CHECK made unwritable, which is the whole point of the change.
    expect(refusals('A note', `Just reply unsubscribe and I'll stop.\n\n${FOOTER.signOff}`)).toEqual([]);
    expect(hasOptOutLink("just reply unsubscribe and I'll stop")).toBe(false);
  });

  it('names every rule a body breaks, not only the first', () => {
    const text = {
      subject: 'Read https://example.test now',
      body: `We guarantee a 50% discount. {surprise}\n${legacyBlock}\nAnd a postscript.`,
    };
    expect(templateTextIssues(text, rules).sort()).toEqual(['template_footer_missing', 'template_unknown_variable']);
    expect(templateTextWarnings(text).sort()).toEqual(['template_pricing_or_guarantee_language', 'template_subject_url']);
  });

  it('keeps refusing what a send or the law depends on', () => {
    const refusals = (subject: string, text: string): string[] => templateTextIssues({ subject, body: text }, rules);
    // A footerless body is approvable since the footer is composed at send; a body that
    // carries the stop line somewhere that is not a final block is not, because composing
    // it would leave two.
    expect(refusals('A note', 'No stop line.')).toEqual([]);
    expect(refusals('A note', `${SENDING_STOP_LINE}\n\nAnd then some more words.`)).toContain(
      'template_footer_missing',
    );
    expect(refusals('A note', `<p>Hello</p>\n\n${sendFooterBlock(FOOTER)}`)).toContain('template_body_markup');
    expect(refusals('A note', `Hello\u0007.\n\n${sendFooterBlock(FOOTER)}`)).toContain('template_body_not_plain_text');
    expect(refusals('Two\nlines', body)).toContain('template_subject_not_one_line');
    expect(refusals('   ', body)).toContain('template_subject_empty');
    expect(refusals('S'.repeat(161), body)).toContain('template_subject_too_long');
    expect(refusals('Hi {nobody}', body)).toContain('template_unknown_variable');
  });

  it('approves a body past the copy limits, and warns about each one', () => {
    const long = `${'Word '.repeat(90)}See https://one.example.test and https://two.example.test for a 20% price cut.\n\n${sendFooterBlock(FOOTER)}`;
    const decision = decideTemplateApproval(
      { templateId: 'T1', version: 1, subject: 'Look https://example.test', body: long },
      rules,
    );
    expect(decision).toMatchObject({ approved: true });
    expect([...decision.warnings].sort()).toEqual([
      'template_body_multiple_urls',
      'template_body_too_long',
      'template_pricing_or_guarantee_language',
      'template_subject_url',
    ]);
    expect(decideTemplateApproval({ templateId: 'T1', version: 1, subject: 'A short note', body }, rules)).toMatchObject({
      approved: true,
      warnings: [],
    });
  });

  it('approves a body that satisfies every rule and refuses one that does not', () => {
    const approved = decideTemplateApproval({ templateId: 'T1', version: 1, subject: 'A short note', body }, rules);
    expect(approved.approved).toBe(true);
    const refused = decideTemplateApproval(
      { templateId: 'T1', version: 1, subject: 'A short note', body: `${SENDING_STOP_LINE} And more after it.` },
      rules,
    );
    expect(refused).toMatchObject({ approved: false, reason: 'template_unapproved' });
  });

  it('holds on a missing variable rather than rendering an empty string', () => {
    expect(renderTemplate({ subject: 'Hi {firm}', body }, { firm: 'Acme', city: 'Providence' })).toMatchObject({
      rendered: true,
      subject: 'Hi Acme',
    });
    expect(renderTemplate({ subject: 'Hi {firm}', body }, { firm: '   ', city: 'Providence' })).toEqual({
      rendered: false,
      reason: 'missing_variables',
      missing: ['firm'],
    });
  });
});

/**
 * The footer composed at send (lane W3-F, migration 0020; the P0 list of
 * `.context/reviews/GPT6-PR264-0019-20260926.md`).
 *
 * ## The vacuous-pass traps, named
 *
 * **A composition that is only tested on the shape it produces.** Every case here starts
 * from a body somebody could really have approved: the legacy shape desktop 1.0.11
 * requires, the footerless shape its successor writes, one with an address that has since
 * changed, and the `Hi David` body whose greeting ends with the sign-off's own words.
 *
 * **A switch tested in one position.** `postalAddressRequired` is exercised false *and*
 * true, because the whole point of it is that flipping it is a decision and not a design.
 */
describe('the footer is composed at send', () => {
  const FOOTERLESS = 'Hi Acme, a short note about resident maintenance requests.';
  const composed = `${FOOTERLESS}\n\n${FOOTER.signOff}`;
  /** A body approved before 29 September 2026: the block, and the stop line under it. */
  const legacy = `${composed}\n${SENDING_STOP_LINE}`;

  it('gives every body exactly one final block, in either shape and with or without an address', () => {
    for (const body of [legacy, composed, FOOTERLESS]) {
      for (const postalAddress of [null, ADDRESS]) {
        const decision = composeSendBody(body, { ...FOOTER, postalAddress });
        expect(decision.composed, body).toBe(true);
        if (!decision.composed) continue;
        expect(decision.body.endsWith(sendFooterBlock({ ...FOOTER, postalAddress }))).toBe(true);
        // Nothing appends the stop line any more, and a body that carried one loses it.
        expect(decision.body).not.toContain(SENDING_STOP_LINE);
        expect(sendBodyIssue(decision.body)).toBeNull();
        expect(decision.body.includes(ADDRESS)).toBe(postalAddress !== null);
        // The words are never touched, whatever the footer does.
        expect(decision.body.startsWith(FOOTERLESS)).toBe(true);
      }
    }
  });

  it('strips the pre-0023 stop line from a body approved before the decision', () => {
    expect(composeSendBody(legacy, { ...FOOTER, postalAddress: null })).toMatchObject({
      composed: true,
      body: composed,
      changed: true,
      deduped: true,
    });
  });

  it('rewrites nothing when the body already carries today’s block', () => {
    expect(composeSendBody(composed, { ...FOOTER, postalAddress: null })).toMatchObject({
      composed: true,
      body: composed,
      changed: false,
      deduped: true,
    });
  });

  it('is idempotent: composing a composed body rewrites nothing', () => {
    const once = composeSendBody(legacy, { ...FOOTER, postalAddress: ADDRESS });
    expect(once.composed).toBe(true);
    if (!once.composed) return;
    expect(once.changed).toBe(true);
    const twice = composeSendBody(once.body, { ...FOOTER, postalAddress: ADDRESS });
    expect(twice).toMatchObject({ composed: true, body: once.body, changed: false });
  });

  it('replaces an address it recorded, and refuses to touch one it never did', () => {
    const OLD = '9 Old Road\nProvidence, RI 02903';
    const stale = `${FOOTERLESS}\n\n${sendFooterBlock({ ...FOOTER, postalAddress: OLD })}`;

    // Provenance: the old address is a version of this workspace's own setting, so the
    // block it wrote is a block the composition can rebuild — and therefore replace.
    const moved = composeSendBody(stale, { ...FOOTER, postalAddress: ADDRESS, recordedAddresses: [OLD] });
    expect(moved).toMatchObject({ composed: true, deduped: true });
    if (!moved.composed) return;
    expect(moved.body).toBe(`${FOOTERLESS}\n\n${sendFooterBlock({ ...FOOTER, postalAddress: ADDRESS })}`);
    expect(moved.body).not.toContain('9 Old Road');
    expect(composeSendBody(stale, { ...FOOTER, postalAddress: null, recordedAddresses: [OLD] })).toMatchObject({
      composed: true,
      body: composed,
    });

    // Without that record the same bytes are just lines nobody can account for, so the
    // body is held rather than edited. This is the five-line legacy address case too.
    expect(composeSendBody(stale, { ...FOOTER, postalAddress: ADDRESS })).toEqual({
      composed: false,
      reason: 'footer_ambiguous',
    });
  });

  it('never lets a legacy stop line through, wherever it is (review of PR 311, P1-3)', () => {
    // The block at the end is recognised and removed; the earlier line is not a block
    // and is not the composer's to delete. Composing would send a stop line this
    // release exists to remove, so the answer is a hold.
    const malformed = `Hello\n${SENDING_STOP_LINE}\n\n${FOOTER.signOff}\n${SENDING_STOP_LINE}`;
    expect(composeSendBody(malformed, { ...FOOTER, postalAddress: null })).toEqual({
      composed: false,
      reason: 'footer_ambiguous',
    });
    // A sign-off that still carries the old sentence composes the same line back in, so
    // it is refused at composition and named at approval.
    const stale = { signOff: `Best,\n${SENDING_STOP_LINE}` };
    expect(composeSendBody(FOOTERLESS, stale)).toEqual({ composed: false, reason: 'footer_ambiguous' });
    expect(
      templateTextIssues({ subject: 'A note', body: FOOTERLESS }, { footer: stale, allowedVariables: [] }),
    ).toEqual(['template_sign_off_repeats_stop_line']);
  });

  it('refuses composed bytes that carry an opt-out link the approval never saw (P1-2)', () => {
    // `POST /templates` takes the sign-off as a field of its own, so these bytes exist
    // without any approved body ever having carried them.
    const linking = { signOff: 'Sam\nUnsubscribe: https://x.example/a' };
    expect(composeSendBody(FOOTERLESS, linking)).toEqual({ composed: false, reason: 'optout_link' });
    expect(
      templateTextIssues({ subject: 'A note', body: FOOTERLESS }, { footer: linking, allowedVariables: [] }),
    ).toEqual(['template_optout_link']);
    // And a rendered value can do it to the body: this is `{firm_website}` substituted.
    expect(composeSendBody('Our site: https://x.example/unsubscribe', FOOTER)).toEqual({
      composed: false,
      reason: 'optout_link',
    });
  });

  it('recognises the sign-off only as a complete separate block (P1-4)', () => {
    // A name in a sentence is not a sign-off: this body is footerless and composes.
    const prose = composeSendBody('Hello.\nSam discussed repairs.', { signOff: 'Sam', postalAddress: null });
    expect(prose).toMatchObject({ composed: true, body: 'Hello.\nSam discussed repairs.\n\nSam', deduped: false });
    // A real sign-off with a postscript under it is signed and not final: held.
    expect(composeSendBody('Hello.\n\nSam\n\nP.S. call me', { signOff: 'Sam', postalAddress: null })).toEqual({
      composed: false,
      reason: 'footer_ambiguous',
    });
    // And a sign-off on the line straight under the words, with no blank line, is not a
    // block anything here may claim to recognise.
    expect(composeSendBody(`Hello.\nSam\n${SENDING_STOP_LINE}`, { signOff: 'Sam' })).toEqual({
      composed: false,
      reason: 'footer_ambiguous',
    });
  });

  it('holds a body whose trailing lines it cannot account for, rather than deleting them', () => {
    // The reviewer's case: `Please call Tuesday.` is not an address, and a rule that
    // guessed by counting lines would send the email without it.
    const prose = `Hello.\n\nSam\nPlease call Tuesday.\n${SENDING_STOP_LINE}`;
    // The stop line is what marks these bytes as a footer somebody once composed; the
    // block underneath it is not one this workspace's records can rebuild.
    expect(composeSendBody(prose, { signOff: 'Sam', postalAddress: ADDRESS })).toEqual({
      composed: false,
      reason: 'footer_ambiguous',
    });
    expect(
      templateTextIssues({ subject: 'A note', body: prose }, { footer: { signOff: 'Sam' }, allowedVariables: [] }),
    ).toEqual(['template_footer_missing']);
  });

  it('never strips the sign-off a second time: `Hi David` keeps its name (review of PR 264)', () => {
    const rules = { signOff: 'David' };
    const body = `Hello there.\n\nHi David\n${SENDING_STOP_LINE}`;
    // The characters of a block are there and the block is not: `David` does not start
    // its line. Nothing is removed and nothing is composed — the body is held, which is
    // the only answer that can neither lose a word nor send two stop lines.
    expect(composeSendBody(body, { ...rules, postalAddress: ADDRESS })).toEqual({
      composed: false,
      reason: 'footer_ambiguous',
    });
    // And the block on its own line *is* recognised, which is what bounds the removal.
    const proper = `Hello there.\n\nDavid\n${SENDING_STOP_LINE}`;
    expect(composeSendBody(proper, { ...rules, postalAddress: null })).toMatchObject({
      composed: true,
      deduped: true,
      body: 'Hello there.\n\nDavid',
    });
  });

  it('refuses rather than duplicating a stop line the body carries elsewhere', () => {
    expect(composeSendBody(`${SENDING_STOP_LINE}\n\nA postscript.`, FOOTER)).toEqual({
      composed: false,
      reason: 'footer_ambiguous',
    });
  });

  it('refuses a composed body past the fence’s 4,000 characters, and names the length', () => {
    const footer = sendFooterBlock({ ...FOOTER, postalAddress: ADDRESS });
    const words = 'x'.repeat(SENT_BODY_MAX_LENGTH - footer.length);
    const decision = composeSendBody(words, { ...FOOTER, postalAddress: ADDRESS });
    expect(decision).toMatchObject({ composed: false, reason: 'composed_body_too_long' });
    // One character shorter than the two newlines it costs, and it fits.
    const fits = composeSendBody('x'.repeat(SENT_BODY_MAX_LENGTH - footer.length - 2), {
      ...FOOTER,
      postalAddress: ADDRESS,
    });
    expect(fits.composed).toBe(true);
    if (fits.composed) expect(fits.body).toHaveLength(SENT_BODY_MAX_LENGTH);
  });

  it('sends on without an address by default, and refuses every send with the switch flipped', () => {
    const withoutAddress = composeSendBody(legacy, { ...FOOTER, postalAddress: null }, { postalAddressRequired: false });
    expect(withoutAddress).toMatchObject({ composed: true, body: composed });
    expect(composeSendBody(legacy, { ...FOOTER, postalAddress: null }, { postalAddressRequired: true })).toEqual({
      composed: false,
      reason: 'postal_address_required',
    });
    // The switch is about an *absent* address, never about a configured one.
    expect(
      composeSendBody(legacy, { ...FOOTER, postalAddress: ADDRESS }, { postalAddressRequired: true }),
    ).toMatchObject({ composed: true });
  });

  it('says what is wrong with bytes about to be frozen on a fence: the length, and only the length', () => {
    // Since 0023 there is no mandatory last line, so a function that is handed bytes and
    // no sign-off has exactly one honest question left. Whether the *footer* is right is
    // `composeSendBody`'s, which is given the workspace's records.
    expect(sendBodyIssue(legacy)).toBeNull();
    expect(sendBodyIssue(FOOTERLESS)).toBeNull();
    expect(sendBodyIssue('x'.repeat(SENT_BODY_MAX_LENGTH))).toBeNull();
    expect(sendBodyIssue(`${'x'.repeat(SENT_BODY_MAX_LENGTH)}!`)).toBe('body_too_long');
  });
});

describe('cadence', () => {
  const steps: readonly SequenceStep[] = [
    { id: 's0', ordinal: 0, channel: 'call_task', delay: { unit: 'elapsed', hours: 0 } },
    { id: 's1', ordinal: 1, channel: 'call_task', delay: { unit: 'elapsed', hours: 72 } },
    { id: 's2', ordinal: 2, channel: 'email', delay: { unit: 'elapsed', hours: 168 } },
    { id: 's3', ordinal: 3, channel: 'call_task', delay: { unit: 'elapsed', hours: 288 } },
  ];
  const startedAt = '2026-09-16T13:00:00.000Z';

  it('anchors every step on the enrollment start, not on the previous completion', () => {
    expect(steps.map(step => resolveStepDue(step, startedAt, NEW_YORK).dueAt)).toEqual([
      '2026-09-16T13:00:00.000Z',
      '2026-09-19T13:00:00.000Z',
      '2026-09-23T13:00:00.000Z',
      '2026-09-28T13:00:00.000Z',
    ]);
  });
});
