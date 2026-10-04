import type {JSX} from 'react';
import {meetingAutoRecordingSettingSchema,type IntegrationsSettingsResponse,type MeetingAutoRecordingSetting} from '@fss/contracts';
import {useKeptBased} from '../replies/kept.ts';
import {Button} from '../ui/button.tsx';
import {Input} from '../ui/input.tsx';
export function MeetingAutoRecordingSection({configuration,editable,busy,onSave}:{configuration:NonNullable<IntegrationsSettingsResponse['meetingAutoRecording']>;editable:boolean;busy:boolean;onSave(value:MeetingAutoRecordingSetting):void}):JSX.Element {
  const saved={enabled:configuration.setting.enabled,host:configuration.setting.hostEmail??'',event:configuration.setting.calcomEventTypeId?.toString()??''};
  const enabled=useKeptBased('settings:demo-recording:enabled',String(saved.enabled));
  const host=useKeptBased('settings:demo-recording:host',saved.host);
  const event=useKeptBased('settings:demo-recording:event',saved.event);
  const form={enabled:enabled.value==='true',host:host.value,event:event.value},parsed=meetingAutoRecordingSettingSchema.safeParse({enabled:form.enabled,hostEmail:form.host||null,calcomEventTypeId:form.event===''?null:Number(form.event)});
  const changed=form.enabled!==saved.enabled||form.host!==saved.host||form.event!==saved.event;
  const canSave=!busy&&editable&&changed&&(!form.enabled||configuration.configured.ready&&parsed.success);
  return <div className="space-y-3 border-t border-border py-4" data-testid="meeting-auto-recording-settings">
    <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={form.enabled} disabled={!editable||busy} onChange={e=>{enabled.set(String(e.target.checked));}}/>Automatically record Callie demos locally</label>
    <p className="text-sm text-muted-foreground">Only matched demo bookings. Host in the Zoom desktop app to create a local recording.</p>
    <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">Zoom host email<Input type="email" value={form.host} disabled={!editable||busy} onChange={e=>{host.set(e.target.value);}}/></label><label className="text-sm">Cal.com demo event ID<Input inputMode="numeric" value={form.event} disabled={!editable||busy} onChange={e=>{event.set(e.target.value);}}/></label></div>
    {!configuration.configured.ready?<p className="text-sm text-muted-foreground">Connect Zoom and Cal.com on the server before enabling this.</p>:null}
    <Button size="sm" aria-label="Save demo recording" disabled={!canSave} onClick={()=>{if(parsed.success)onSave(parsed.data);else if(!form.enabled)onSave({...configuration.setting,enabled:false});}}>Save</Button>
  </div>;
}
