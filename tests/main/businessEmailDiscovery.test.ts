import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BUSINESS_EMAIL_ROLE_LOCAL_PARTS, FREE_MAIL_DOMAINS, businessEmailCandidates, findBusinessEmail, onCompanyDomain } from '../../src/main/research/businessEmailDiscovery';
import { createCompanyPageProvider } from '../../src/main/research/companyPageProvider';
import { createFetchedReceiptPolicy } from '../../src/main/research/companySourcePolicy';
import { projectAccountEvidence } from '../../src/main/domain/accounts/accountEvidence';
import { accountClaimSchema } from '../../src/shared/contracts/accountContract';

const page = (text: string, sourceId = 'source-home') => ({ sourceId, text });
const find = (domain: string | null, texts: readonly string[], withheldEmails: readonly string[] = []) =>
  findBusinessEmail({ domain, pages: texts.map((text, index) => page(text, `source-${index}`)), withheldEmails });

describe('the business email a firm publishes on its own website', () => {
  it('takes an on-domain address from a mailto link and from plain page text alike', () => {
    const fromText = find('alpha-pm.example', ['Questions? Write to office@alpha-pm.example and we answer the same day.']);
    expect(fromText.finding).toEqual({ email: 'office@alpha-pm.example', sourceId: 'source-0', selection: 'role_mailbox',
      considered: ['office@alpha-pm.example'] });
    // The page provider feeds the mailto target through as one more line of the page's email text.
    const fromLink = find('alpha-pm.example', ['Email us\noffice@alpha-pm.example']);
    expect(fromLink.finding?.email).toBe('office@alpha-pm.example');
    expect(fromText.refused).toEqual({ free_mail: 0, off_domain: 0, withheld_contact: 0, unparsable: 0 });
  });

  it('accepts a subdomain of the firm’s own domain and refuses a domain that merely ends in it', () => {
    expect(onCompanyDomain('mail.alpha-pm.example', 'alpha-pm.example')).toBe(true);
    expect(onCompanyDomain('alpha-pm.example', 'alpha-pm.example')).toBe(true);
    expect(onCompanyDomain('notalpha-pm.example', 'alpha-pm.example')).toBe(false);
    const subdomain = find('alpha-pm.example', ['Write to info@mail.alpha-pm.example.']);
    expect(subdomain.finding?.email).toBe('info@mail.alpha-pm.example');
    const lookalike = find('alpha-pm.example', ['Write to info@notalpha-pm.example.']);
    expect(lookalike.finding).toBeNull();
    expect(lookalike.refused.off_domain).toBe(1);
  });

  it('refuses every free-mail address on the explicit list, even when the firm publishes it itself', () => {
    expect(FREE_MAIL_DOMAINS).toContain('gmail.com');
    expect(FREE_MAIL_DOMAINS).toContain('yahoo.com');
    expect(FREE_MAIL_DOMAINS).toContain('outlook.com');
    expect(FREE_MAIL_DOMAINS).toContain('icloud.com');
    expect(new Set(FREE_MAIL_DOMAINS).size).toBe(FREE_MAIL_DOMAINS.length);
    expect([...FREE_MAIL_DOMAINS]).toEqual([...FREE_MAIL_DOMAINS].sort());
    for (const domain of FREE_MAIL_DOMAINS) {
      const result = find('alpha-pm.example', [`Write to alphapm@${domain} for anything.`]);
      expect(result.finding).toBeNull();
      expect(result.refused.free_mail).toBe(1);
    }
    // A free-mail address is refused as free mail even when it *is* the firm's recorded domain.
    const owned = find('gmail.com', ['Write to info@gmail.com.']);
    expect(owned.finding).toBeNull();
    expect(owned.refused).toEqual({ free_mail: 1, off_domain: 0, withheld_contact: 0, unparsable: 0 });
  });

  it('refuses a third-party domain the firm merely links to, and records nothing when a firm publishes none', () => {
    const third = find('alpha-pm.example', ['Pay rent through billing@rentportal.example or press@newspaper.example.']);
    expect(third.finding).toBeNull();
    expect(third.refused.off_domain).toBe(2);
    const none = find('alpha-pm.example', ['We are a local property management company.\nOperating footprint:\tProvidence, RI']);
    expect(none.finding).toBeNull();
    expect(none.refused).toEqual({ free_mail: 0, off_domain: 0, withheld_contact: 0, unparsable: 0 });
    // No domain on the account record is an unknown, never a guessed address.
    const unknownDomain = find(null, ['Write to info@alpha-pm.example.']);
    expect(unknownDomain.finding).toBeNull();
    expect(unknownDomain.refused.unparsable).toBe(1);
  });

  it('keeps at most one address, preferring a role mailbox over a personal name in the published order', () => {
    expect(BUSINESS_EMAIL_ROLE_LOCAL_PARTS[0]).toBe('info');
    const both = find('alpha-pm.example', ['dana.reynolds@alpha-pm.example', 'office@alpha-pm.example\ninfo@alpha-pm.example']);
    expect(both.finding).toEqual({ email: 'info@alpha-pm.example', sourceId: 'source-1', selection: 'role_mailbox',
      considered: ['dana.reynolds@alpha-pm.example', 'office@alpha-pm.example', 'info@alpha-pm.example'] });
    const sole = find('alpha-pm.example', ['dana.reynolds@alpha-pm.example']);
    expect(sole.finding).toMatchObject({ email: 'dana.reynolds@alpha-pm.example', selection: 'sole_on_domain_address' });
    const several = find('alpha-pm.example', ['dana.reynolds@alpha-pm.example\nsam.ortiz@alpha-pm.example']);
    expect(several.finding).toMatchObject({ email: 'dana.reynolds@alpha-pm.example', selection: 'first_on_domain_address' });
  });

  it('refuses an address a page qualified as a tenant or emergency contact', () => {
    const withheld = find('alpha-pm.example', ['Tenant emergency: emergency@alpha-pm.example'], ['emergency@alpha-pm.example']);
    expect(withheld.finding).toBeNull();
    expect(withheld.refused.withheld_contact).toBe(1);
  });

  it('normalises case, strips a sentence-ending period, and never mints an address no page carries', () => {
    expect(find('alpha-pm.example', ['Contact Info@Alpha-PM.Example.']).finding?.email).toBe('info@alpha-pm.example');
    expect(businessEmailCandidates([page('info@alpha-pm.example info@alpha-pm.example')]).map(c => c.email)).toEqual(['info@alpha-pm.example']);
    expect(businessEmailCandidates([page('not an address: alpha-pm.example')])).toEqual([]);
    // The obvious guess is never made: nothing produces info@domain from the domain alone.
    expect(find('alpha-pm.example', ['Alpha Residential Management, Providence RI.']).finding).toBeNull();
  });
});

