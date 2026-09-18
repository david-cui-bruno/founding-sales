import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  V1_DEFAULT_PHONE_REGION,
  normalizeEmail,
  normalizePhone,
} from '../../src/main/domain/source/contactNormalization';

describe('contact normalization', () => {
  it('documents the V1 US phone default and conservative full-lowercase email policy', () => {
    expect(normalizePhone('(401) 555-0100')).toBe('+14015550100');
    expect(normalizePhone('1 401 555 0100')).toBe('+14015550100');
    expect(normalizePhone('+1 (401) 555-0100')).toBe('+14015550100');
    expect(normalizePhone('+442071838750')).toBe('+442071838750');
    expect(() => normalizePhone('555-0100')).toThrow(z.ZodError);
    expect(() => normalizePhone('+01234567890')).toThrow(z.ZodError);
    expect(normalizePhone('+44 20 7183 8750')).toBe('+442071838750');
    expect(() => normalizePhone('+1 (401) CALL-ME')).toThrow(z.ZodError);

    expect(normalizeEmail('  KEVIN\uFF20EXAMPLE.COM ')).toBe('kevin@example.com');
    expect(() => normalizeEmail('kevin @example.com')).toThrow(z.ZodError);
    expect(() => normalizeEmail('kevin@example')).toThrow(z.ZodError);
    expect(() => normalizeEmail('.kevin@example.com')).toThrow(z.ZodError);
    expect(() => normalizeEmail('kevin.@example.com')).toThrow(z.ZodError);
  });

  it('keeps the only default region the V1 United States one', () => {
    expect(V1_DEFAULT_PHONE_REGION).toBe('US');
  });
});
