import { describe, expect, it } from 'vitest';
import { canonicalText, redactorFor } from '../../calls/trialExport.ts';

/**
 * Slice S3T-E, TE design reset R3: redaction on the canonical text (NFKC, format and
 * default-ignorable characters removed, whitespace collapsed), with names canonical on both
 * sides. The reviewer's three cases (TEF finding 1) and a combined one. Fictional names.
 */
const redact = redactorFor({ people: ['Dana Example', 'Riley Smith'], firm: 'Example Tools' });

describe('redaction on the canonical text', () => {
  it('fullwidth digits are a phone number', () => {
    expect(redact('Call ４０１５５５０１４２.')).toBe('Call [phone].');
  });

  it('a bidi mark inside a phone number does not hide it', () => {
    expect(redact('Call 401-555‏-0142.')).toBe('Call [phone].');
    expect(redact('Call 401-555‮-0142‬.')).toBe('Call [phone].');
  });

  it('any dash, any space separator and any script of digits (review TERF, finding 2)', () => {
    expect(redact('Call 401\u2011555\u20110142.')).toBe('Call [phone].');
    expect(redact('Call 401\u2010555\u20100142.')).toBe('Call [phone].');
    expect(redact('Call \u0664\u0660\u0661\u0665\u0665\u0665\u0660\u0661\u0664\u0662.')).toBe('Call [phone].');
    expect(redact('Call 401\u2014555\u2003\u20130142 or 401/555/0142.')).toBe('Call [phone] or [phone].');
    // Combined: fullwidth digits, U+2011 and a bidi mark in one number.
    expect(redact('Call \uff14\uff10\uff11\u2011555\u200f\u20110142.')).toBe('Call [phone].');
  });

  it('a zero-width space or an LRM inside a known name does not hide it', () => {
    expect(redact('Talk to Ri​ley Sm‎ith.')).toBe('Talk to [name].');
    expect(redact('Ask for Da⁠na.')).toBe('Ask for [name].');
  });

  it('combined: a hidden name, a fullwidth number, a bidi-split address and a split firm name', () => {
    expect(redact('Ri​ley at ４０１ 555 0142, riley‎@example.test, Exam­ple Tools.')).toBe('[name] at [phone], [email], [firm].');
  });

  it('names are canonical on both sides, and the output is the canonical text', () => {
    const hidden = redactorFor({ people: ['Jor​dan Lee'], firm: null });
    expect(hidden('Jordan called.')).toBe('[name] called.');
    expect(canonicalText(' a​ b  c﻿ ')).toBe('a b c');
    expect(redact('We use  three\ttools.')).toBe('We use three tools.');
  });
});
