import {z} from 'zod';
import {uuid} from './foundationRows.ts';
import {commandIdSchema} from './auth.ts';
import {semanticVersionSchema} from './clientVersion.ts';
const digest=z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const sha=z.string().regex(/^[a-f0-9]{64}$/u);
const instant=z.iso.datetime();
const revision=z.number().int().nonnegative();
const evidence=(max:number)=>z.string().min(1).max(max);
/** Retained operator-reviewed documentary evidence, never server runtime authority. */
export const emailAdmissionActivationProofSchema=z.strictObject({
 version:z.literal(1),evaluationReportJson:evidence(1048576),
 release:z.strictObject({recordReference:evidence(200),observedAt:instant,apiDigest:digest,workerDigest:digest,schemaVersion:z.number().int().positive(),deploymentReceiptJson:evidence(262144),postSmokeReadback:z.enum(['existing','created'])}),
 received:z.strictObject({mailboxId:uuid,senderAddress:z.email().max(320),observedAt:instant,messageReference:evidence(500),headerText:evidence(32768),reviewReference:evidence(500)}),
 sequence:z.strictObject({sequenceVersionId:uuid,renderedEvidenceJson:evidence(65536)}),
 interruptions:z.strictObject({originalOutboundId:uuid,originalEnrollmentId:uuid,providerId:evidence(500),observedAt:instant,integrationEvidenceJson:evidence(65536),reviewReference:evidence(500)}),
}).refine(value=>new TextEncoder().encode(JSON.stringify(value)).byteLength<=1900000,{message:'Retained activation evidence exceeds the storage allowance'});
export type EmailAdmissionActivationProof=z.infer<typeof emailAdmissionActivationProofSchema>;
const envelope={commandId:commandIdSchema,clientVersion:semanticVersionSchema};
export const emailAdmissionActivationPrepareSchema=z.strictObject({expectedControlRevision:revision,proof:emailAdmissionActivationProofSchema});
export const emailAdmissionActivationPrepareCommandSchema=emailAdmissionActivationPrepareSchema.extend(envelope);
export const emailAdmissionActivationSchema=z.strictObject({expectedControlRevision:revision,expectedReadinessSha256:sha,receiptId:uuid});
export const emailAdmissionActivationCommandSchema=emailAdmissionActivationSchema.extend(envelope);
export const emailAdmissionReadinessInputSchema=z.strictObject({});
export const emailAdmissionReadinessSchema=z.strictObject({enabled:z.boolean(),controlRevision:revision,receiptId:uuid.nullable(),readinessSha256:sha.nullable(),ready:z.boolean(),reasons:z.array(z.string())});
export const emailAdmissionActivationPrepareResultSchema=z.strictObject({receiptId:uuid,readinessSha256:sha});
export const emailAdmissionActivationResultSchema=z.strictObject({revision:z.number().int().positive()});
