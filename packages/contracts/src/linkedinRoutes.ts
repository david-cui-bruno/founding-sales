import { z } from 'zod';
import { uuid } from './foundationRows.ts';
import { identityEvidenceSchema } from './peopleRelationships.ts';
import { commandIdSchema } from './auth.ts';
import { semanticVersionSchema } from './clientVersion.ts';
export const linkedinRouteRefuseSchema = z.object({ commandId: commandIdSchema, clientVersion: semanticVersionSchema, claimId: uuid, expectedRevision: z.number().int().positive(), firmId: uuid, relationshipId: uuid, expectedRelationshipRevision: z.number().int().positive(), scope: z.enum(['person', 'firm', 'ambiguous']) }).strict();
export const linkedinRouteAssessSchema = z.object({ claimId: uuid }).strict();
export const linkedinRouteSchema = z.object({
  routeId: uuid, claimId: uuid, claimRevision: z.number().int().positive(), profile: z.string(),
  personId: uuid, personName: z.string(), firmId: uuid, firmName: z.string(), role: z.string(),
  relationshipId: uuid, relationshipRevision: z.number().int().positive(),
  evidence: identityEvidenceSchema, relationshipEvidence: identityEvidenceSchema,
}).strict();
export const linkedinRouteAssessmentSchema = z.object({
  state: z.enum(['eligible', 'held']), reason: z.string(), route: linkedinRouteSchema.nullable(),
  sendingPermission: z.literal(false), connectionState: z.literal('unknown'),
  maintenanceNeed: z.literal('unknown'), buyingIntent: z.literal('unknown'),
}).strict();
export type LinkedinRouteAssessment = z.infer<typeof linkedinRouteAssessmentSchema>;
