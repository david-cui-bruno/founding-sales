import { describe, expect, it } from 'vitest';
import { SENDING_STOP_LINE } from '@fss/contracts';
import * as pure from '../../src/rules/templateFooter.ts';
import * as server from '../../src/rules/templates.ts';

const signOff = 'Sam Example';
const configuration = { signOff, postalAddress: null, recordedAddresses: [] };

// Literal expected results protect the existing send/approval semantics, not a copy
// of their implementation. All examples are synthetic and no stored copy is changed.
describe('the browser-safe extraction preserves server footer composition and validation', () => {
  it('keeps existing server imports bound to the same pure rules and policies', () => {
    expect(server.composeSendBody).toBe(pure.composeSendBody);
    expect(server.sendBodyIssue).toBe(pure.sendBodyIssue);
    expect(server.sendFooterBlock).toBe(pure.sendFooterBlock);
    expect(server.APPROVAL_FOOTER_POLICY).toBe(pure.APPROVAL_FOOTER_POLICY);
    expect(server.SEND_FOOTER_POLICY).toBe(pure.SEND_FOOTER_POLICY);
    expect(server.COMPOSE_SEND_BODY_REFUSALS).toBe(pure.COMPOSE_SEND_BODY_REFUSALS);
    expect(server.SENT_BODY_MAX_LENGTH).toBe(4000);
  });

  it.each([
    ['Hello.', configuration, `Hello.\n\n${signOff}`, false, true],
    [`Hello.\n\n${signOff}`, configuration, `Hello.\n\n${signOff}`, true, false],
    [`Hello.\n\n${signOff}`, { ...configuration, signOff: `  ${signOff}\n ` }, `Hello.\n\n${signOff}`, true, false],
    [`Hello.\n\n${signOff}\n${SENDING_STOP_LINE}`, configuration, `Hello.\n\n${signOff}`, true, true],
  ])('preserves exact composed bytes for %s', (body, footer, expected, deduped, changed) => {
    expect(server.composeSendBody(body, footer)).toEqual({ composed: true, body: expected, deduped, changed });
    expect(server.templateTextIssues({ subject: 'A question', body }, { footer, allowedVariables: [] })).toEqual([]);
    expect(server.composeSendBody(expected, footer)).toEqual({
      composed: true, body: expected, deduped: true, changed: false,
    });
  });

  it.each([
    `Hello.\n\n${signOff}\n\nP.S. Call Tuesday.`,
    `Hello.\n${signOff}`,
    `Hello.\n\n${signOff}\nUnknown address`,
    `Hello.\n${SENDING_STOP_LINE}\nMore text.`,
  ])('still refuses ambiguous bytes without editing them: %s', body => {
    expect(server.composeSendBody(body, configuration)).toEqual({ composed: false, reason: 'footer_ambiguous' });
    expect(server.templateTextIssues({ subject: 'A question', body }, {
      footer: configuration, allowedVariables: [],
    })).toEqual(['template_footer_missing']);
  });

  it('preserves postal-address provenance and the stricter send-only switch', () => {
    expect(server.composeSendBody('Hello.', configuration, { postalAddressRequired: true })).toEqual({
      composed: false, reason: 'postal_address_required',
    });
    expect(server.composeSendBody(`Hello.\n\n${signOff}\nOld address`, {
      signOff, postalAddress: 'New address', recordedAddresses: ['Old address'],
    })).toEqual({ composed: true, body: `Hello.\n\n${signOff}\nNew address`, changed: true, deduped: true });
  });

  it('preserves final-body length and opt-out-link refusals', () => {
    expect(server.sendBodyIssue('x'.repeat(4000))).toBeNull();
    expect(server.sendBodyIssue('x'.repeat(4001))).toBe('body_too_long');
    expect(server.composeSendBody('x'.repeat(4000), configuration)).toMatchObject({
      composed: false, reason: 'composed_body_too_long',
    });
    expect(server.composeSendBody('Hello.', { signOff: 'https://mail.example.test/unsubscribe/1' })).toEqual({
      composed: false, reason: 'optout_link',
    });
  });
});
