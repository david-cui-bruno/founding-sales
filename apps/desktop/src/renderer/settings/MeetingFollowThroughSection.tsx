import type { JSX } from 'react';
import type { IntegrationsSettingsResponse } from '@fss/contracts';
import { useKeptBased } from '../replies/kept.ts';
import { Button } from '../ui/button.tsx';
import { Row,RowMain } from '../ui/layout.tsx';
export function MeetingFollowThroughSection({configuration,editable,busy,onSave}:{
  configuration:NonNullable<IntegrationsSettingsResponse['meetingFollowThrough']>;editable:boolean;busy:boolean;
  onSave(value:{sequenceVersionId:string|null}):void;
}):JSX.Element {
  const saved=configuration.setting.sequenceVersionId??'',kept=useKeptBased('settings:meeting-recap-sequence',saved,(a,b)=>a===b);
  const available=kept.value===''||configuration.choices.some(c=>c.id===kept.value);
  return <div className="border-t border-border" data-testid="meeting-follow-through-settings">
    <Row className="flex-wrap items-start"><RowMain line="Meeting recaps" detail="Prepare a recap and up to two related follow-ups. Your sending pause and contact stops still apply."/>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <select aria-label="Recap sequence" className="max-w-full rounded-md border border-input bg-background p-2 text-sm" value={kept.value} disabled={!editable||busy} onChange={event=>{kept.set(event.target.value);}}>
          <option value="">No sequence selected</option>
          {saved!==''&&!configuration.choices.some(c=>c.id===saved)?<option value={saved} disabled>Current sequence unavailable</option>:null}
          {configuration.choices.map(choice=><option key={choice.id} value={choice.id}>{choice.label}</option>)}
        </select>
        <Button size="sm" aria-label="Save recap sequence" disabled={!editable||busy||!available||kept.value===saved} onClick={()=>{onSave({sequenceVersionId:kept.value||null});}}>Save</Button>
      </div>
    </Row>
    {configuration.choices.length===0?<p className="pb-3 text-sm text-muted-foreground">Create and publish an email sequence in Sequences using approved templates. The first template needs the {'{meeting_recap}'} placeholder; any later steps use ordinary follow-up copy. Then refresh settings.</p>:null}
    {kept.elsewhere?<p className="pb-3 text-sm text-muted-foreground">The sequence changed elsewhere. Check the current selection.</p>:null}
  </div>;
}
