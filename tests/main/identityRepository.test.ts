import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { IdentityRepository } from '../../src/main/domain/identity/identityRepository';
import { StaleDomainWriteError } from '../../src/main/domain/support/domainErrors';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../fixtures/tempDatabase';

const TIMESTAMP = '2026-08-30T12:00:00.000Z';

describe('IdentityRepository', () => {
  let database: AppDatabase | undefined;
  let tempDatabase: TempDatabase | undefined;
  let unitOfWork: DomainUnitOfWork;

  afterEach(() => {
    if (database !== undefined) closeDatabase(database);
    tempDatabase?.cleanup();
  });

  async function createRepository(ids: string[]): Promise<IdentityRepository> {
    tempDatabase = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: tempDatabase.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${tempDatabase.path}.backups`,
      workspaceKey: key,
    });
    unitOfWork = new DomainUnitOfWork(database);
    let index = 0;
    return new IdentityRepository({
      database,
      unitOfWork,
      clock: { now: () => TIMESTAMP },
      ids: {
        next: () => {
          const id = ids[index++];
          if (id === undefined) throw new Error('Test ID sequence exhausted.');
          return id;
        },
      },
    });
  }

  function insertSourceEvent(id: string, personId: string): void {
    database!.raw.prepare(`
      INSERT INTO source_events (
        id, person_id, channel, observed_at, source_record_json, created_at
      ) VALUES (?, ?, 'custom', ?, '{}', ?)
    `).run(id, personId, TIMESTAMP, TIMESTAMP);
  }

  it('creates and parses a canonical person and contact method', async () => {
    const identities = await createRepository(['person-one', 'contact-one']);

    const result = unitOfWork.immediate(() => {
      const person = identities.createPerson({
        displayName: 'Kevin Shin',
        aliases: ['Kevin S.'],
        neverRecord: true,
        provenance: { import: 'registry-row-1' },
      });
      const contact = identities.addContactMethod({
        personId: person.id,
        kind: 'phone',
        normalizedValue: '+14015550100',
        rawValue: '(401) 555-0100',
        validationState: 'valid',
        reachability: 'direct',
        isPrimary: true,
        inContacts: false,
      });
      return { person, contact };
    });

    expect(result.person).toEqual({
      id: 'person-one',
      displayName: 'Kevin Shin',
      aliases: ['Kevin S.'],
      optedOut: false,
      optedOutAt: null,
      neverRecord: true,
      deletedAt: null,
      provenance: { import: 'registry-row-1' },
      version: 1,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    });
    expect(result.contact).toEqual({
      id: 'contact-one',
      personId: 'person-one',
      kind: 'phone',
      normalizedValue: '+14015550100',
      rawValue: '(401) 555-0100',
      validationState: 'valid',
      reachability: 'direct',
      isPrimary: true,
      inContacts: false,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    });
  });

  it('lists every Person contact method in stable kind/value/id order', async () => {
    const identities = await createRepository(['person-list', 'phone-z', 'email-a', 'phone-a']);
    const person = unitOfWork.immediate(() => {
      const created = identities.createPerson({ displayName: 'Contact List' });
      identities.addContactMethod({
        personId: created.id, kind: 'phone', normalizedValue: '+14015550199',
        validationState: 'invalid', reachability: 'none',
      });
      identities.addContactMethod({
        personId: created.id, kind: 'email', normalizedValue: 'a@example.com',
        validationState: 'unverified', reachability: 'indirect',
      });
      identities.addContactMethod({
        personId: created.id, kind: 'phone', normalizedValue: '+14015550100',
        validationState: 'valid', reachability: 'direct',
      });
      return created;
    });

    expect(identities.listContactMethodsForPerson(person.id).map(({ id }) => id))
      .toEqual(['email-a', 'phone-a', 'phone-z']);
  });

  it('links two LLCs and properties to one canonical Prospect', async () => {
    const identities = await createRepository([
      'person',
      'prospect',
      'organization-one',
      'alias-one',
      'organization-two',
      'property-one',
      'property-two',
    ]);

    const result = unitOfWork.immediate(() => {
      const person = identities.createPerson({ displayName: 'Kevin Shin' });
      insertSourceEvent('source-one', person.id);
      const prospect = identities.createCanonicalProspect({
        personId: person.id,
        originalSourceEventId: 'source-one',
        segment: 'hot_frbo',
        qualificationState: 'eligible',
      });
      const firstOrganization = identities.createOrganization({
        canonicalName: 'Shin Holdings LLC',
        sourceRecord: { registryId: 'one' },
      });
      identities.addOrganizationAlias({
        organizationId: firstOrganization.id,
        alias: 'Shin Holdings',
      });
      const secondOrganization = identities.createOrganization({
        canonicalName: 'Elmwood Rentals LLC',
      });
      const firstProperty = identities.createProperty({
        organizationId: firstOrganization.id,
        addressLine1: '10 Hope St',
        locality: 'Providence',
        region: 'RI',
        postalCode: '02906',
        countryCode: 'US',
        doorCount: 6,
      });
      const secondProperty = identities.createProperty({
        organizationId: secondOrganization.id,
        addressLine1: '20 Elmwood Ave',
        locality: 'Providence',
        region: 'RI',
        countryCode: 'US',
        doorCount: 12,
        maintenanceProfile: { heating: 'steam' },
      });

      identities.linkOrganization({
        prospectId: prospect.id,
        organizationId: firstOrganization.id,
        relationship: 'owner',
      });
      identities.linkOrganization({
        prospectId: prospect.id,
        organizationId: secondOrganization.id,
        relationship: 'owner',
      });
      identities.linkProperty({
        prospectId: prospect.id,
        propertyId: firstProperty.id,
        relationship: 'owner',
      });
      identities.linkProperty({
        prospectId: prospect.id,
        propertyId: secondProperty.id,
        relationship: 'owner',
      });
      return { person, prospect };
    });

    expect(identities.getCanonicalProspect(result.person.id)).toEqual(result.prospect);
    expect(database!.raw.prepare('SELECT count(*) AS count FROM prospects').get()).toEqual({ count: 1 });
    expect(database!.raw.prepare('SELECT count(*) AS count FROM prospect_organizations').get()).toEqual({ count: 2 });
    expect(database!.raw.prepare('SELECT count(*) AS count FROM prospect_properties').get()).toEqual({ count: 2 });
  });

  it('makes only an exact join retry idempotent and propagates unrelated constraints', async () => {
    const identities = await createRepository([
      'person', 'prospect', 'organization', 'property',
    ]);

    const context = unitOfWork.immediate(() => {
      const person = identities.createPerson({ displayName: 'Kevin' });
      insertSourceEvent('source', person.id);
      const prospect = identities.createCanonicalProspect({
        personId: person.id,
        originalSourceEventId: 'source',
        segment: 'warm',
        qualificationState: 'eligible',
      });
      const organization = identities.createOrganization({ canonicalName: 'One LLC' });
      const property = identities.createProperty({
        addressLine1: '10 Hope St', locality: 'Providence', region: 'RI',
      });
      identities.linkOrganization({
        prospectId: prospect.id, organizationId: organization.id, relationship: 'owner',
      });
      identities.linkOrganization({
        prospectId: prospect.id, organizationId: organization.id, relationship: 'owner',
      });
      identities.linkProperty({ prospectId: prospect.id, propertyId: property.id });
      identities.linkProperty({ prospectId: prospect.id, propertyId: property.id, relationship: null });
      return { prospect, organization, property };
    });

    expect(database!.raw.prepare('SELECT count(*) AS count FROM prospect_organizations').get())
      .toEqual({ count: 1 });
    expect(database!.raw.prepare('SELECT count(*) AS count FROM prospect_properties').get())
      .toEqual({ count: 1 });
    expect(() => unitOfWork.immediate(() => identities.linkOrganization({
      prospectId: context.prospect.id,
      organizationId: context.organization.id,
      relationship: 'manager',
    }))).toThrowError(expect.objectContaining({ name: 'ContextLinkConflictError' }));
    expect(() => unitOfWork.immediate(() => identities.linkProperty({
      prospectId: context.prospect.id,
      propertyId: context.property.id,
      relationship: 'owner',
    }))).toThrowError(expect.objectContaining({ name: 'ContextLinkConflictError' }));
    expect(database!.raw.prepare(`
      SELECT relationship FROM prospect_organizations
      WHERE prospect_id = ? AND organization_id = ?
    `).get(context.prospect.id, context.organization.id)).toEqual({ relationship: 'owner' });
    expect(database!.raw.prepare(`
      SELECT relationship FROM prospect_properties
      WHERE prospect_id = ? AND property_id = ?
    `).get(context.prospect.id, context.property.id)).toEqual({ relationship: null });
    expect(() => unitOfWork.immediate(() => identities.linkOrganization({
      prospectId: context.prospect.id,
      organizationId: 'missing-organization',
    }))).toThrow();
  });

  it('returns every Person sharing a handle in stable Person-ID order', async () => {
    const identities = await createRepository([
      'z-person',
      'z-contact',
      'a-person',
      'a-contact',
    ]);

    unitOfWork.immediate(() => {
      const zPerson = identities.createPerson({ displayName: 'Z Person' });
      identities.addContactMethod({
        personId: zPerson.id,
        kind: 'phone',
        normalizedValue: '+14015550100',
        validationState: 'valid',
        reachability: 'indirect',
      });
      const aPerson = identities.createPerson({ displayName: 'A Person' });
      identities.addContactMethod({
        personId: aPerson.id,
        kind: 'phone',
        normalizedValue: '+14015550100',
        validationState: 'valid',
        reachability: 'indirect',
      });
    });

    expect(identities.findPeopleByNormalizedHandle('phone', '+14015550100').map(({ id }) => id))
      .toEqual(['a-person', 'z-person']);
  });

  it('returns every ContactMethod and Person match including reachability and deletion state', async () => {
    const identities = await createRepository([
      'z-person', 'z-contact', 'a-person', 'a-contact',
    ]);

    unitOfWork.immediate(() => {
      const zPerson = identities.createPerson({ displayName: 'Z Person' });
      identities.addContactMethod({
        personId: zPerson.id,
        kind: 'email',
        normalizedValue: 'shared@example.com',
        validationState: 'valid',
        reachability: 'indirect',
      });
      const aPerson = identities.createPerson({ displayName: 'A Person' });
      identities.addContactMethod({
        personId: aPerson.id,
        kind: 'email',
        normalizedValue: 'shared@example.com',
        validationState: 'valid',
        reachability: 'direct',
      });
    });
    database!.raw.prepare(`
      UPDATE persons SET deleted_at = ? WHERE id = 'z-person'
    `).run(TIMESTAMP);

    expect(identities.findContactMatchesByNormalizedHandle(
      'email', 'shared@example.com',
    )).toEqual([
      expect.objectContaining({
        person: expect.objectContaining({ id: 'a-person', deletedAt: null }),
        contactMethod: expect.objectContaining({ id: 'a-contact', reachability: 'direct' }),
      }),
      expect.objectContaining({
        person: expect.objectContaining({ id: 'z-person', deletedAt: TIMESTAMP }),
        contactMethod: expect.objectContaining({ id: 'z-contact', reachability: 'indirect' }),
      }),
    ]);
  });

  it('finds all normalized organization aliases and canonical property addresses stably', async () => {
    const identities = await createRepository([
      'z-organization', 'z-alias', 'a-organization', 'a-alias',
      'z-property', 'a-property',
    ]);

    unitOfWork.immediate(() => {
      const zOrganization = identities.createOrganization({ canonicalName: 'Zeta LLC' });
      identities.addOrganizationAlias({
        organizationId: zOrganization.id,
        alias: 'shin holdings llc',
      });
      const aOrganization = identities.createOrganization({ canonicalName: 'Alpha LLC' });
      identities.addOrganizationAlias({
        organizationId: aOrganization.id,
        alias: 'shin holdings llc',
      });
      identities.createProperty({
        addressLine1: '10 hope st',
        locality: 'providence',
        region: 'ri',
        postalCode: '02906',
        countryCode: 'US',
      });
      identities.createProperty({
        addressLine1: '10 hope st',
        locality: 'providence',
        region: 'ri',
        postalCode: '02906',
        countryCode: 'US',
      });
    });

    expect(identities.findOrganizationsByNormalizedAlias('shin holdings llc')
      .map(({ id }) => id)).toEqual(['a-organization', 'z-organization']);
    expect(identities.findPropertiesByCanonicalAddress({
      addressLine1: '10 hope st',
      addressLine2: null,
      locality: 'providence',
      region: 'ri',
      postalCode: '02906',
      countryCode: 'US',
    }).map(({ id }) => id)).toEqual(['a-property', 'z-property']);
  });

  it('uses plain INSERT for entity creation rather than suppressing collisions', async () => {
    const identities = await createRepository(['same-id', 'same-id']);

    expect(() => unitOfWork.immediate(() => {
      identities.createPerson({ displayName: 'First' });
      identities.createPerson({ displayName: 'Second' });
    })).toThrow();

    expect(database!.raw.prepare('SELECT count(*) AS count FROM persons').get()).toEqual({ count: 0 });
  });

  it('strictly validates input and rejects unsafe JSON values', async () => {
    const identities = await createRepository(['person-one', 'person-two', 'person-three', 'person-four']);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => unitOfWork.immediate(() => identities.createPerson({
      displayName: 'Unknown key',
      extra: true,
    } as never))).toThrow(z.ZodError);
    expect(() => unitOfWork.immediate(() => identities.createPerson({
      displayName: 'Undefined',
      provenance: { missing: undefined },
    }))).toThrow(TypeError);
    expect(() => unitOfWork.immediate(() => identities.createPerson({
      displayName: 'BigInt',
      provenance: { count: 1n },
    }))).toThrow(TypeError);
    expect(() => unitOfWork.immediate(() => identities.createPerson({
      displayName: 'Cycle',
      provenance: cyclic,
    }))).toThrow(TypeError);
  });

  it('fails closed when a stored Person row contains malformed JSON', async () => {
    const identities = await createRepository(['person', 'contact']);
    unitOfWork.immediate(() => {
      const person = identities.createPerson({ displayName: 'Kevin' });
      identities.addContactMethod({
        personId: person.id,
        kind: 'email',
        normalizedValue: 'kevin@example.com',
        validationState: 'valid',
        reachability: 'indirect',
      });
    });
    database!.raw.prepare("UPDATE persons SET aliases_json = '{bad' WHERE id = 'person'").run();

    expect(() => identities.findPeopleByNormalizedHandle('email', 'kevin@example.com'))
      .toThrow(z.ZodError);
  });

  it('parses the stored ContactMethod row used by handle lookup', async () => {
    const identities = await createRepository(['person', 'contact']);
    unitOfWork.immediate(() => {
      const person = identities.createPerson({ displayName: 'Kevin' });
      identities.addContactMethod({
        personId: person.id,
        kind: 'email',
        normalizedValue: 'kevin@example.com',
        validationState: 'valid',
        reachability: 'indirect',
      });
    });
    database!.raw.prepare("UPDATE person_contact_methods SET updated_at = 'not-utc' WHERE id = 'contact'").run();

    expect(() => identities.findPeopleByNormalizedHandle('email', 'kevin@example.com'))
      .toThrow(z.ZodError);
  });

  it('fails closed when the stored canonical Prospect row is corrupt', async () => {
    const identities = await createRepository(['person', 'prospect']);
    unitOfWork.immediate(() => {
      const person = identities.createPerson({ displayName: 'Kevin' });
      insertSourceEvent('source', person.id);
      identities.createCanonicalProspect({
        personId: person.id,
        originalSourceEventId: 'source',
        segment: 'warm',
        qualificationState: 'eligible',
      });
    });
    database!.raw.prepare("UPDATE prospects SET updated_at = 'not-utc' WHERE id = 'prospect'").run();

    expect(() => identities.getCanonicalProspect('person')).toThrow(z.ZodError);
  });

  it('CAS-updates only qualification state while preserving acquisition attribution', async () => {
    const identities = await createRepository(['person', 'prospect']);
    const prospect = unitOfWork.immediate(() => {
      const person = identities.createPerson({ displayName: 'Kevin' });
      insertSourceEvent('source', person.id);
      return identities.createCanonicalProspect({
        personId: person.id, originalSourceEventId: 'source', segment: 'warm',
        qualificationState: 'unreviewed',
      });
    });
    const updated = unitOfWork.immediate(() => identities.updateProspectQualification({
      prospectId: prospect.id, personId: prospect.personId, expectedVersion: 1,
      expectedState: 'unreviewed', nextState: 'eligible', reason: 'Founder reviewed',
      updatedAt: TIMESTAMP,
    }));
    expect(updated).toMatchObject({
      qualificationState: 'eligible', qualificationReason: 'Founder reviewed',
      originalSourceEventId: 'source', version: 2,
    });
    expect(() => unitOfWork.immediate(() => identities.updateProspectQualification({
      prospectId: prospect.id, personId: prospect.personId, expectedVersion: 1,
      expectedState: 'unreviewed', nextState: 'eligible', reason: null,
      updatedAt: TIMESTAMP,
    }))).toThrow(StaleDomainWriteError);
  });
});
