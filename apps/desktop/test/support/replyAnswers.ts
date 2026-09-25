import type { ClassifierSettingsResponse, ConfirmReplyResult, ReplyConfirmationDto } from '@fss/contracts';

/**
 * `/replies/settings` and the `/replies/confirm` result as the API answers them (lane
 * g78, audit item D03).
 *
 * Every key the routes send, typed as `@fss/contracts`' DTOs. The unit suite used to
 * answer the settings read with the three keys the window shows, which is the shape the
 * desktop's own parser declared — and that parser stopped the effort at `high`, so the
 * suite could not have noticed a workspace at `max`. `test/release/replies.check.ts`
 * holds these to the real routes' answers key for key and type for type.
 */

export function classifierSettingsAnswer(overrides: Partial<ClassifierSettingsResponse> = {}): ClassifierSettingsResponse {
  return {
    enabled: true,
    modelName: 'claude-opus-5',
    effort: 'low',
    maxOutputTokens: 512,
    dailyCallCap: 500,
    updatedByUserId: null,
    updatedAt: null,
    ...overrides,
  };
}

export function replyConfirmationAnswer(overrides: Partial<ReplyConfirmationDto> = {}): ReplyConfirmationDto {
  return {
    id: '99999999-9999-4999-8999-999999999999',
    messageId: '11111111-1111-4111-8111-111111111111',
    firmId: '33333333-3333-4333-8333-333333333333',
    opportunityId: '55555555-5555-4555-8555-555555555555',
    disposition: 'follow_up_later',
    suggestedDisposition: 'interested',
    suggestedBy: 'model',
    corrected: true,
    confirmedByUserId: '77777777-7777-4777-8777-777777777777',
    consequences: ['opportunity_manual', 'holds_released'],
    callbackId: null,
    note: null,
    createdAt: '2026-09-21T13:05:00.000Z',
    ...overrides,
  };
}

export function confirmReplyResultAnswer(overrides: Partial<ConfirmReplyResult> = {}): ConfirmReplyResult {
  return {
    confirmation: replyConfirmationAnswer(),
    suggestsLost: false,
    releasedHoldIds: ['88888888-8888-4888-8888-888888888888'],
    ...overrides,
  };
}
