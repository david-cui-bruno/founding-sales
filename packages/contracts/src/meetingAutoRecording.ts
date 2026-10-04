import { z } from 'zod';
import { instant, uuid } from './foundationRows.ts';
import { commandIdSchema } from './auth.ts';
import { semanticVersionSchema } from './clientVersion.ts';
export const meetingAutoRecordingSettingSchema = z.strictObject({
  enabled: z.boolean(), hostEmail: z.string().trim().toLowerCase().email().max(320).nullable(),
  calcomEventTypeId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
}).refine(v => !v.enabled || (v.hostEmail !== null && v.calcomEventTypeId !== null), 'enabling requires the verified host and demo event type');
export type MeetingAutoRecordingSetting = z.infer<typeof meetingAutoRecordingSettingSchema>;
export const DEFAULT_MEETING_AUTO_RECORDING: MeetingAutoRecordingSetting = {enabled:false,hostEmail:null,calcomEventTypeId:null};
export const RECORDING_SETUP_STATES = ['pending','verifying','ready','manual','obsolete'] as const;
export type RecordingSetupState = typeof RECORDING_SETUP_STATES[number];
export const RECORDING_SETUP_REASONS = ['disabled','unconfigured','routing_ambiguous','unmatched','not_future','expired','attempt_limit','booking_mismatch','zoom_mismatch','unsupported_meeting','unsupported_recording_mode','provider_refused','provider_unreachable','auth_failed','rate_limited','ambiguous_write','target_changed','manual_override'] as const;
export type RecordingSetupReason = typeof RECORDING_SETUP_REASONS[number];
export const meetingRecordingSetupViewSchema = z.strictObject({
  meetingId:uuid,operationId:uuid.nullable(),version:z.number().int().nonnegative(),
  state:z.enum([...RECORDING_SETUP_STATES,'disabled','not_applicable']),reason:z.enum(RECORDING_SETUP_REASONS).nullable(),
  checkedAt:instant.nullable(),canRetry:z.boolean(),previouslyEnabled:z.boolean(),
});
export type MeetingRecordingSetupView = z.infer<typeof meetingRecordingSetupViewSchema>;
export const retryMeetingRecordingSetupSchema = z.strictObject({meetingId:uuid,expectedVersion:z.number().int().nonnegative()});
export const retryMeetingRecordingSetupCommandSchema = retryMeetingRecordingSetupSchema.extend({commandId:commandIdSchema,clientVersion:semanticVersionSchema});
