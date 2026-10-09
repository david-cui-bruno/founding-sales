// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { SelectedImports, type SelectedImportPorts } from '../src/renderer/firms/SelectedImports.tsx';
import { SelectedAttachments, type SelectedAttachmentPorts } from '../src/renderer/firms/SelectedAttachments.tsx';
afterEach(cleanup);
const ID='11111111-1111-4111-8111-111111111111';
const file={fileName:'original.txt',declaredByteLength:13,bytesBase64:'U2VsZWN0ZWQgdGV4dA==',completeness:'complete' as const};
const source={workspaceId:ID,sourceId:ID,kind:'selected_note' as const,revision:1,contentHash:'b'.repeat(64),locator:null,speaker:null,occurredAt:null,observedAt:'2026-10-09T00:00:00Z',completeness:'selected_excerpt' as const,availability:'available' as const};
const page={file:{state:'selected' as const,sourceRevision:1,metadataRevision:1,fileName:'original.txt',byteLength:13,fileHash:'a'.repeat(64),format:'utf8_text' as const,origin:'user_selected_original' as const},source,processing:{state:'not_requested' as const,claims:[]}};
it('previews one original file, binds import to current firm, and requires a separate exact-version Analyze action',async()=>{
 const calls:string[]=[];
 const ports:SelectedAttachmentPorts={
  readFile:async()=>file,
  preview:async(input)=>{expect(input).toEqual(file);calls.push('preview');return {state:'supported',fileName:'original.txt',byteLength:13,fileHash:'a'.repeat(64),sourceContentHash:'b'.repeat(64),format:'utf8_text',origin:'user_selected_original',completeness:'complete',processing:'not_requested',previewHash:'c'.repeat(64)};},
  commit:async(input)=>{expect(input).toMatchObject({file,firmId:ID,personId:null,participants:[],occurredAt:null,previewHash:'c'.repeat(64)});calls.push('commit');return {sourceId:ID,sourceRevision:1,metadataRevision:1};},
  read:async()=>page,
  analyze:async(input)=>{expect(input).toEqual({source:{workspaceId:ID,sourceId:ID,kind:'selected_note',revision:1,contentHash:'b'.repeat(64),locator:null},fileHash:'a'.repeat(64)});calls.push('analyze');return {sourceId:ID,sourceRevision:1,generationId:ID,state:'pending',reason:'adapter_unavailable'};},
  reselect:async()=>{throw new Error('unexpected');},
 };
 render(<SelectedAttachments enabled firmId={ID} ports={ports} sources={[]} />);
 fireEvent.change(screen.getByLabelText('Original evidence file'),{target:{files:[new File(['Selected text'],'original.txt')]}});
 expect(await screen.findByText('Complete original selection · 13 bytes · utf8_text')).toBeTruthy();
 await userEvent.click(screen.getByRole('button',{name:'Import original file'}));
 expect(await screen.findByText('Analysis not requested')).toBeTruthy();expect(calls).toEqual(['preview','commit']);
 await userEvent.click(screen.getByRole('button',{name:'Analyze selected file'}));
 expect(await screen.findByText('pending · adapter_unavailable')).toBeTruthy();expect(calls).toEqual(['preview','commit','analyze']);
});
it('drops a late selected File after record privacy changes without previewing or importing it',async()=>{
 let finish!:(value:typeof file)=>void;const calls:string[]=[];
 const ports:SelectedAttachmentPorts={readFile:async()=>await new Promise(resolve=>{finish=resolve;}),preview:async()=>{calls.push('preview');throw new Error('late');},commit:async()=>{throw new Error('unexpected');},reselect:async()=>{throw new Error('unexpected');},analyze:async()=>{throw new Error('unexpected');},read:async()=>page};
 const view=render(<SelectedAttachments enabled firmId={ID} privacyKey="before" ports={ports} sources={[]}/>);
 fireEvent.change(screen.getByLabelText('Original evidence file'),{target:{files:[new File(['Selected text'],'original.txt')]}});
 view.rerender(<SelectedAttachments enabled firmId={ID} privacyKey="after" ports={ports} sources={[]}/>);
 finish(file);await new Promise(resolve=>setTimeout(resolve,0));expect(calls).toEqual([]);expect(screen.queryByText('Complete original selection · 13 bytes · utf8_text')).toBeNull();
});
it('requires a fresh file for a stale source and binds reselection to inspected revisions without analyzing it',async()=>{
 let refreshed=false;let reselected=false;
 const ports:SelectedAttachmentPorts={readFile:async()=>file,preview:async()=>({state:'supported',fileName:file.fileName,byteLength:13,fileHash:'a'.repeat(64),sourceContentHash:'b'.repeat(64),format:'utf8_text',origin:'user_selected_original',completeness:'complete',processing:'not_requested',previewHash:'c'.repeat(64)}),commit:async()=>{throw new Error('unexpected');},reselect:async(input)=>{expect(input).toMatchObject({sourceId:ID,expectedSourceRevision:2,expectedMetadataRevision:1,file});reselected=true;refreshed=true;return {sourceId:ID,sourceRevision:3,metadataRevision:2};},analyze:async()=>{throw new Error('must not analyze');},read:async()=>refreshed?{...page,source:{...source,revision:3},file:{...page.file,sourceRevision:3,metadataRevision:2}}:{...page,source:{...source,revision:2},file:{...page.file,state:'stale'}}};
 render(<SelectedAttachments enabled personId={ID} ports={ports} sources={[{sourceId:ID,label:'original.txt'}]}/>);
 await userEvent.click(screen.getByRole('button',{name:'Inspect file original.txt'}));
 expect(await screen.findByText('Fresh selection of the original file is required before analysis. Earlier quotations are unavailable.')).toBeTruthy();
 expect((screen.getByRole('button',{name:'Analyze selected file'}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.change(screen.getByLabelText('Original evidence file'),{target:{files:[new File(['Selected text'],'original.txt')]}});
 await screen.findByText('Complete original selection · 13 bytes · utf8_text');
 await userEvent.click(screen.getByRole('button',{name:'Reselect original file'}));
 expect(await screen.findByText('original.txt · selected · source revision 3')).toBeTruthy();expect(reselected).toBe(true);
});
it('keeps unknown provider acceptance visible after deletion while suppressing old file proof and quotations',async()=>{
 const ports:SelectedAttachmentPorts={readFile:async()=>file,preview:async()=>{throw new Error('unexpected');},commit:async()=>{throw new Error('unexpected');},reselect:async()=>{throw new Error('unexpected');},analyze:async()=>{throw new Error('unexpected');},read:async()=>({file:{...page.file,state:'deleted',fileName:null,byteLength:null,fileHash:null,format:null,origin:null},source:{...source,contentHash:null,availability:'deleted'},processing:{state:'source_unavailable',reason:'source_deleted'},processingHealth:{sourceId:ID,sourceRevision:1,availability:'deleted',generations:[],truncated:false,unknownAcceptance:true}})};
 render(<SelectedAttachments enabled firmId={ID} ports={ports} sources={[{sourceId:ID,label:'Deleted file'}]}/>);
 await userEvent.click(screen.getByRole('button',{name:'Inspect file Deleted file'}));
 expect(await screen.findByText('Processing coverage: 0 generations · provider acceptance unknown; cost accounting retained')).toBeTruthy();
 expect(screen.queryByText('original.txt')).toBeNull();expect((screen.getByRole('button',{name:'Analyze selected file'}) as HTMLButtonElement).disabled).toBe(true);
});
it('shows current exact quotations with inferred status and removes them after a source correction or access epoch',async()=>{
 const claim={claimId:ID,claimRevision:1 as const,claimHash:'d'.repeat(64),context:{personId:null,firmIds:[ID],relationships:[],review:'required' as const},kind:'need' as const,interpretation:'May need faster replies',status:'inferred' as const,quote:'Original quoted words',source};
 const processing={generationId:ID,contextHash:'e'.repeat(64),authorizationHash:'f'.repeat(64),purposeRevision:1,sourceRevision:1,processorVersion:'test-v1',modelVersion:'controlled-test',state:'complete' as const,reason:null,claims:[claim,{...claim,claimId:'22222222-2222-4222-8222-222222222222',quote:'Wrong revision quotation',source:{...source,revision:2}}]};
 const ports:SelectedAttachmentPorts={readFile:async()=>file,preview:async()=>{throw new Error('unexpected');},commit:async()=>{throw new Error('unexpected');},reselect:async()=>{throw new Error('unexpected');},analyze:async()=>{throw new Error('unexpected');},read:async()=>({...page,processing})};
 const view=render(<SelectedAttachments enabled firmId={ID} privacyKey="one" sourceVersion="one" ports={ports} sources={[{sourceId:ID,label:'original.txt'}]}/>);
 await userEvent.click(screen.getByRole('button',{name:'Inspect file original.txt'}));
 expect(await screen.findByText('Original quoted words')).toBeTruthy();expect(screen.getByText('need: May need faster replies · inferred')).toBeTruthy();expect(screen.getByText('Selected original file · revision 1 · Passage location unavailable · Speaker unknown · Context review required')).toBeTruthy();expect(screen.queryByText('Wrong revision quotation')).toBeNull();
 view.rerender(<SelectedAttachments enabled firmId={ID} privacyKey="one" sourceVersion="two" ports={ports} sources={[{sourceId:ID,label:'original.txt'}]}/>);
 expect(screen.queryByText('Original quoted words')).toBeNull();
 await userEvent.click(screen.getByRole('button',{name:'Inspect file original.txt'}));await screen.findByText('Original quoted words');
 view.rerender(<SelectedAttachments enabled={false} firmId={ID} privacyKey="two" sourceVersion="two" ports={ports} sources={[]}/>);
 expect(screen.queryByText('Original quoted words')).toBeNull();expect(screen.queryByLabelText('Original evidence file')).toBeNull();
});
it('does not publish a late processing page after navigation unmounts the selected record',async()=>{
 let finish!:(value:typeof page)=>void;
 const ports:SelectedAttachmentPorts={readFile:async()=>file,preview:async()=>{throw new Error('unexpected');},commit:async()=>{throw new Error('unexpected');},reselect:async()=>{throw new Error('unexpected');},analyze:async()=>{throw new Error('unexpected');},read:async()=>await new Promise(resolve=>{finish=resolve;})};
 const view=render(<SelectedAttachments enabled firmId={ID} ports={ports} sources={[{sourceId:ID,label:'original.txt'}]}/>);
 await userEvent.click(screen.getByRole('button',{name:'Inspect file original.txt'}));view.unmount();finish(page);await new Promise(resolve=>setTimeout(resolve,0));expect(screen.queryByText('Analysis not requested')).toBeNull();
});
it('uses original-byte attachment operations inside the existing selected-import section and refreshes its current record',async()=>{
 let reads=0;let imported=false;
 const attachments:SelectedAttachmentPorts={readFile:async()=>file,preview:async()=>({state:'supported',fileName:file.fileName,byteLength:13,fileHash:'a'.repeat(64),sourceContentHash:'b'.repeat(64),format:'utf8_text',origin:'user_selected_original',completeness:'complete',processing:'not_requested',previewHash:'c'.repeat(64)}),commit:async input=>{expect(input.personId).toBe(ID);expect(input.firmId).toBeNull();imported=true;return {sourceId:ID,sourceRevision:1,metadataRevision:1};},reselect:async()=>{throw new Error('unexpected');},analyze:async()=>{throw new Error('not requested');},read:async()=>page};
 const ports:SelectedImportPorts={attachments,read:async()=>{reads++;return {imports:imported?[{source:{...source,excerpt:'Selected text'},metadata:{revision:1,subtype:'selected_file',label:'original.txt',participants:[],attachments:[],direction:'unknown',directionVerified:false,attribution:'unknown',dateProvenance:'unknown'}}]:[],nextAfterId:null};},readFile:async()=>{throw new Error('legacy text file path must not run');},preview:async()=>{throw new Error('legacy preview must not run');},commit:async()=>{throw new Error('legacy commit must not run');},correct:async()=>{},remove:async()=>{},restore:async()=>{},recapture:async()=>{}};
 render(<SelectedImports enabled personId={ID} privacyKey="current" ports={ports}/>);
 expect(screen.queryByLabelText('Selected text file')).toBeNull();
 fireEvent.change(screen.getByLabelText('Original evidence file'),{target:{files:[new File(['Selected text'],'original.txt')]}});
 await screen.findByText('Complete original selection · 13 bytes · utf8_text');await userEvent.click(screen.getByRole('button',{name:'Import original file'}));
 expect(await screen.findByRole('button',{name:'Inspect file original.txt'})).toBeTruthy();expect(reads).toBe(2);expect(await screen.findByText('Analysis not requested')).toBeTruthy();
});
it('shows preserved unknown acceptance on an available reselected source and keeps analysis on hold',async()=>{
 const ports:SelectedAttachmentPorts={readFile:async()=>file,preview:async()=>{throw new Error('unexpected');},commit:async()=>{throw new Error('unexpected');},reselect:async()=>{throw new Error('unexpected');},analyze:async()=>{throw new Error('must not repeat uncertain processing');},read:async()=>({...page,processingHealth:{sourceId:ID,sourceRevision:1,availability:'available',generations:[],truncated:false,unknownAcceptance:true}})};
 render(<SelectedAttachments enabled firmId={ID} ports={ports} sources={[{sourceId:ID,label:'original.txt'}]}/>);
 await userEvent.click(screen.getByRole('button',{name:'Inspect file original.txt'}));
 await screen.findByText('Processing coverage: 0 generations · provider acceptance unknown; cost accounting retained');
 expect((screen.getByRole('button',{name:'Analyze selected file'}) as HTMLButtonElement).disabled).toBe(true);
 expect(screen.getByText('Analysis is on hold while provider acceptance is unknown.')).toBeTruthy();
});
