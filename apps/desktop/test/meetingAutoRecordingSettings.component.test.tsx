// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {MeetingAutoRecordingSection} from '../src/renderer/settings/MeetingAutoRecordingSection.tsx';
import {DraftsProvider} from '../src/renderer/app/drafts.tsx';
afterEach(cleanup);
it('requires configured service and exact booking identity to enable',()=>{
  const save=vi.fn();const config={setting:{enabled:false,hostEmail:null,calcomEventTypeId:null},version:0,configured:{ready:true,workerFresh:true}};
  render(<DraftsProvider><MeetingAutoRecordingSection configuration={config} editable busy={false} onSave={save}/></DraftsProvider>);
  fireEvent.click(screen.getByLabelText('Automatically record Callie demos locally'));
  expect((screen.getByRole('button',{name:'Save demo recording'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Zoom host email'),{target:{value:'host@example.com'}});fireEvent.change(screen.getByLabelText('Cal.com demo event ID'),{target:{value:'42'}});
  fireEvent.click(screen.getByRole('button',{name:'Save demo recording'}));expect(save).toHaveBeenCalledWith({enabled:true,hostEmail:'host@example.com',calcomEventTypeId:42});
});
