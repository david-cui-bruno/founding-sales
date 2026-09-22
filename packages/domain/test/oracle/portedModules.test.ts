import { describe, expect, it } from 'vitest';

// The old modules, imported by relative path from the trees this lane does not own.
// They are pure: zod and Intl, no AWS SDK, no Electron, no filesystem.
import {
  normalizeEmail as oldNormalizeEmail,
  normalizePhone as oldNormalizePhone,
} from '../../../../src/main/domain/source/contactNormalization.ts';
import { classifyReply as oldClassifyReply } from '../../../../src/main/outreach/replyClassification.ts';
import {
  localInstant as oldLocalInstant,
  localParts as oldLocalParts,
  zoneOffsetMinutes as oldZoneOffsetMinutes,
} from '../../../../cloud/lambdas/delegated-worker/src/v1/localClock.ts';
import { evaluateDial as oldEvaluateDial } from '../../../../cloud/lambdas/delegated-worker/src/v1/callWindow.ts';
import {
  replyTemplateTextIssues as oldTemplateTextIssues,
  REPLY_TEMPLATE_SIGN_OFF as OLD_SIGN_OFF,
} from '../../../../src/shared/contracts/replyTemplateContract.ts';
import {
  TERRITORY_CLEARANCE_STATEMENTS as OLD_STATEMENTS,
  TERRITORY_FEDERAL_CITATIONS as OLD_FEDERAL_CITATIONS,
  TERRITORY_STATE_RULES as OLD_STATE_RULES,
  US_STATE_CODES as OLD_US_STATE_CODES,
  US_STATE_NAMES as OLD_US_STATE_NAMES,
} from '../../../../src/shared/contracts/territoryClearanceContract.ts';

import {
  FEDERAL_CITATIONS,
  POSTURE_STATEMENTS,
  STATE_POSTURE_RULES,
  US_STATE_CODES,
  US_STATE_NAMES,
  canonicalizeEmail,
  canonicalizePhone,
  classifyReply,
  evaluateCallingWindow,
  localInstant,
  localParts,
  templateTextIssues,
  zoneOffsetMinutes,
} from '../../src/index.ts';

/**
 * The oracle run.
 *
 * Every ported module is checked against the module it was ported from, on the same
 * inputs, in the same process. This is the strongest form of "run the old tests as an
 * oracle" available: rather than re-asserting the old expectations by hand, the old
 * code answers and the new code has to agree.
 *
 * This file is temporary by construction. It is the only thing in the greenfield tree
 * that reaches into `src/` and `cloud/`, it is excluded from the greenfield typecheck
 * (those trees are written against the old, looser tsconfig), and it is deleted with
 * the old trees. See docs/decisions/g0-oracle-imports.md.
 */

function* generatedPhones(): Generator<string> {
  // Shapes the old normalizer accepts, shapes it refuses, and the boundaries between.
  const bodies = ['4015550123', '2125550100', '5550123', '14015550123', '401555012345'];
  const decorations = [
    (value: string) => value,
    (value: string) => `(${value.slice(0, 3)}) ${value.slice(3, 6)}-${value.slice(6)}`,
    (value: string) => `${value.slice(0, 3)}.${value.slice(3, 6)}.${value.slice(6)}`,
    (value: string) => `  ${value}  `,
    (value: string) => `+1${value}`,
    (value: string) => `+${value}`,
    (value: string) => `+44${value}`,
  ];
  for (const body of bodies) for (const decorate of decorations) yield decorate(body);
  yield '';
  yield '   ';
  yield 'call me';
  yield '+1 (401) 555-0123 ext 4';
}

const GENERATED_EMAILS = [
  'someone@example.test',
  'Someone.Else@Example.TEST',
  '  padded@example.test  ',
  'a..b@example.test',
  '.leading@example.test',
  'trailing.@example.test',
  'no-at-sign',
  'a@b',
  `${'x'.repeat(250)}@example.test`,
  'plus+tag@example.test',
  "o'brien@example.test",
];

