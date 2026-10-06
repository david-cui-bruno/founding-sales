import {z} from 'zod';
import {uuid} from './foundationRows.ts';
import {commandIdSchema} from './auth.ts';
import {semanticVersionSchema} from './clientVersion.ts';
export const qualificationAnswerSchema=z.enum(['yes','no','unknown']);
export type QualificationAnswer=z.infer<typeof qualificationAnswerSchema>;
export const qualificationFieldSchema=z.enum(['buyingParticipant','maintenanceNeed','openToPaying']);
export type QualificationField=z.infer<typeof qualificationFieldSchema>;
export const meetingQualificationEvidenceSchema=z.strictObject({field:qualificationFieldSchema,sourceKind:z.enum(['meeting_item','call_item','user_note','user_confirmation']),sourceId:z.string().min(1).max(240),sourceRevision:z.number().int().nonnegative()});
export type QualificationEvidence=z.infer<typeof meetingQualificationEvidenceSchema>;
export const saveMeetingQualificationSchema=z.strictObject({meetingId:uuid,expectedRevision:z.number().int().nonnegative(),commandId:commandIdSchema,
 buyingParticipant:qualificationAnswerSchema,maintenanceNeed:qualificationAnswerSchema,openToPaying:qualificationAnswerSchema,evidence:z.array(meetingQualificationEvidenceSchema).max(3)
}).refine(v=>new Set(v.evidence.map(e=>e.field)).size===v.evidence.length,'One reference per field');
export type SaveMeetingQualification=z.infer<typeof saveMeetingQualificationSchema>;
export const saveMeetingQualificationCommandSchema=saveMeetingQualificationSchema.safeExtend({clientVersion:semanticVersionSchema});
export const meetingQualificationViewSchema=z.strictObject({meetingId:uuid,revision:z.number().int().nonnegative(),buyingParticipant:qualificationAnswerSchema,maintenanceNeed:qualificationAnswerSchema,openToPaying:qualificationAnswerSchema,
 attendanceConfirmed:z.boolean(),qualified:z.boolean(),sourceLinks:z.array(z.strictObject({field:qualificationFieldSchema,target:z.enum(['meeting_notes','call']),id:uuid})).max(3),evidence:z.array(meetingQualificationEvidenceSchema).max(3),staleFields:z.array(qualificationFieldSchema).max(3)});
export type MeetingQualificationView=z.infer<typeof meetingQualificationViewSchema>;
