import { describe, expect, it } from 'vitest';

import { humanizeEnumLabel, titleCaseDisplayName } from './displayText';

describe('titleCaseDisplayName', () => {
  it('title-cases ordinary all-caps owner names from the registry', () => {
    expect(titleCaseDisplayName('FOX WILLIAM P ETAL')).toBe('Fox William P Etal');
  });

  it('keeps known short suffixes like TS in caps', () => {
    expect(titleCaseDisplayName('MOSKOW MICHAEL B TS')).toBe('Moskow Michael B TS');
  });

  it('keeps LLC caps in gnarly numbered company names', () => {
    expect(titleCaseDisplayName('1 LINITED LIABILITY COMPANY LLC')).toBe(
      '1 Linited Liability Company LLC',
    );
  });

  it('keeps LLP, II, and III in caps', () => {
    expect(titleCaseDisplayName('SMITH & JONES LLP')).toBe('Smith & Jones LLP');
    expect(titleCaseDisplayName('JOHN DOE II')).toBe('John Doe II');
    expect(titleCaseDisplayName('JOHN DOE III')).toBe('John Doe III');
  });

  it('keeps ampersands and single initials intact', () => {
    expect(titleCaseDisplayName('FOX & SONS PROPERTIES LLC')).toBe(
      'Fox & Sons Properties LLC',
    );
    expect(titleCaseDisplayName('DOE JANE M')).toBe('Doe Jane M');
  });

  it('preserves short all-caps tokens that look intentional, like AKG', () => {
    // ≤3-char all-caps tokens that are not known suffixes get title-cased
    // only when the rest of the name is shouting too; inside an otherwise
    // mixed-case name they stay as typed.
    expect(titleCaseDisplayName('AKG Holdings')).toBe('AKG Holdings');
  });

  it('leaves already mixed-case names untouched', () => {
    expect(titleCaseDisplayName('Kevin Shin')).toBe('Kevin Shin');
    expect(titleCaseDisplayName("O'Brien Property Group")).toBe(
      "O'Brien Property Group",
    );
  });

  it('handles empty and whitespace-only input', () => {
    expect(titleCaseDisplayName('')).toBe('');
    expect(titleCaseDisplayName('   ')).toBe('   ');
  });

  it('title-cases hyphenated shouting names per segment', () => {
    expect(titleCaseDisplayName('SMITH-JONES ANNA')).toBe('Smith-Jones Anna');
  });
});

describe('humanizeEnumLabel', () => {
  it('maps known enum values through the explicit dictionary', () => {
    expect(humanizeEnumLabel('non_discretionary_overdue')).toBe('Overdue');
    expect(humanizeEnumLabel('other_non_discretionary_due_today')).toBe(
      'Due today',
    );
    expect(humanizeEnumLabel('inbound_demo')).toBe('Inbound demo');
    expect(humanizeEnumLabel('frbo')).toBe('FRBO');
    expect(humanizeEnumLabel('rireig')).toBe('RIREIG');
    expect(humanizeEnumLabel('lost_nurture')).toBe('Lost · Nurture');
  });

  it('falls back to sentence-cased snake_case for unknown values', () => {
    expect(humanizeEnumLabel('some_new_reason_code')).toBe('Some new reason code');
    expect(humanizeEnumLabel('ready')).toBe('Ready');
    expect(humanizeEnumLabel('direct')).toBe('Direct');
  });

  it('passes through already human text unchanged', () => {
    expect(humanizeEnumLabel('Ready P1 within capacity')).toBe(
      'Ready P1 within capacity',
    );
  });

  it('handles empty input', () => {
    expect(humanizeEnumLabel('')).toBe('');
  });
});
