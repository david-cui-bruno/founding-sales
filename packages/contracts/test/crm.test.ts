import { describe, expect, it } from 'vitest';
import {
  CRM_REFUSAL_CODES,
  changeStageCommandSchema,
  firmDetailDtoSchema,
  firmIdentityDtoSchema,
  firmReadDtoSchema,
  routeDtoSchema,
} from '../src/index.ts';

const ID = '11111111-1111-4111-8111-111111111111';

const IDENTITY = {
  id: ID,
  name: 'Northwind Test Holdings',
  website: null,
  locality: 'Providence',
  regionCode: 'RI',
  status: 'active' as const,
  assignedUserId: null,
  stageKey: 'new',
  opportunityStatus: 'open' as const,
  controlMode: 'automated' as const,
  openedAt: '2026-09-20T12:00:00.000Z',
  timeZone: 'America/New_York',
  timeZoneUnresolvedReason: null,
};

describe('the CRM refusal set', () => {
  it('has no duplicates', () => {
    expect(new Set(CRM_REFUSAL_CODES).size).toBe(CRM_REFUSAL_CODES.length);
  });
});

describe('Appendix F as two schemas', () => {
  it('accepts the identity DTO every active member gets', () => {
    expect(firmIdentityDtoSchema.parse(IDENTITY)).toEqual(IDENTITY);
  });

  /**
   * The point of two schemas rather than one and a filter: the narrow one is strict,
   * so a later lane that adds notes to the detail DTO cannot leak them into the read
   * a colleague gets by forgetting to strip a field. The parse refuses the row.
   */
  it('refuses a field of the wider class on the narrower schema', () => {
    for (const extra of [{ contacts: [] }, { notes: ['a note'] }, { addressLine: '1 Example Way' }]) {
      expect(firmIdentityDtoSchema.safeParse({ ...IDENTITY, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
  });

  it('accepts the detail DTO with the fields only the assignee and admins see', () => {
    const detail = {
      ...IDENTITY,
      addressLine: null,
      postalCode: '02903',
      countryCode: 'US',
      timeZoneConfidence: 'medium' as const,
      timeZoneSource: 'state_default' as const,
      contacts: [],
      phoneRoutes: [],
      emailRoutes: [],
      aliases: [{ aliasKind: 'name', aliasValue: 'Northwind Holdings' }],
    };
    expect(firmDetailDtoSchema.parse(detail)).toEqual(detail);
    expect(firmReadDtoSchema.parse({ visibility: 'assigned_or_admin', firm: detail })).toBeDefined();
    expect(firmReadDtoSchema.safeParse({ visibility: 'assigned_or_admin', firm: IDENTITY }).success).toBe(false);
  });

  it('requires a route to carry the version the card displays', () => {
    const route = { id: ID, contactId: null, value: '+14015550187', eligibility: 'usable' as const, version: 2 };
    expect(routeDtoSchema.parse(route)).toEqual(route);
    const { version: _version, ...withoutVersion } = route;
    expect(routeDtoSchema.safeParse(withoutVersion).success).toBe(false);
    expect(routeDtoSchema.safeParse({ ...route, version: 0 }).success).toBe(false);
  });
});

describe('command bodies', () => {
  it('requires a command id and a client version on every mutation', () => {
    expect(changeStageCommandSchema.safeParse({ opportunityId: ID, toStageKey: 'contacting' }).success).toBe(false);
    expect(
      changeStageCommandSchema.safeParse({ commandId: 'c-1', clientVersion: '1.4.0', opportunityId: ID, toStageKey: 'contacting' })
        .success,
    ).toBe(true);
  });

  it('refuses a field the command does not have, rather than ignoring it', () => {
    expect(
      changeStageCommandSchema.safeParse({
        commandId: 'c-1',
        clientVersion: '1.4.0',
        opportunityId: ID,
        toStageKey: 'contacting',
        // A stage change that quietly accepted this would be a second way to change
        // who may contact a prospect.
        assignedToEmail: 'someone@example.test',
      }).success,
    ).toBe(false);
  });

  it('lets a stage change omit its reason, because only Lost needs one', () => {
    expect(
      changeStageCommandSchema.safeParse({ commandId: 'c-2', clientVersion: '1.4.0', opportunityId: ID, toStageKey: 'contacting' })
        .success,
    ).toBe(true);
  });
});
