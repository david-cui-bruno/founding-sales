import { z } from 'zod';

export const accountIdSchema = z.string().min(1).max(200);
export const accountInstantSchema = z.iso.datetime({ precision: 3 });
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const text = z.string().trim().min(1).max(2000);
const evidenceIds = z.array(accountIdSchema).max(100).refine(ids => new Set(ids).size === ids.length, 'Duplicate evidence IDs');
export const accountSchema = z.strictObject({ id: accountIdSchema, name: z.string().trim().min(1).max(300),
  domain: z.string().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/).nullable(), version });
export type Account = z.infer<typeof accountSchema>;
export const accountCreateSchema = accountSchema.pick({ name: true, domain: true }).extend({ commandId: z.uuid() });
export const accountRouteInputSchema = z.strictObject({ id: accountIdSchema, accountId: accountIdSchema,
  personId: accountIdSchema.nullable(), channel: z.enum(['phone', 'email', 'linkedin']), value: z.string().trim().min(1).max(2048),
  purpose: z.enum(['business', 'tenant_emergency', 'unknown']), evidenceIds: evidenceIds.min(1),
  /** Source verification, not contact permission. `listed` is a business directory entry (a Google Business Profile), not the company's own page. */
  verification: z.enum(['published', 'confirmed', 'unverified', 'listed']) });
export const accountRouteSchema = accountRouteInputSchema.extend({ version });
export type AccountRoute = z.infer<typeof accountRouteSchema>;
export const accountPortfolioSchema = z.strictObject({ count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  measure: z.enum(['units', 'buildings', 'properties']), scope: z.enum(['managed', 'owned']) });
const claimBase = { kind: z.enum(['fact', 'hypothesis', 'prospect_stated_problem']), evidenceIds };
export const accountClaimSchema = z.discriminatedUnion('key', [
  z.strictObject({ ...claimBase, key: z.literal('portfolio'), value: accountPortfolioSchema }),
  z.strictObject({ ...claimBase, key: z.enum(['residential_scope', 'operating_footprint', 'maintenance_workflow', 'technology', 'role', 'pain', 'ownership', 'portfolio_description']), value: text }),
]).refine(claim => claim.kind === 'hypothesis' || claim.evidenceIds.length > 0, 'Supported claims require evidence');
export type AccountClaim = z.infer<typeof accountClaimSchema>;
export const accountSourceSchema = z.strictObject({ id: accountIdSchema, url: z.url().max(2048).refine(value => {
  const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password;
}), fetchedAt: accountInstantSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/), excerpt: z.string().min(1).max(12000), permitted: z.boolean() });
export type AccountSource = z.infer<typeof accountSourceSchema>;
export const accountEvidenceBatchSchema = z.strictObject({ commandId: z.uuid(), accountId: accountIdSchema, expectedVersion: version,
  sources: z.array(accountSourceSchema).max(100), claims: z.array(accountClaimSchema).max(200), routes: z.array(accountRouteInputSchema).max(100) });
export type AccountEvidenceBatch = z.infer<typeof accountEvidenceBatchSchema>;
export type AccountEvidenceReceipt = { accountId: string; version: number; duplicate: boolean };
export type AccountEvidenceSnapshot = { account: Account; claims: AccountClaim[]; routes: AccountRoute[];
  portfolio: (z.infer<typeof accountPortfolioSchema> & { evidenceIds: string[] })[];
  unknowns: string[]; conflicts: string[]; fingerprint: string };

const linkBase = { id: accountIdSchema, evidenceIds: evidenceIds.min(1), relationship: z.string().trim().min(1).max(200),
  validFrom: accountInstantSchema, validTo: accountInstantSchema.nullable() };
/** Role/title is descriptive. Authority requires its own explicit evidence. */
export const accountLinkSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...linkBase, kind: z.literal('organization'), organizationId: accountIdSchema }),
  z.strictObject({ ...linkBase, kind: z.literal('property'), propertyId: accountIdSchema }),
  z.strictObject({ ...linkBase, kind: z.literal('person_role'), personId: accountIdSchema, role: text,
    authority: z.enum(['unconfirmed', 'confirmed']), authorityEvidenceIds: evidenceIds }),
]).refine(link => link.validTo === null || link.validTo > link.validFrom, 'Invalid validity interval')
  .refine(link => link.kind !== 'person_role' || link.authority !== 'confirmed' || link.authorityEvidenceIds.length > 0, 'Confirmed authority requires evidence');
export type AccountLink = z.infer<typeof accountLinkSchema>;
export const accountLinksCommandSchema = z.strictObject({ commandId: z.uuid(), accountId: accountIdSchema,
  expectedVersion: version, links: z.array(accountLinkSchema).min(1).max(100) });
