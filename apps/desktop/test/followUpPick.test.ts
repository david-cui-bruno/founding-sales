import { describe, expect, it } from 'vitest';
import type { FirmPageResponse } from '@fss/contracts';
import { livePermissionFor } from '../src/main/crmBridge.ts';
import { assigneeFirmPage } from './e2e/support/crmFixtures.ts';

/**
 * Which follow-up permission an enrolment uses, if any
 * (migration 0025; the second review of PR 332).
 *
 * The Mac does not ask a person to pick one: it reads the firm page and enrols on the
 * permission that fits. "Fits" is four things, and the first version of this check had
 * only two of them — it took the first live permission for the person, whatever it was
 * for and whether or not it had already bought a run. Both mistakes end the same way: an
 * enrolment the server refuses or rolls back, with a code a person has to interpret.
 *
 * No real person appears; `example.test` is reserved by RFC 6761.
 */

type Page = Extract<FirmPageResponse, { visibility: 'assigned_or_admin' }>;
type Permission = Page['followUpPermissions'][number];

const CONTACT = '66666666-6666-4666-8666-666666666666';
const OTHER_CONTACT = '77777777-7777-4777-8777-777777777777';
const VERSION = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const OTHER_VERSION = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const TEMPLATE = 'cccccccc-3333-4333-8333-cccccccccccc';
const OTHER_TEMPLATE = 'dddddddd-4444-4444-8444-dddddddddddd';

function permission(id: string, overrides: Partial<Permission> = {}): Permission {
  return {
    id,
    firmId: '11111111-1111-4111-8111-111111111111',
    contactId: CONTACT,
    kind: 'agreed_sequence',
    scope: 'agreed_sequence',
    callLogId: '22222222-2222-4222-8222-222222222222',
    mailMessageId: null,
    bookingReference: null,
    templateVersionId: null,
    sequenceVersionId: VERSION,
    enrollmentId: null,
    maxSteps: 3,
    grantedAt: '2026-09-28T12:00:00.000Z',
    expiresAt: '2099-01-01T12:00:00.000Z',
    grantedByUserId: '33333333-3333-4333-8333-333333333333',
    grantedByRule: null,
    consumedAt: null,
    revokedAt: null,
    note: null,
    ...overrides,
  };
}

function pageWith(permissions: readonly Permission[]): Page {
  const base = assigneeFirmPage() as Page;
  return { ...base, followUpPermissions: [...permissions] };
}

const agreedPlan = { sequenceVersionId: VERSION, templateVersionIds: [TEMPLATE, OTHER_TEMPLATE] };
const oneStepPlan = { sequenceVersionId: OTHER_VERSION, templateVersionIds: [TEMPLATE] };

describe('the permission an enrolment picks', () => {
  it('passes over the ones that are spent, revoked, expired or somebody else’s', () => {
    const page = pageWith([
      permission('10000000-0000-4000-8000-000000000001', { consumedAt: '2026-09-29T09:00:00.000Z' }),
      permission('10000000-0000-4000-8000-000000000002', { revokedAt: '2026-09-29T09:00:00.000Z' }),
      permission('10000000-0000-4000-8000-000000000003', { expiresAt: '2026-01-01T12:00:00.000Z' }),
      permission('10000000-0000-4000-8000-000000000004', { contactId: OTHER_CONTACT }),
      permission('10000000-0000-4000-8000-000000000005'),
    ]);
    expect(livePermissionFor(page, CONTACT, agreedPlan)).toBe('10000000-0000-4000-8000-000000000005');
  });

  it('passes over one that already bought a run', () => {
    const page = pageWith([
      permission('20000000-0000-4000-8000-000000000001', {
        enrollmentId: '44444444-4444-4444-8444-444444444444',
      }),
      permission('20000000-0000-4000-8000-000000000002'),
    ]);
    expect(livePermissionFor(page, CONTACT, agreedPlan)).toBe('20000000-0000-4000-8000-000000000002');
  });

  it('takes the agreed sequence only for the version it agreed to', () => {
    const page = pageWith([permission('30000000-0000-4000-8000-000000000001', { sequenceVersionId: OTHER_VERSION })]);
    expect(livePermissionFor(page, CONTACT, agreedPlan)).toBeNull();
    expect(
      livePermissionFor(page, CONTACT, { sequenceVersionId: OTHER_VERSION, templateVersionIds: [] }),
    ).toBe('30000000-0000-4000-8000-000000000001');
  });

  it('takes a one-message permission only for a one-step plan of its own bytes', () => {
    const single = permission('40000000-0000-4000-8000-000000000001', {
      kind: 'conversation',
      scope: 'single_email',
      sequenceVersionId: null,
      templateVersionId: TEMPLATE,
      maxSteps: 1,
    });
    const page = pageWith([single]);
    // A multi-step plan is not the one e-mail they asked for…
    expect(livePermissionFor(page, CONTACT, agreedPlan)).toBeNull();
    // …a one-step plan of another template is not their bytes…
    expect(
      livePermissionFor(page, CONTACT, { sequenceVersionId: OTHER_VERSION, templateVersionIds: [OTHER_TEMPLATE] }),
    ).toBeNull();
    // …and this is the plan they agreed to.
    expect(livePermissionFor(page, CONTACT, oneStepPlan)).toBe('40000000-0000-4000-8000-000000000001');
  });

  it('never offers the reserved booking scope', () => {
    const page = pageWith([
      permission('50000000-0000-4000-8000-000000000001', {
        kind: 'booking',
        scope: 'booking_communications',
        callLogId: null,
        bookingReference: 'cal-1',
        sequenceVersionId: null,
        maxSteps: null,
      }),
    ]);
    expect(livePermissionFor(page, CONTACT, agreedPlan)).toBeNull();
  });
});
