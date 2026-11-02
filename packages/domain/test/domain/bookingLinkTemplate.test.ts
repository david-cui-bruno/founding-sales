import { describe, expect, it } from 'vitest';
import { SENDING_STOP_LINE, TEMPLATE_VARIABLE_NAMES, hasOptOutLink } from '@fss/contracts';
import { firstNameOf, personFirstNameOf } from '../../sequences/variables.ts';
import { renderTemplate, templateTextIssues, templateTextWarnings } from '../../src/rules/templates.ts';

// `{booking_link}` is an ordinary single-brace snake_case template variable (migration 0157's setting fills it).
const rules = { footer: { signOff: 'Sam' }, allowedVariables: ['firm_name', 'booking_link'] };
const body = 'Hi {firm_name},\n\nCould we find twenty minutes?\n{booking_link}\n\nSam';
const url = 'https://cal.example.test/demo';

describe('the booking_link template variable', () => {
  it('is a named variable, so the approval form offers it', () => {
    expect(TEMPLATE_VARIABLE_NAMES).toContain('booking_link');
  });

  it('is accepted in a body when the template names it, and unknown when it does not', () => {
    expect(templateTextIssues({ subject: 'A question', body }, rules)).not.toContain('template_unknown_variable');
    expect(templateTextIssues({ subject: 'A question', body }, { ...rules, allowedVariables: ['firm_name'] })).toContain(
      'template_unknown_variable',
    );
  });

  it('adds only the one-link warning beside another link, and no refusal', () => {
    expect(templateTextWarnings({ subject: 'A question', body })).not.toContain('template_body_multiple_urls');
    // The placeholder is not a URL until it renders, so the warning counts the literal links only.
    const two = `${body}\nOr read https://example.test/about and https://example.test/more`;
    expect(templateTextWarnings({ subject: 'A question', body: two })).toContain('template_body_multiple_urls');
    expect(templateTextIssues({ subject: 'A question', body: two }, rules)).not.toContain('template_optout_link');
  });

  it('renders the URL, and holds the step when the setting leaves it absent', () => {
    const values = { firm_name: 'Example PM', booking_link: url };
    expect(renderTemplate({ subject: 'A question', body }, values)).toMatchObject({ rendered: true });
    expect(renderTemplate({ subject: 'A question', body }, { firm_name: 'Example PM' })).toEqual({
      rendered: false,
      reason: 'missing_variables',
      missing: ['booking_link'],
    });
  });

  it('keeps a URL on its own line clear of the opt-out link rule, even beside the stop sentence', () => {
    const sent = `Hi Example PM,\n\nCould we find twenty minutes?\n${url}\n\nSam\n${SENDING_STOP_LINE}`;
    expect(hasOptOutLink(sent)).toBe(false);
    // The rule is unchanged: the URL on the line beside opt-out wording is still refused.
    expect(hasOptOutLink(`Book at ${url}\nReply unsubscribe to stop.`)).toBe(true);
  });
});

// `{first_name}` (ADR0036): the campaign's first email greets the named decision-maker, and never a role mailbox.
describe('the first_name template variable', () => {
  it('is a named variable beside contact_first_name', () => {
    expect(TEMPLATE_VARIABLE_NAMES).toContain('first_name');
    expect(TEMPLATE_VARIABLE_NAMES).toContain('contact_first_name');
  });
  it('is the first name of a person, and absent for a role mailbox, a placeholder or a single letter', () => {
    expect(personFirstNameOf('Jordan Blake')).toBe('Jordan');
    for (const role of ['Office', 'office', 'Team', 'N/A', '?', 'J']) expect(personFirstNameOf(role)).toBeNull();
    // contact_first_name's own rule is unchanged: "Office" still renders there.
    expect(firstNameOf('Office')).toBe('Office');
  });
  it('holds the step when absent', () => {
    expect(renderTemplate({ subject: 'A question', body: 'Hi {first_name},\n\nSam' }, {})).toEqual({ rendered: false, reason: 'missing_variables', missing: ['first_name'] });
  });
});
