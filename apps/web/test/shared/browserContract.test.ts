import { describe, expect, it } from 'vitest';
import { browserApiPathAllowed, browserSessionSchema } from '../../src/shared/browserContract.ts';

describe('browser boundary', () => {
  it('only admits the existing method/path combinations for the first slice', () => {
    expect(browserApiPathAllowed('GET', '/today')).toBe(true);
    expect(browserApiPathAllowed('POST', '/today/firm')).toBe(true);
    expect(browserApiPathAllowed('POST', '/crm/firm-page-v3')).toBe(true);
    expect(browserApiPathAllowed('POST', '/meetings/notes')).toBe(true);
    expect(browserApiPathAllowed('GET', '/today/firm')).toBe(false);
    expect(browserApiPathAllowed('POST', '/today')).toBe(false);
    expect(browserApiPathAllowed('POST', '/admin/sending/enable')).toBe(false);
    expect(browserApiPathAllowed('POST', '/crm/firms/add')).toBe(false);
    expect(browserApiPathAllowed('GET', 'https://other.example/today')).toBe(false);
    expect(browserApiPathAllowed('GET', '/today/../admin')).toBe(false);
  });

  it('never accepts credentials as presentation metadata', () => {
    expect(browserSessionSchema.safeParse({ status: 'signed_out', csrfToken: 'x'.repeat(43) }).success).toBe(true);
    expect(browserSessionSchema.safeParse({ status: 'signed_out', csrfToken: 'x'.repeat(43), accessToken: 'secret' }).success).toBe(false);
    expect(browserSessionSchema.safeParse({ status: 'signed_out', csrfToken: 'x'.repeat(43), deviceSecret: 'secret' }).success).toBe(false);
  });
});