describe('oracle: contact normalization', () => {
  it('agrees with the old phone normalizer on every generated shape, refusals included', () => {
    for (const input of generatedPhones()) {
      let expected: string | null = null;
      try {
        expected = oldNormalizePhone(input);
      } catch {
        expected = null;
      }
      const actual = canonicalizePhone(input);
      if (expected === null) {
        expect(actual.ok, `old refused ${JSON.stringify(input)}, new accepted it`).toBe(false);
      } else {
        expect(actual.ok && actual.handle.value, JSON.stringify(input)).toBe(expected);
      }
    }
  });

  it('agrees with the old email normalizer, refusals included', () => {
    for (const input of GENERATED_EMAILS) {
      let expected: string | null = null;
      try {
        expected = oldNormalizeEmail(input);
      } catch {
        expected = null;
      }
      const actual = canonicalizeEmail(input);
      if (expected === null) {
        expect(actual.ok, `old refused ${JSON.stringify(input)}, new accepted it`).toBe(false);
      } else {
        expect(actual.ok && actual.handle.value, JSON.stringify(input)).toBe(expected);
      }
    }
  });
});

describe('oracle: local clock', () => {
  const zones = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'Pacific/Honolulu'];
  const instants = [
    '2026-01-15T12:00:00.000Z',
    '2026-03-08T06:30:00.000Z',
    '2026-03-08T07:30:00.000Z',
    '2026-07-04T16:30:00.000Z',
    '2026-11-01T05:30:00.000Z',
    '2026-11-01T06:30:00.000Z',
    '2026-12-31T23:59:59.000Z',
  ];

  it('reads the same wall clock as the old module in every zone', () => {
    for (const zone of zones) {
      for (const instant of instants) {
        expect(localParts(instant, zone), `${zone} ${instant}`).toEqual(oldLocalParts(instant, zone));
        expect(zoneOffsetMinutes(Date.parse(instant), zone), `${zone} ${instant}`).toBe(
          oldZoneOffsetMinutes(Date.parse(instant), zone),
        );
      }
    }
  });

  it('resolves the same instant as the old module for every ordinary wall-clock time', () => {
    for (const zone of zones) {
      for (const date of ['2026-01-15', '2026-06-15', '2026-09-19']) {
        for (const hour of [0, 8, 12, 17, 23]) {
          expect(localInstant(date, { hour, minute: 30 }, zone), `${zone} ${date} ${String(hour)}`).toBe(
            oldLocalInstant(date, { hour, minute: 30 }, zone),
          );
        }
      }
    }
  });

  it('resolves a daylight-saving fold identically and a gap deliberately differently', () => {
    // Fold: both modules choose the first of the two readings.
    expect(localInstant('2026-11-01', { hour: 1, minute: 30 }, 'America/New_York')).toBe(
      oldLocalInstant('2026-11-01', { hour: 1, minute: 30 }, 'America/New_York'),
    );

    // Gap: the old module settled on 01:30 EST, an instant *before* the wall clock it
    // was asked for. This is the one deliberate behaviour change of the port, recorded
    // in docs/decisions/g0-dst-gap-resolution.md: the new module resolves forward, so
    // work is never scheduled earlier than the time it named.
    const old = oldLocalInstant('2026-03-08', { hour: 2, minute: 30 }, 'America/New_York');
    const ported = localInstant('2026-03-08', { hour: 2, minute: 30 }, 'America/New_York');
    expect(old).toBe('2026-03-08T06:30:00.000Z');
    expect(ported).toBe('2026-03-08T07:30:00.000Z');
    expect(Date.parse(ported)).toBeGreaterThan(Date.parse(old));
  });
});

describe('oracle: calling window', () => {
  it('reaches the same allow-or-hold decision as the old evaluateDial', () => {
    const zone = 'America/New_York';
    for (let hourOffset = 0; hourOffset < 24 * 8; hourOffset += 1) {
      const instant = new Date(Date.parse('2026-09-14T00:00:00.000Z') + hourOffset * 3_600_000).toISOString();
      for (const hours of [null, { startMinute: 9 * 60, endMinute: 17 * 60 }, { startMinute: 0, endMinute: 24 * 60 }]) {
        const before = oldEvaluateDial(instant, zone, hours);
        const after = evaluateCallingWindow(instant, zone, hours);
        expect(after.allowed, `${instant} ${JSON.stringify(hours)}`).toBe(before.dialAllowed);
        expect(after.localTime, instant).toBe(before.localTime);
        expect(after.openNow, instant).toBe(before.openNow);
      }
    }
  });

  it('refuses an unknown zone exactly where the old module did', () => {
    const before = oldEvaluateDial('2026-09-16T14:00:00Z', null);
    const after = evaluateCallingWindow('2026-09-16T14:00:00Z', null);
    expect(before.dialAllowed).toBe(false);
    expect(before.holdCode).toBe('zone_unknown');
    expect(after.allowed).toBe(false);
    expect(after.allowed === false && after.refusal).toBe('zone_unknown');
  });
});

