import { describe, expect, it } from 'vitest';
import { browserApiPathAllowed, browserSessionSchema } from '../../src/shared/browserContract.ts';

describe('browser boundary', () => {
  it('admits only explicit opening policy control and receipt, never activation or replacement', () => {
    for (const action of ['control', 'approve', 'revoke', 'receipt']) {
      const path = `/outreach/email-campaigns/opening/${action}`;
      expect(browserApiPathAllowed('POST', path)).toBe(true);
      for (const method of ['GET', 'PUT', 'DELETE']) expect(browserApiPathAllowed(method, path)).toBe(false);
      expect(browserApiPathAllowed('POST', `${path}/extra`)).toBe(false);
    }
    for (const action of ['send', 'enable', 'select', 'replace', 'delete', 'retry', 'generate'])
      expect(browserApiPathAllowed('POST', `/outreach/email-campaigns/opening/${action}`)).toBe(false);
  });
  it('admits only the four recording-only manual activity POST routes', () => {
    for (const action of ['list', 'read', 'save', 'receipt']) {
      const path = `/sourcing/candidates/prospects/activity/${action}`;
      expect(browserApiPathAllowed('POST', path)).toBe(true);
      for (const method of ['GET', 'PUT', 'DELETE']) expect(browserApiPathAllowed(method, path)).toBe(false);
      expect(browserApiPathAllowed('POST', `${path}/extra`)).toBe(false);
    }
    for (const action of ['call', 'callback', 'today', 'consent', 'suppress', 'send', 'fetch', 'enable']) expect(browserApiPathAllowed('POST', `/sourcing/candidates/prospects/activity/${action}`)).toBe(false);
  });
  it('admits existing suggestion reads and explicit guided request/receipt, never publication', () => {
    for (const path of ['/social/drafts', '/social/drafts/read', '/social/drafts/request', '/social/drafts/request/receipt']) {
      expect(browserApiPathAllowed('POST', path)).toBe(true);
      for (const method of ['GET', 'PUT', 'DELETE']) expect(browserApiPathAllowed(method, path)).toBe(false);
      expect(browserApiPathAllowed('POST', `${path}/extra`)).toBe(false);
    }
    for (const path of ['/social', '/social/posts/save', '/social/posts/approve', '/social/posts/cancel', '/social/weekly', '/social/weekly/save', '/social/accounts/connect', '/social/accounts/manual', '/social/manual-handoff/read', '/social/manual-handoff/confirm', '/social/delivery/queue', '/social/delivery/claim', '/social/delivery/begin', '/social/delivery/observe', '/social/assets']) {
      expect(browserApiPathAllowed('POST', path)).toBe(false);
    }
  });
  it('admits only raw manual prospect reads and feedback, not canonical or outreach actions', () => {
    for (const action of ['list', 'feedback']) {
      const path = `/sourcing/candidates/prospects/${action}`;
      expect(browserApiPathAllowed('POST', path)).toBe(true);
      for (const method of ['GET', 'PUT', 'DELETE']) expect(browserApiPathAllowed(method, path)).toBe(false);
      expect(browserApiPathAllowed('POST', `${path}/extra`)).toBe(false);
    }
    for (const action of ['admit', 'qualify', 'fetch', 'call', 'send', 'enable']) {
      expect(browserApiPathAllowed('POST', `/sourcing/candidates/prospects/${action}`)).toBe(false);
    }
  });
  it('admits ordinary inventory without unrelated sourcing mutations', () => {
    expect(browserApiPathAllowed('POST', '/sourcing/candidates/list')).toBe(true);
    for (const method of ['GET', 'PUT', 'DELETE']) expect(browserApiPathAllowed(method, '/sourcing/candidates/list')).toBe(false);
    for (const path of ['/sourcing/candidates/list/extra', '/sourcing/candidates/save', '/sourcing/candidates/review', '/sourcing/candidates/delete', '/sourcing/candidates/check', '/sourcing/experiments/activate']) {
      expect(browserApiPathAllowed('POST', path)).toBe(false);
    }
  });

  it('admits only explicit existing qualification read, request and reviewed admission paths', () => {
    for (const action of ['read', 'request', 'admit']) {
      const path = `/sourcing/qualification/${action}`;
      expect(browserApiPathAllowed('POST', path)).toBe(true);
      for (const method of ['GET', 'PUT', 'DELETE']) expect(browserApiPathAllowed(method, path)).toBe(false);
      expect(browserApiPathAllowed('POST', `${path}/extra`)).toBe(false);
    }
    for (const action of ['feedback', 'firm', 'enable', 'run', 'publish']) {
      expect(browserApiPathAllowed('POST', `/sourcing/qualification/${action}`)).toBe(false);
    }
    expect(browserApiPathAllowed('POST', '/sourcing/calling/admit')).toBe(false);
  });

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

  it('admits only automatic supply Today V4 reads without publication or activation commands', () => {
    expect(browserApiPathAllowed('GET', '/today/actions/v4')).toBe(true);
    expect(browserApiPathAllowed('POST', '/today/actions/open/v4')).toBe(true);
    expect(browserApiPathAllowed('POST', '/today/actions/v4')).toBe(false);
    expect(browserApiPathAllowed('GET', '/today/actions/open/v4')).toBe(false);
    for (const path of ['/today/actions/open/v4/extra', '/sourcing/automatic-research/create', '/sourcing/automatic-research/publish', '/sourcing/automatic-research/enable']) {
      expect(browserApiPathAllowed('POST', path)).toBe(false);
    }
  });

  it('admits reviewed reply preparation and existing meeting reads but never sending or booking', () => {
    for (const path of ['/replies', '/replies/card', '/replies/composer/context', '/replies/composer/preview', '/replies/composer/generate']) {
      expect(browserApiPathAllowed('POST', path)).toBe(true);
      expect(browserApiPathAllowed('GET', path)).toBe(false);
    }
    for (const path of ['/meetings/firm', '/meetings/brief']) {
      expect(browserApiPathAllowed('GET', path)).toBe(true);
      expect(browserApiPathAllowed('POST', path)).toBe(false);
    }
    for (const path of ['/replies/confirm', '/replies/settings/update', '/replies/composer/send', '/replies/composer/send-status', '/replies/composer/generate/extra', '/meetings/match', '/meetings/attendance']) {
      expect(browserApiPathAllowed('POST', path)).toBe(false);
    }
  });

  it('never accepts credentials as presentation metadata', () => {
    expect(browserSessionSchema.safeParse({ status: 'signed_out', csrfToken: 'x'.repeat(43) }).success).toBe(true);
    expect(browserSessionSchema.safeParse({ status: 'signed_out', csrfToken: 'x'.repeat(43), accessToken: 'secret' }).success).toBe(false);
    expect(browserSessionSchema.safeParse({ status: 'signed_out', csrfToken: 'x'.repeat(43), deviceSecret: 'secret' }).success).toBe(false);
  });
});
