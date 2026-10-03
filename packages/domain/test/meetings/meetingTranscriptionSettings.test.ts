import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readMeetingTranscription } from '../../meetings/transcriptionSettings.ts';
import { readCallTranscription } from '../../settings/integrations.ts';
import { updateSetting } from '../../settings/store.ts';
import { meetingTranscriptionFixture } from './support/meetingTranscriptionFixture.ts';
describe('meeting transcription settings', () => {
    let f: Awaited<ReturnType<typeof meetingTranscriptionFixture>>;
    beforeAll(async () => { f = await meetingTranscriptionFixture(); });
    afterAll(async () => { await f.db.drop(); });
    it('defaults off and never changes the separate call allowance', async () => {
        expect(await readMeetingTranscription(f.context)).toEqual({ enabled: false, dailyCeilingCents: 0, creditCoverage: null });
        const calls = await readCallTranscription(f.context);
        const changed = await updateSetting(f.context, { settingKey: 'meeting_transcription', value: { enabled: true, dailyCeilingCents: 50, creditCoverage: null } });
        expect(changed.ok).toBe(true);
        expect(await readCallTranscription(f.context)).toEqual(calls);
        await f.db.session.query("UPDATE workspace_settings SET value='{}' WHERE workspace_id=$1 AND setting_key='meeting_transcription'", [f.workspace]);
        expect(await readMeetingTranscription(f.context)).toEqual({ enabled: false, dailyCeilingCents: 0, creditCoverage: null });
    });
});
