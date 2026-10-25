// @vitest-environment jsdom
import '../../src/client/schemaRuntime.ts';
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {ManualProspectActivityForm} from '../../src/client/ManualProspectActivityForm.tsx';
afterEach(cleanup);
it('requires explicit user attestation and leaves occurrence/result unknown with no implied current attempt',()=>{
 const save=vi.fn();render(<ManualProspectActivityForm disabled={false} onSave={save}/>);
 expect(screen.getByLabelText('I performed this manual attempt (user report, not verified)',{exact:true})).toHaveProperty('checked',false);expect(screen.getByLabelText('Occurrence UTC instant, blank means unknown',{exact:true})).toHaveProperty('value','');
 fireEvent.click(screen.getByRole('button',{name:'Save manual report'}));expect(save).not.toHaveBeenCalled();fireEvent.click(screen.getByLabelText('I performed this manual attempt (user report, not verified)',{exact:true}));fireEvent.click(screen.getByRole('button',{name:'Save manual report'}));expect(save).toHaveBeenCalledWith({performedByUser:true,channel:'manual_phone',occurrence:{kind:'unknown'},result:'unknown',note:null,callback:null});
});
it('populated correction remains exactly labelled, clears old callback and warns do-not-call is not suppression',()=>{
 const save=vi.fn();render(<ManualProspectActivityForm disabled={false} onSave={save} initial={{performedByUser:true,channel:'manual_phone',occurrence:{kind:'unknown'},result:'callback_requested',note:'Existing note',callback:{note:'Old intention',timing:{kind:'unknown'}}}}/>);
 expect(screen.getByLabelText('Relevant business result note',{exact:true})).toHaveProperty('value','Existing note');expect(screen.getByLabelText('Callback intention note',{exact:true})).toHaveProperty('value','Old intention');
 fireEvent.change(screen.getByLabelText('Reported result',{exact:true}),{target:{value:'do_not_call'}});expect(screen.queryByLabelText('Callback intention note',{exact:true})).toBeNull();expect(screen.getByRole('alert').textContent).toContain('No automatic suppression was applied');fireEvent.click(screen.getByRole('button',{name:'Save manual report'}));expect(save).toHaveBeenCalledWith(expect.objectContaining({result:'do_not_call',callback:null}));
});
