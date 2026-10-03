import { useState, type JSX } from 'react';
import type { MeetingTranscriptionSetting } from '@fss/contracts';
import { useKeptBased } from '../replies/kept.ts';
import { Button } from '../ui/button.tsx';
import { Input } from '../ui/input.tsx';
import { Row, RowMain } from '../ui/layout.tsx';
export function MeetingTranscriptionSection({ setting, spentTodayCents, editable, busy, onSave }: {
  setting: MeetingTranscriptionSetting; spentTodayCents: number; editable: boolean; busy: boolean;
  onSave(value: MeetingTranscriptionSetting): void;
}): JSX.Element {
  const kept = useKeptBased('settings:meeting-transcription:allowance', (setting.dailyCeilingCents / 100).toFixed(2), (a,b) => Number(a) === Number(b));
  const [details, setDetails] = useState(false);
  const dollars = kept.value, cents = /^\d{1,2}(\.\d{1,2})?$/u.test(dollars.trim()) ? Math.round(Number(dollars) * 100) : -1;
  const valid = cents >= 0 && cents <= 500;
  const coverage = setting.creditCoverage;
  const recorded = coverage !== null && coverage.status === 'verified' && Date.parse(coverage.verifiedAt) <= Date.now() && Date.parse(coverage.validUntil) > Date.now();
  const ready = setting.dailyCeilingCents > 0 && recorded;
  return <div data-testid="meeting-transcription-settings" className="border-t border-border">
    <Row><RowMain line="Transcribe demo meetings" detail={setting.dailyCeilingCents === 0 ? 'Set a daily meeting allowance before enabling transcription.' : !recorded ? 'AWS credit coverage needs verification before processing.' : 'Imported demo audio is transcribed using Amazon Transcribe.'} />
      <input type="checkbox" role="switch" aria-label="Transcribe demo meetings" checked={setting.enabled} disabled={!editable || busy || (!setting.enabled && !ready)} onChange={event => { onSave({ ...setting, enabled: event.target.checked }); }} />
    </Row>
    <Row className="flex-wrap items-start"><RowMain line="Daily meeting allowance" detail={`Reserved or used today: $${(spentTodayCents/100).toFixed(2)}. Separate from call transcription.`} />
      <div className="flex items-center gap-2"><span className="text-sm">$</span><Input className="h-8 w-20 text-right" aria-label="Meeting transcription dollars per day" inputMode="decimal" value={dollars} disabled={!editable || busy} aria-invalid={!valid} onChange={event => { kept.set(event.target.value); }} /><span className="text-xs text-muted-foreground">a day</span>
        <Button size="sm" aria-label="Save meeting allowance" disabled={!editable || busy || !valid || cents === setting.dailyCeilingCents} onClick={() => { if (valid) onSave({ ...setting, dailyCeilingCents: cents }); }}>Save</Button>
      </div>
    </Row>
    {!valid ? <p role="alert" className="text-xs text-destructive">Enter an amount from $0 to $5.</p> : null}
    <div className="pb-3"><Button size="sm" variant="quiet" aria-expanded={details} onClick={() => { setDetails(!details); }}>About credit coverage</Button>
      {details ? <p className="mt-1 text-xs text-muted-foreground">The allowance limits gross provider cost before credits. Coverage must be recorded for this AWS account and service; it is checked before each job. This is not a live credit-balance check. If coverage expires, new work waits. There is no automatic cash fallback.{coverage === null ? '' : ` Recorded coverage expires ${new Date(coverage.validUntil).toLocaleDateString()}.`}</p> : null}
    </div>
  </div>;
}
