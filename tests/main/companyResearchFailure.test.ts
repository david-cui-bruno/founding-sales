import { describe, expect, it } from 'vitest';
import { CompanyResearchError, annotateCompanyResearchError, companyResearchDiagnostic, companyResearchReasons, companyResearchStages, type CompanyResearchReason, type CompanyResearchStage } from '../../src/main/research/companyResearchFailure';
import { CompanyFactExtractionError, companyFactExtractionReason } from '../../src/main/research/companyFactExtraction';
import { ProviderError } from '../../src/main/outreach/providers/providerValidation';

const secret = 'PRIVATE body https://secret.invalid/?key=secret stack';
describe('safe company research diagnostics', () => {
  it('never reads arbitrary thrown text, reason, status, body or stack fields', () => {
    const hostile = Object.fromEntries(['message', 'name', 'reason', 'httpStatus', 'status', 'body', 'url', 'key', 'stack', 'cause'].map(key => [key, secret]));
    const throwing = Object.create(null);
    for (const key of Object.keys(hostile)) Object.defineProperty(throwing, key, { get() { throw new Error(secret); } });
    const proxy = new Proxy({}, { get() { throw new Error(secret); }, getPrototypeOf() { throw new Error(secret); } });
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    for (const error of [secret, null, undefined, hostile, throwing, proxy, revoked.proxy]) {
      expect(companyResearchDiagnostic(error, 'page')).toEqual({ stage: 'page', reason: 'unknown' });
      expect(JSON.stringify(companyResearchDiagnostic(annotateCompanyResearchError(error, 'page'), 'page'))).not.toContain(secret);
    }
  });
  it('copies only literal allowed ProviderError codes and survives hostile getters', () => {
    const error = new ProviderError('provider_rejected');
    Object.assign(error, { message: secret, reason: secret, body: secret, status: 429, httpStatus: 429 });
    expect(companyResearchDiagnostic(error, 'model_request')).toEqual({ stage: 'model_request', reason: 'provider_rejected' });
    Object.defineProperty(error, 'code', { configurable: true, get() { throw new Error(secret); } });
    expect(companyResearchDiagnostic(error, 'admission')).toEqual({ stage: 'admission', reason: 'unknown' });
    Object.defineProperty(error, 'code', { value: secret });
    expect(companyResearchDiagnostic(error, 'snapshot')).toEqual({ stage: 'snapshot', reason: 'unknown' });
    expect(companyResearchDiagnostic({ code: 'provider_rejected' }, 'page').reason).toBe('unknown');
  });
  it('keeps trusted extraction subreason across mutable public fields and wrapping', () => {
    const error = new CompanyFactExtractionError('quote');
    for (const key of ['reason', 'code', 'message', 'stack']) Object.defineProperty(error, key, { get() { throw new Error(secret); } });
    expect(companyFactExtractionReason(error)).toBe('quote');
    const wrapped = annotateCompanyResearchError(error, 'model_request');
    expect(wrapped).toBe(error);
    Object.assign(wrapped, { stage: 'page_http', httpStatus: 500 });
    expect(companyResearchDiagnostic(wrapped, 'page')).toEqual({ stage: 'model_request', reason: 'quote' });
    expect(companyFactExtractionReason(Object.create(CompanyFactExtractionError.prototype))).toBeUndefined();
  });
  it('returns detached allowlisted data and bounds only privately recorded integer statuses', () => {
    for (const status of [NaN, Infinity, 99, 600, 429.1, '429']) {
      expect(companyResearchDiagnostic(new CompanyResearchError('page_http', 'provider_rejected', status as number), 'page')).toEqual({ stage: 'page_http', reason: 'provider_rejected' });
    }
    const error = new CompanyResearchError('page_response', 'page_response_rejected', 429);
    const result = companyResearchDiagnostic(error, 'page'); result.reason = 'unknown';
    expect(companyResearchDiagnostic(error, 'page')).toEqual({ stage: 'page_response', reason: 'page_response_rejected', httpStatus: 429 });
    expect(companyResearchDiagnostic(new CompanyResearchError(secret as CompanyResearchStage, secret as CompanyResearchReason), secret as CompanyResearchStage)).toEqual({ stage: 'page', reason: 'unknown' });
    expect(Object.isFrozen(companyResearchStages)).toBe(true);
    expect(Object.isFrozen(companyResearchReasons)).toBe(true);
  });
  it.each(['snapshot', 'page', 'admission', 'cancelled'] as const)('supports parent fallback %s without inventing a reason', stage => {
    expect(companyResearchDiagnostic(new Error(secret), stage)).toEqual({ stage, reason: 'unknown' });
  });
});