describe('oracle: template text rules', () => {
  // The old module's footer requirement is its pinned sign-off; the port takes the
  // sign-off as configuration. Feeding the old sign-off in makes the two comparable.
  // Neither side carries a postal address: the old module never had one in its
  // requirement, and since G20 the port does not either.
  const rules = {
    footer: { signOff: OLD_SIGN_OFF },
    allowedVariables: ['firm', 'city', 'callback_date', 'next_step', 'my_name', 'my_phone', 'booking_link'],
  };

  const cases: readonly { subject: string; body: string; issue: string; oldIssue: string }[] = [
    { subject: '', body: 'x', issue: 'template_subject_empty', oldIssue: 'template_subject_empty' },
    { subject: 'a\nb', body: 'x', issue: 'template_subject_not_one_line', oldIssue: 'template_subject_not_one_line' },
    { subject: 'see https://example.test', body: 'x', issue: 'template_subject_url', oldIssue: 'template_subject_url' },
    { subject: 'a', body: 'a\r\nb', issue: 'template_body_not_plain_text', oldIssue: 'template_body_not_plain_text' },
    { subject: 'a', body: '<b>hi</b>', issue: 'template_body_markup', oldIssue: 'template_body_markup' },
    { subject: 'a', body: `${'word '.repeat(120)}`, issue: 'template_body_too_long', oldIssue: 'template_body_too_long' },
    {
      subject: 'a',
      body: 'https://a.test https://b.test',
      issue: 'template_body_multiple_urls',
      oldIssue: 'template_body_multiple_urls',
    },
    {
      subject: 'a',
      body: 'We guarantee results.',
      issue: 'template_pricing_or_guarantee_language',
      oldIssue: 'template_pricing_or_guarantee_language',
    },
    { subject: 'a {surprise}', body: 'x', issue: 'template_unknown_variable', oldIssue: 'template_unknown_variable' },
  ];

  it('fires the same rule as the old module for every shared rule', () => {
    for (const testCase of cases) {
      const before = oldTemplateTextIssues({ subject: testCase.subject, body: testCase.body });
      const after = templateTextIssues({ subject: testCase.subject, body: testCase.body }, rules);
      expect(before, `old missed ${testCase.oldIssue}`).toContain(testCase.oldIssue);
      expect(after, `port missed ${testCase.issue}`).toContain(testCase.issue);
    }
  });

  it('keeps the same footer requirement, under the renamed issue', () => {
    const before = oldTemplateTextIssues({ subject: 'a', body: 'no sign-off here' });
    const after = templateTextIssues({ subject: 'a', body: 'no sign-off here' }, rules);
    expect(before).toContain('template_sign_off_missing');
    expect(after).toContain('template_footer_missing');
  });
});

describe('oracle: state posture reference texts', () => {
  it('carries every confirmed statement over byte for byte', () => {
    expect(POSTURE_STATEMENTS.businessToBusiness).toBe(OLD_STATEMENTS.businessToBusiness);
    expect(POSTURE_STATEMENTS.registrationStatusChecked).toBe(OLD_STATEMENTS.registrationStatusChecked);
    expect(POSTURE_STATEMENTS.stateDncSubscriptionChecked).toBe(OLD_STATEMENTS.stateDncSubscriptionChecked);
    expect(POSTURE_STATEMENTS.consentRuleConfirmed).toBe(OLD_STATEMENTS.consentRuleConfirmed);
  });

  it('carries every federal citation over byte for byte', () => {
    expect(FEDERAL_CITATIONS).toEqual(OLD_FEDERAL_CITATIONS);
  });

  it('carries every per-state summary and citation over byte for byte', () => {
    for (const state of ['RI', 'MA', 'TX'] as const) {
      const before = OLD_STATE_RULES[state];
      const after = STATE_POSTURE_RULES[state];
      expect(after.name, state).toBe(before.name);
      expect(after.summary, state).toBe(before.summary);
      expect(after.citation, state).toEqual(before.citation);
      expect(after.furtherCitations, state).toEqual(before.furtherCitations);
    }
  });

  it('carries the state code and name tables over unchanged', () => {
    expect([...US_STATE_CODES]).toEqual([...OLD_US_STATE_CODES]);
    expect(US_STATE_NAMES).toEqual(OLD_US_STATE_NAMES);
  });
});