describe('the Places research path records the address as a cited claim', () => {
  const now = '2026-09-18T12:00:00.000Z';
  const limits = { maxCompanies: 2, maxPages: 1, maxBytes: 4000, maxCostMicros: 100 };
  const snapshot = () => projectAccountEvidence({ id: randomUUID(), name: 'Alpha Residential Management', domain: 'alpha-pm.example', version: 1 }, [], []);
  const provider = (body: string) => createCompanyPageProvider({ receipts: createFetchedReceiptPolicy(), clock: { now: () => now },
    permitted: () => true, resolve: async () => ['93.184.216.34'],
    http: async () => new Response(body, { headers: { 'content-type': 'text/html' } }) });

  it('writes one business_email claim citing the source whose excerpt and sha carry the address', async () => {
    const batch = await provider('<p>We manage 240 residential units.</p><p>Email <a href="mailto:office@alpha-pm.example?subject=Hello">our office</a>.</p>')
      .research(snapshot(), limits, new AbortController().signal);
    const claims = batch.claims.filter(claim => claim.key === 'business_email');
    expect(claims).toHaveLength(1);
    const [claim] = claims;
    expect(claim).toEqual({ key: 'business_email', kind: 'fact', value: 'office@alpha-pm.example', selection: 'role_mailbox',
      evidenceIds: [batch.sources[0]!.id] });
    expect(accountClaimSchema.parse(claim)).toEqual(claim);
    const source = batch.sources.find(item => item.id === claim!.evidenceIds[0])!;
    expect(source.permitted).toBe(true);
    expect(source.excerpt).toContain('mailto:office@alpha-pm.example');
    expect(source.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('records nothing for a firm that publishes only a free-mail or third-party address', async () => {
    const batch = await provider('<p>Write to alpha.pm@gmail.com or to billing@rentportal.example.</p>')
      .research(snapshot(), limits, new AbortController().signal);
    expect(batch.claims.some(claim => claim.key === 'business_email')).toBe(false);
  });
});
