// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {ImageEditor} from '../src/renderer/social/ImageEditor.tsx';
afterEach(cleanup);
const id='11111111-1111-4111-8111-111111111111';
const stage={id,width:100,height:80,baseWidth:100,baseHeight:80,preview:'data:image/png;base64,AAAA',crop:null,redactions:[],locked:false,usageNote:'Photo'};
it('requires preview load and applied edits before uploading',async()=>{
 const upload=vi.fn(async()=>({stage:null,reason:null,savedAssetId:id})),edit=vi.fn(async()=>({stage:{...stage,width:50},reason:null,savedAssetId:null}));
 const saved=vi.fn();render(<ImageEditor onSaved={saved} ports={{state:async()=>({stage,reason:null,savedAssetId:null}),choose:vi.fn(),edit,upload,discard:vi.fn()}}/>);
 await waitFor(()=>expect(screen.getByLabelText('Crop width')).toBeTruthy());
 expect((screen.getByText('Save to library') as HTMLButtonElement).disabled).toBe(true);
 fireEvent.load(screen.getByAltText('Image being prepared'));
 fireEvent.change(screen.getByLabelText('Crop width'),{target:{value:'50'}});
 expect((screen.getByText('Save to library') as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByText('Preview edits'));await waitFor(()=>expect(edit).toHaveBeenCalledTimes(1));
 fireEvent.load(screen.getByAltText('Image being prepared'));fireEvent.click(screen.getByText('Save to library'));
 await waitFor(()=>expect(saved).toHaveBeenCalledWith(id));expect(upload).toHaveBeenCalledWith({id});
});
it('keeps interrupted upload visible for retry and locks edits',async()=>{
 render(<ImageEditor onSaved={vi.fn()} ports={{state:async()=>({stage:{...stage,locked:true},reason:'upload_interrupted',savedAssetId:null}),choose:vi.fn(),edit:vi.fn(),upload:vi.fn(),discard:vi.fn()}}/>);
 await waitFor(()=>expect(screen.getByText('Retry upload')).toBeTruthy());expect(screen.getByLabelText('Crop width').matches(':disabled')).toBe(true);expect(screen.getByRole('status').textContent).toContain('retry');
});