describe('oracle: reply classification', () => {
  const bodies = [
    'Please stop emailing me.',
    'Unsubscribe me.',
    'My colleague asked me to unsubscribe from a different newsletter.',
    'I am out of the office until Monday.',
    'Automatic reply: away until the 30th.',
    'Delivery has failed to these recipients.',
    'Not interested, thanks.',
    'What does this cost, and can we talk Tuesday?',
    'Are you available Thursday?',
    'Sounds good.',
    'Please stop emailing me.\nOn Tue someone wrote:\n> please unsubscribe',
    'Thanks for the note, but please stop contacting me.',
  ];

  /** How the old five-way vocabulary maps onto revision 3's classes. */
  const EXPECTED_CLASS: Readonly<Record<string, string>> = {
    opt_out: 'opt_out',
    out_of_office: 'automated',
    delivery_failure: 'bounce',
    // Everything the old module called a human-shaped reply is `uncertain` under
    // revision 3, because only deterministic proof or a person may assert `human`.
    rejection: 'uncertain',
    substantive: 'uncertain',
    scheduling: 'uncertain',
    mixed: 'uncertain',
    ambiguous: 'uncertain',
  };

  /**
   * One deliberate widening, recorded rather than hidden. The old delivery-failure
   * pattern is `delivery (?:failed|failure)`, which does not match "Delivery has
   * failed to these recipients" — the wording Gmail's own bounce actually uses, so
   * the old module called it ambiguous. The port recognises it as a bounce, which is
   * what it is; `uncertain` would have held the firm for a daemon's report.
   */
  const DELIBERATE_WIDENINGS: Readonly<Record<string, { oldKind: string; newClass: string }>> = {
    'Delivery has failed to these recipients.': { oldKind: 'ambiguous', newClass: 'bounce' },
  };

  it('reaches the class the old kind maps to, for every body', () => {
    for (const text of bodies) {
      const before = oldClassifyReply({ id: 'message-1', bodyParts: [{ text }] } as never);
      const after = classifyReply({ id: 'message-1', headers: {}, bodyParts: [{ text }] });
      const widened = DELIBERATE_WIDENINGS[text];
      if (widened !== undefined) {
        expect(before.kind, text).toBe(widened.oldKind);
        expect(after.class, text).toBe(widened.newClass);
        continue;
      }
      const expected = EXPECTED_CLASS[before.kind];
      expect(expected, `the old kind ${before.kind} has no mapping`).toBeDefined();
      expect(after.class, `${JSON.stringify(text)} (old kind ${before.kind})`).toBe(expected);
    }
  });

  it('still agrees with the old module on the wording the old pattern did match', () => {
    for (const text of ['Delivery failed for one recipient.', 'This message is undeliverable.']) {
      expect(oldClassifyReply({ id: 'm', bodyParts: [{ text }] } as never).kind, text).toBe('delivery_failure');
      expect(classifyReply({ id: 'm', headers: {}, bodyParts: [{ text }] }).class, text).toBe('bounce');
    }
  });

  it('refuses a truncated body as opt-out proof exactly as the old module did', () => {
    const message = { id: 'message-1', bodyParts: [{ text: 'Please stop emailing me.', truncated: true }] };
    expect(oldClassifyReply(message as never).kind).not.toBe('opt_out');
    expect(classifyReply({ id: 'message-1', headers: {}, bodyParts: message.bodyParts }).class).not.toBe('opt_out');
  });
});
