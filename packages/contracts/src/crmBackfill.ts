import { z } from 'zod';
import { uuid } from './foundationRows.ts';
import { commandIdSchema } from './auth.ts';
import { semanticVersionSchema } from './clientVersion.ts';
export const crmMailImportReadSchema=z.strictObject({mailboxId:uuid});
export const crmMailImportRequestSchema=crmMailImportReadSchema.extend({commandId:commandIdSchema,clientVersion:semanticVersionSchema});
export const crmMailImportHealthSchema=z.strictObject({
 importId:uuid,state:z.enum(['pending','partial','complete','blocked']),reason:z.string().max(100).nullable(),generation:z.number().int().positive(),
 fromAt:z.string().datetime(),toAt:z.string().datetime(),historyAnchor:z.string().regex(/^[0-9]{1,20}$/u).nullable(),historyComplete:z.boolean(),windowFrozen:z.boolean(),
 totalSlices:z.literal(90),completedSlices:z.number().int().min(0).max(90),coverageKind:z.literal('enumeration'),bodyCoverage:z.literal('not_measured'),
}).nullable();
export type CrmMailImportHealth=z.infer<typeof crmMailImportHealthSchema>;
