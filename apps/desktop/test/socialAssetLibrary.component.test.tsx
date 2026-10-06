// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {AssetLibrary} from '../src/renderer/social/AssetLibrary.tsx';
afterEach(cleanup);
const asset={id:'11111111-1111-4111-8111-111111111111',state:'ready' as const,version:2,origin:{kind:'screenshot' as const,sourceUrl:null,usageNote:'Approved product screenshot'},objects:[{version:1,kind:'original' as const,state:'ready' as const,sha256:'a'.repeat(64),bytes:200,mime:'image/png',width:null,height:null},{version:2,kind:'derivative' as const,state:'ready' as const,sha256:'b'.repeat(64),bytes:100,mime:'image/png',width:100,height:100}]};
it('selects only the ready reviewed derivative with required alt text',async()=>{
 const select=vi.fn();render(<AssetLibrary ports={{read:async()=>({assets:[asset],reason:null}),remove:vi.fn()}} onSelect={select}/>);
 await waitFor(()=>expect(screen.getByText('Approved product screenshot')).toBeTruthy());
 expect((screen.getByText('Use image') as HTMLButtonElement).disabled).toBe(true);
 fireEvent.change(screen.getByLabelText('Image description'),{target:{value:'Callie dashboard'}});fireEvent.click(screen.getByText('Use image'));
 expect(select).toHaveBeenCalledWith({assetId:asset.id,version:2,altText:'Callie dashboard'});
});
it('does not claim a failed deletion succeeded',async()=>{
 const remove=vi.fn(async()=>({accepted:false,reason:'offline'}));render(<AssetLibrary ports={{read:async()=>({assets:[asset],reason:null}),remove}}/>);
 await waitFor(()=>expect(screen.getByText('Approved product screenshot')).toBeTruthy());fireEvent.click(screen.getByText('Remove image'));
 await waitFor(()=>expect(remove).toHaveBeenCalledTimes(1));expect(screen.getByText('Approved product screenshot')).toBeTruthy();expect(screen.getByText('The image could not be removed. Try again.')).toBeTruthy();
});
it('loads another page without losing the first page',async()=>{
 const first=Array.from({length:50},(_,index)=>({...asset,id:`asset-${index}`,origin:{...asset.origin,usageNote:`Image ${index}`}}));
 const read=vi.fn(async(afterId?:string)=>({assets:afterId?[{...asset,origin:{...asset.origin,usageNote:'Last image'}}]:first,reason:null}));
 render(<AssetLibrary ports={{read,remove:vi.fn()}}/>);
 await waitFor(()=>expect(screen.getByText('Load more images')).toBeTruthy());fireEvent.click(screen.getByText('Load more images'));
 await waitFor(()=>expect(screen.getByText('Last image')).toBeTruthy());expect(screen.getByText('Image 0')).toBeTruthy();expect(read).toHaveBeenLastCalledWith('asset-49');expect(screen.queryByText('Load more images')).toBeNull();
});
