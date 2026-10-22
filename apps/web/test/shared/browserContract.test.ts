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

  it('admits only closed qualified research and Today V3 method pairs', () => {
    expect(browserApiPathAllowed('GET', '/today/actions/v3')).toBe(true);
    for (const path of ['/today/actions/open/v3', '/sourcing/research-firms/list', '/sourcing/research-firms/read', '/sourcing/research-firms/create']) {
      expect(browserApiPathAllowed('POST', path)).toBe(true);
      expect(browserApiPathAllowed('GET', path)).toBe(false);
    }
    for (const path of ['/sourcing/research-firms/delete', '/sourcing/admit', '/sourcing/research-firms/create/extra']) expect(browserApiPathAllowed('POST', path)).toBe(false);
  });

  it('admits only current email campaign control and approval/revoke paths', () => {
    for (const action of ['control', 'approve', 'revoke']) {
      const path = `/outreach/email-campaigns/${action}`;
      expect(browserApiPathAllowed('POST', path)).toBe(true);
      expect(browserApiPathAllowed('GET', path)).toBe(false);
    }
    for (const action of ['send', 'enable', 'enroll', 'process', 'approve/extra']) expect(browserApiPathAllowed('POST', `/outreach/email-campaigns/${action}`)).toBe(false);
    expect(browserApiPathAllowed('POST', '/outreach/cohort/enable')).toBe(false);
    expect(browserApiPathAllowed('POST', '/outreach/authorization/save')).toBe(false);
  });

  it('never accepts credentials as presentation metadata', () => {
    expect(browserSessionSchema.safeParse({ status: 'signed_out', csrfToken: 'x'.repeat(43) }).success).toBe(true);
    expect(browserSessionSchema.safeParse({ status: 'signed_out', csrfToken: 'x'.repeat(43), accessToken: 'secret' }).success).toBe(false);
    expect(browserSessionSchema.safeParse({ status: 'signed_out', csrfToken: 'x'.repeat(43), deviceSecret: 'secret' }).success).toBe(false);
  });
});
