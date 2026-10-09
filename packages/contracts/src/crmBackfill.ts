import { z } from 'zod';
import { uuid } from './foundationRows.ts';
import { commandIdSchema } from './auth.ts';
import { semanticVersionSchema } from './clientVersion.ts';
export const crmMailImportReadSchema=z.strictObject({mailboxId:uuid});
export const crmMailImportRequestSchema=crmMailImportReadSchema.extend({commandId:commandIdSchema,clientVersion:semanticVersionSchema});
export const crmMailImportAcknowledgmentSchema=z.strictObject({importId:uuid,status:z.literal('queued')});
const conservedUnits=z.string().regex(/^(0|[1-9][0-9]{0,39})$/u);
export const crmMailImportHealthSchema=z.strictObject({
 connectionState:z.enum(['current','disconnected','changed']),importId:uuid,state:z.enum(['pending','partial','complete','blocked']),reason:z.string().max(100).nullable(),generation:z.number().int().positive(),
 fromAt:z.string().datetime(),toAt:z.string().datetime(),historyAnchor:z.string().regex(/^[0-9]{1,20}$/u).nullable(),historyComplete:z.boolean(),windowFrozen:z.boolean(),
 metadataCoverage:z.strictObject({retainedUniqueMessages:conservedUnits,availableMetadataMessages:conservedUnits,refusedMetadataMessages:conservedUnits,confirmedMissingMessages:conservedUnits,deletedMetadataMessages:conservedUnits}),
 quotaAccounting:z.strictObject({scope:z.literal('callie_backfill_allocation'),reservedUnits:conservedUnits,observedUnits:conservedUnits,unknownUnits:conservedUnits}),
 copyCoverage:z.strictObject({scope:z.literal('permitted_import_corpus'),coverage:z.enum(['complete','partial']),retainedCopiedBodies:conservedUnits,unavailableCopies:conservedUnits,pendingCaptures:conservedUnits,reviewRequiredMetadata:conservedUnits,uncapturedMetadata:conservedUnits,unresolvedMetadata:conservedUnits}),
 totalSlices:z.literal(90),completedSlices:z.number().int().min(0).max(90),coverageKind:z.literal('enumeration'),bodyCoverage:z.literal('measured'),
}).nullable();
export type CrmMailImportHealth=z.infer<typeof crmMailImportHealthSchema>;
