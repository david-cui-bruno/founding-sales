import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseCsvSource } from '../../src/main/imports/csvParser';

const fixture = (name: string): string => readFileSync(
  join(process.cwd(), 'tests', 'fixtures', 'import', name), 'utf8',
);

describe('parseCsvSource', () => {
  it('parses quoted commas and preserves exact source row numbers', () => {
    expect(parseCsvSource('Name,Organization\n"Kevin Shin","Shin, LLC"\n')).toEqual({
      columns: ['Name', 'Organization'],
      rows: [{ rowNumber: 2, values: ['Kevin Shin', 'Shin, LLC'] }],
      errors: [],
    });
  });

  it('parses the valid fixture with one row per lead', () => {
    const parsed = parseCsvSource(fixture('leads-valid.csv'));
    expect(parsed.columns).toEqual(['Name', 'Phone', 'Email', 'Source', 'Doors', 'Organization']);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toEqual({
      rowNumber: 2,
      values: ['Kevin Shin', '+14015550101', 'kevin@example.com', 'frbo', '12', 'Shin Holdings LLC'],
    });
    expect(parsed.errors).toEqual([]);
  });

  it('strips a BOM and handles CRLF line endings with quoted commas', () => {
    const parsed = parseCsvSource(fixture('leads-duplicates.csv'));
    expect(parsed.columns).toEqual(['Name', 'Phone', 'Organization']);
    expect(parsed.rows).toEqual([
      { rowNumber: 2, values: ['Kevin Shin', '+14015550101', 'Shin, Holdings LLC'] },
      { rowNumber: 3, values: ['Nina Park', '+14015550199', 'Park & Co, Ltd'] },
    ]);
    expect(parsed.errors).toEqual([]);
  });

  it('skips whitespace-only lines greedily while keeping original row numbers', () => {
    const parsed = parseCsvSource('Name\nKevin Shin\n\n   \nMaya Ortiz\n');
    expect(parsed.rows).toEqual([
      { rowNumber: 2, values: ['Kevin Shin'] },
      { rowNumber: 5, values: ['Maya Ortiz'] },
    ]);
    expect(parsed.errors).toEqual([]);
  });

  it('pads ragged rows to the header width', () => {
    const parsed = parseCsvSource('Name,Organization\nKevin Shin\n');
    expect(parsed.rows).toEqual([{ rowNumber: 2, values: ['Kevin Shin', ''] }]);
  });

  it('rejects blank headers', () => {
    const parsed = parseCsvSource('Name,,Email\nKevin Shin,x,kevin@example.com\n');
    expect(parsed.errors).toContainEqual({
      rowNumber: 1, field: null, code: 'INVALID_HEADER',
      message: 'Headers must be present and non-blank.',
    });
  });

  it('rejects empty content as an invalid header', () => {
    const parsed = parseCsvSource(' ');
    expect(parsed.rows).toEqual([]);
    expect(parsed.errors.map((error) => error.code)).toContain('INVALID_HEADER');
  });

  it('rejects duplicate headers', () => {
    const parsed = parseCsvSource('Name,Name\nKevin Shin,Kevin Shin\n');
    expect(parsed.errors).toContainEqual({
      rowNumber: 1, field: null, code: 'DUPLICATE_HEADER',
      message: 'Headers must be unique.',
    });
  });

  it('parses tab-delimited spreadsheet pastes', () => {
    const parsed = parseCsvSource('Name\tOrganization\nKevin Shin\tShin Holdings LLC\n', 'spreadsheet_paste');
    expect(parsed.columns).toEqual(['Name', 'Organization']);
    expect(parsed.rows).toEqual([
      { rowNumber: 2, values: ['Kevin Shin', 'Shin Holdings LLC'] },
    ]);
  });

  it('returns bounded safe parse errors without stacks or filesystem paths', () => {
    const malformed = `Name\n${Array.from({ length: 40 }, () => '"unterminated').join('\n')}`;
    const parsed = parseCsvSource(malformed);
    const parseErrors = parsed.errors.filter((error) => error.code === 'PARSE_ERROR');
    expect(parseErrors.length).toBeGreaterThan(0);
    expect(parseErrors.length).toBeLessThanOrEqual(20);
    for (const error of parsed.errors) {
      expect(error.rowNumber).toBeGreaterThanOrEqual(1);
      expect(error.message.length).toBeLessThanOrEqual(200);
      expect(error.message).not.toMatch(/\n\s+at\s/);
      expect(error.message).not.toContain('/Users/');
      expect(error.message).not.toContain(process.cwd());
    }
  });
});
