import { describe, expect, it } from 'vitest';
import { configureOutreachSchema, emailDraftSchema, saveDraftSchema, sendDraftSchema } from '../../src/shared/contracts/outreachContract';

describe('email boundary contracts', () => {
  it('rejects target or provider secrets smuggled into send', () => {
    const request = {draftId:'draft-1', expectedRevision:1, commandId:'2d015ad7-1492-4515-8d3b-944df14a68f9'};
    expect(sendDraftSchema.parse(request)).toEqual(request);
    expect(sendDraftSchema.safeParse({...request, to:'other@example.com'}).success).toBe(false);
    expect(sendDraftSchema.safeParse({...request, accessToken:'secret'}).success).toBe(false);
  });
  it('rejects subject header injection but permits multiline editable bodies', () => {
    const request = {draftId:'draft-1',expectedRevision:1,subject:'Hello',body:'Line one\nLine two'};
    expect(saveDraftSchema.safeParse(request).success).toBe(true);
    expect(saveDraftSchema.safeParse({...request,subject:'Hello\r\nBcc: other@example.com'}).success).toBe(false);
  });
  it('rejects leaked secrets in responses and unbounded configuration', () => {
    expect(emailDraftSchema.safeParse({accessToken:'secret'}).success).toBe(false);
    expect(configureOutreachSchema.safeParse({apiKey:'x'.repeat(5000)}).success).toBe(false);
    expect(configureOutreachSchema.safeParse({senderName:'Founder',postalAddress:'Office address'}).success).toBe(true);
  });
});
