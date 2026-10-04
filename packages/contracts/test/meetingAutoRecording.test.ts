import { describe, expect, it } from 'vitest';
import { DEFAULT_MEETING_AUTO_RECORDING, meetingAutoRecordingSettingSchema } from '../src/meetingAutoRecording.ts';
import { SETTING_KEYS, STORED_SETTING_VALUE_SCHEMAS } from '../src/settings.ts';
describe('demo recording configuration', () => {
  it('requires verified identity to enable but permits disabling before configuration', () => {
    expect(meetingAutoRecordingSettingSchema.parse(DEFAULT_MEETING_AUTO_RECORDING)).toEqual({enabled:false,hostEmail:null,calcomEventTypeId:null});
    for (const data of [{enabled:true,hostEmail:null,calcomEventTypeId:1},{enabled:true,hostEmail:'host@example.com',calcomEventTypeId:0},{enabled:true,hostEmail:'host@example.com',calcomEventTypeId:1.5}]) expect(meetingAutoRecordingSettingSchema.safeParse(data).success).toBe(false);
    expect(meetingAutoRecordingSettingSchema.parse({enabled:true,hostEmail:' HOST@example.com ',calcomEventTypeId:42})).toEqual({enabled:true,hostEmail:'host@example.com',calcomEventTypeId:42});
    expect(STORED_SETTING_VALUE_SCHEMAS.meeting_auto_recording.safeParse(DEFAULT_MEETING_AUTO_RECORDING).success).toBe(true);
    expect(SETTING_KEYS).not.toContain('meeting_auto_recording');
  });
});
