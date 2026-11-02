import { describe, expect, it } from 'vitest';
import { LEGACY_SENDING_STOP_LINE, SENDING_STOP_LINE } from '@fss/contracts';
import * as pure from '../../src/rules/templateFooter.ts';
import * as server from '../../src/rules/templates.ts';

const signOff = 'Sam Example';
const address = '1 Main St, Providence, RI 02903';
const configuration = { signOff, postalAddress: address, recordedAddresses: [] };
const company = `Callie, AI maintenance coordination \u00B7 ${address}`;
const footer = `${signOff}\n${company}\n${SENDING_STOP_LINE}`;

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

  it('writes the footer as sign-off, company line and stop sentence, in that order', () => {
    expect(SENDING_STOP_LINE).toBe("If this isn't relevant, just reply and I won't email again.");
    expect(pure.sendFooterBlock(configuration)).toBe(
      'Sam Example\nCallie, AI maintenance coordination \u00B7 1 Main St, Providence, RI 02903\n' +
        "If this isn't relevant, just reply and I won't email again.",
    );
    expect(
      pure.composeSendBody('Hello.', {
        signOff: 'David Cui \u00B7 Brown University',
        postalAddress: '339 Thayer Street, Providence, RI 02906',
      }),
    ).toEqual({
      composed: true,
      changed: true,
      deduped: false,
      body:
        'Hello.\n\nDavid Cui \u00B7 Brown University\n' +
        'Callie, AI maintenance coordination \u00B7 339 Thayer Street, Providence, RI 02906\n' +
        "If this isn't relevant, just reply and I won't email again.",
    });
    // No address is only possible for an approval: the line is the company alone.
    expect(pure.sendFooterBlock({ signOff })).toBe(
      `Sam Example\nCallie, AI maintenance coordination\n${SENDING_STOP_LINE}`,
    );
  });

  it('requires an address for a send and never for an approval', () => {
    expect(server.SEND_FOOTER_POLICY.postalAddressRequired).toBe(true);
    expect(server.APPROVAL_FOOTER_POLICY.postalAddressRequired).toBe(false);
    expect(server.composeSendBody('Hello.', { signOff })).toEqual({ composed: false, reason: 'postal_address_required' });
    expect(server.composeSendBody('Hello.', { signOff, postalAddress: '  ' })).toEqual({
      composed: false,
      reason: 'postal_address_required',
    });
  });

  it.each([
    ['Hello.', configuration, `Hello.\n\n${footer}`, false, true],
    [`Hello.\n\n${footer}`, configuration, `Hello.\n\n${footer}`, true, false],
    [`Hello.\n\n${footer}`, { ...configuration, signOff: `  ${signOff}\n ` }, `Hello.\n\n${footer}`, true, false],
    // Every earlier shape is replaced, never doubled.
    [`Hello.\n\n${signOff}`, configuration, `Hello.\n\n${footer}`, true, true],
    [`Hello.\n\n${signOff}\n${address}`, configuration, `Hello.\n\n${footer}`, true, true],
    [`Hello.\n\n${signOff}\n${LEGACY_SENDING_STOP_LINE}`, configuration, `Hello.\n\n${footer}`, true, true],
    [`Hello.\n\n${signOff}\n${address}\n${LEGACY_SENDING_STOP_LINE}`, configuration, `Hello.\n\n${footer}`, true, true],
  ])('preserves exact composed bytes for %s', (body, config, expected, deduped, changed) => {
    expect(server.composeSendBody(body, config)).toEqual({ composed: true, body: expected, deduped, changed });
    expect(server.composeSendBody(expected, config)).toEqual({
      composed: true, body: expected, deduped: true, changed: false,
    });
  });

  it('approves the footerless, previous and legacy shapes without an address', () => {
    for (const body of ['Hello.', `Hello.\n\n${signOff}`, `Hello.\n\n${signOff}\n${LEGACY_SENDING_STOP_LINE}`]) {
      expect(server.templateTextIssues({ subject: 'A question', body }, { footer: { signOff }, allowedVariables: [] })).toEqual([]);
    }
  });

  it.each([
    `Hello.\n\n${footer}\n\nP.S. Call Tuesday.`,
    `Hello.\n\n${signOff}\n\nP.S. Call Tuesday.`,
    `Hello.\n${signOff}`,
    `Hello.\n\n${signOff}\nUnknown address`,
    `Hello.\n${LEGACY_SENDING_STOP_LINE}\nMore text.`,
    `Hello.\n${SENDING_STOP_LINE}\nMore text.`,
    `${SENDING_STOP_LINE}\n\n${footer}`,
    `${LEGACY_SENDING_STOP_LINE}\n\n${footer}`,
  ])('still refuses ambiguous bytes without editing them: %s', body => {
    expect(server.composeSendBody(body, configuration)).toEqual({ composed: false, reason: 'footer_ambiguous' });
    expect(server.templateTextIssues({ subject: 'A question', body }, {
      footer: { signOff }, allowedVariables: [],
    })).toEqual(['template_footer_missing']);
  });

  it('preserves postal-address provenance', () => {
    const recorded = { signOff, postalAddress: 'New address', recordedAddresses: ['Old address', address] };
    const expected = `Hello.\n\n${signOff}\nCallie, AI maintenance coordination \u00B7 New address\n${SENDING_STOP_LINE}`;
    // The block composed under an address the workspace has since replaced, and the one
    // before the company line existed, are both rebuilt from the records and replaced.
    for (const old of ['Old address', address]) {
      const previous = `Hello.\n\n${signOff}\nCallie, AI maintenance coordination \u00B7 ${old}\n${SENDING_STOP_LINE}`;
      expect(server.composeSendBody(previous, recorded)).toEqual({ composed: true, body: expected, changed: true, deduped: true });
      expect(server.composeSendBody(`Hello.\n\n${signOff}\n${old}`, recorded)).toEqual({
        composed: true, body: expected, changed: true, deduped: true,
      });
    }
    // An address nobody recorded is just lines nobody can account for.
    expect(server.composeSendBody(`Hello.\n\n${signOff}\nCallie, AI maintenance coordination \u00B7 Elsewhere\n${SENDING_STOP_LINE}`, recorded)).toEqual({
      composed: false, reason: 'footer_ambiguous',
    });
  });

  it('preserves final-body length and opt-out-link refusals, and the new wording trips neither', () => {
    expect(server.sendBodyIssue('x'.repeat(4000))).toBeNull();
    expect(server.sendBodyIssue('x'.repeat(4001))).toBe('body_too_long');
    expect(server.composeSendBody('x'.repeat(4000), configuration)).toMatchObject({
      composed: false, reason: 'composed_body_too_long',
    });
    expect(
      server.composeSendBody('Hello.', { signOff: 'https://mail.example.test/unsubscribe/1', postalAddress: address }),
    ).toEqual({ composed: false, reason: 'optout_link' });
    expect(server.hasOptOutLink(footer)).toBe(false);
    expect(server.hasOptOutLink(`Visit https://firm.example.test\n\n${footer}`)).toBe(false);
  });
});
