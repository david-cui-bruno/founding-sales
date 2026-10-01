import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INTEGRATION_SETTING_VALUES,
  callTranscriptionSettingSchema,
  integrationsSettingsResponseSchema,
  transcriptSpeakerLabels,
  type CallTranscriptUtterance,
} from '../src/index.ts';

/** Slice C2's wire shapes: the speakers' names, the setting, and the integrations answer. */

const line = (speaker: number, start: number): CallTranscriptUtterance => ({ speaker, start, end: start + 1, text: 'words' });

describe('transcriptSpeakerLabels', () => {
  it('numbers every voice, and never guesses which one is you', () => {
    expect([...transcriptSpeakerLabels([line(0, 0), line(1, 2), line(0, 4)])]).toEqual([
      [0, 'Speaker 1'],
      [1, 'Speaker 2'],
    ]);
    expect([...transcriptSpeakerLabels([line(0, 0)])]).toEqual([[0, 'Speaker 1']]);
    expect([...transcriptSpeakerLabels([line(0, 0), line(1, 1), line(2, 2)])].map(([, label]) => label)).toEqual([
      'Speaker 1',
      'Speaker 2',
      'Speaker 3',
    ]);
    expect([...transcriptSpeakerLabels([line(1, 0), line(0, 1)])].map(([, label]) => label)).toEqual(['Speaker 1', 'Speaker 2']);
  });
});

describe('the call_transcription setting', () => {
  it('defaults to off, $0 a day, at Deepgram’s published Nova-3 rate', () => {
    expect(DEFAULT_INTEGRATION_SETTING_VALUES.call_transcription).toEqual({ enabled: false, dailyCeilingCents: 0, unitPriceMicros: 4_300 });
  });

  it('caps the daily ceiling at $5', () => {
    expect(callTranscriptionSettingSchema.safeParse({ enabled: true, dailyCeilingCents: 500, unitPriceMicros: 4_300 }).success).toBe(true);
    expect(callTranscriptionSettingSchema.safeParse({ enabled: true, dailyCeilingCents: 501, unitPriceMicros: 4_300 }).success).toBe(false);
  });

  it('leaves the integrations answer an S1 desktop reads unchanged unless transcription is asked for', () => {
    const base = {
      callingProvider: 'tel',
      telephonyBudget: { dailyCeilingCents: 0, maxMinutesPerCall: 30, unitPriceMicros: 14_000 },
      calendarIntegration: 'off',
      voicemailScript: 'Hi.',
      configured: { twilioVoice: { ok: false, missing: [] }, calcom: { ok: false, missing: [] } },
      spentTodayCents: 0,
    };
    expect(integrationsSettingsResponseSchema.parse(base)).toEqual(base);
    expect(
      integrationsSettingsResponseSchema.safeParse({
        ...base,
        transcription: {
          setting: { enabled: false, dailyCeilingCents: 0, unitPriceMicros: 4_300 },
          configured: { ok: false, missing: ['provider', 'api_key'] },
          spentTodayCents: 0,
        },
      }).success,
    ).toBe(true);
  });
});
