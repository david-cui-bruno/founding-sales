// @vitest-environment jsdom
import {act,cleanup,render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,expect,it} from 'vitest';
import {FirmAddresses,type FirmAddressPorts} from '../src/renderer/firms/FirmAddresses.tsx';
import {SelectedImports,type SelectedImportPorts} from '../src/renderer/firms/SelectedImports.tsx';
import type {EndpointPorts} from '../src/renderer/firms/Endpoints.tsx';
afterEach(cleanup);
const ID='11111111-1111-4111-8111-111111111111';
type Page=Awaited<ReturnType<SelectedImportPorts['read']>>;
function deferred<T>(){let resolve:(value:T)=>void=()=>{throw new Error('Deferred promise not initialized');};const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
function page(deleted=false):Page{return {imports:[{source:{workspaceId:ID,sourceId:ID,kind:'selected_note',revision:deleted?2:1,contentHash:deleted?null:'a'.repeat(64),locator:deleted?null:'selected_excerpt',speaker:null,occurredAt:deleted?null:'2026-09-20T14:00:00.000Z',observedAt:'2026-10-09T00:00:00.000Z',completeness:deleted?'unavailable':'selected_excerpt',availability:deleted?'deleted':'available',excerpt:deleted?null:'Private imported passage'},metadata:{revision:deleted?2:1,subtype:'pasted_text',label:deleted?null:'Private import label',participants:deleted?null:[{label:'Private participant',endpoint:'private@example.test',provenance:'user_supplied'}],attachments:deleted?null:[{name:'Private attachment.txt',url:null}],direction:deleted?null:'draft',directionVerified:false,attribution:deleted?null:'asserted',dateProvenance:deleted?null:'user_supplied'}}],nextAfterId:deleted?null:ID};}
function ports(read:SelectedImportPorts['read']):SelectedImportPorts{return {read,preview:async()=>({previewHash:'a'.repeat(64),parserVersion:'selected-v1',participants:[],occurredAt:null,dateProvenance:'unknown',direction:'draft',directionVerified:false,attribution:'unknown',candidates:[],warnings:[]}),commit:async()=>({sourceId:ID,sourceRevision:1,metadataRevision:1}),correct:async()=>{},remove:async()=>{},restore:async()=>{},recapture:async()=>{},readFile:async()=>({text:'',label:''})};}
const endpoints:EndpointPorts={list:async()=>({claims:[],nextAfterId:null}),match:async()=>({outcome:'no_supported_match',reason:'no_supported_evidence',personId:null,firmId:null,candidates:[]})};
it('keeps a sibling-deleted source and its metadata erased when older import pagination finishes',async()=>{
 const user=userEvent.setup();let deleted=false;const pending=deferred<Page>();
 let pagingStarted=false;const imports=ports(async input=>{if(input.afterId!==undefined){pagingStarted=true;return pending.promise;}return page(deleted);});
 const firmPorts:FirmAddressPorts={firms:async()=>[{firmId:ID,name:'Example Firm'}],read:async()=>({sources:page(deleted).imports.map(item=>item.source),nextAfterSourceId:null}),add:async()=>{},remove:async input=>{expect(input).toEqual({firmId:ID,sourceId:ID,expectedRevision:1});deleted=true;},restore:async()=>{},recapture:async()=>{}};
 render(<FirmAddresses enabled ports={firmPorts} imports={imports} endpoints={endpoints}/>);
 await screen.findByRole('option',{name:'Example Firm'});await user.selectOptions(screen.getByLabelText('Shared-address firm'),ID);await screen.findByText('Private import label');
 await user.click(screen.getByRole('button',{name:'More imported conversations'}));expect(pagingStarted).toBe(true);await user.click(screen.getByRole('button',{name:'Delete copied firm note'}));await screen.findByText('Deleted imported conversation');await act(async()=>{});
 await act(async()=>{pending.resolve(page());});
 expect(screen.queryByText('Private imported passage')).toBeNull();expect(screen.queryByText('Private import label')).toBeNull();expect(screen.queryByText('Private participant (user_supplied)')).toBeNull();expect(screen.queryByText(/Private attachment/)).toBeNull();
});
it('vetoes a pending page after the parent supplies a newer deleted source version',async()=>{
 const user=userEvent.setup();let deleted=false;const pending=deferred<Page>();const imports=ports(async input=>input.afterId===undefined?page(deleted):pending.promise);
 const view=render(<SelectedImports enabled personId={ID} ports={imports} sourceVersion="one"/>);await screen.findByText('Private import label');await user.click(screen.getByRole('button',{name:'More imported conversations'}));deleted=true;
 view.rerender(<SelectedImports enabled personId={ID} ports={imports} sourceVersion="two"/>);await screen.findByText('Deleted imported conversation');await act(async()=>{pending.resolve(page());});
 expect(screen.queryByText('Private imported passage')).toBeNull();
});
it('vetoes an older correction refresh after a newer sourceVersion deletion clears imported evidence and drafts',async()=>{
 const user=userEvent.setup();const pending=deferred<Page>();let reads=0;let refreshStarted=false;
 const imports=ports(async()=>{reads++;if(reads===1)return page();if(reads===2){refreshStarted=true;return pending.promise;}return page(true);});
 imports.correct=async input=>{expect(input.sourceId).toBe(ID);expect(input.expectedSourceRevision).toBe(1);expect(input.expectedMetadataRevision).toBe(1);};
 const view=render(<SelectedImports enabled personId={ID} ports={imports} sourceVersion="one"/>);await screen.findByText('Private import label');
 await user.click(screen.getByRole('button',{name:'Correct imported conversation'}));await user.click(screen.getByRole('button',{name:'Preview selected conversation'}));await screen.findByRole('region',{name:'Import preview'});await user.click(screen.getByRole('button',{name:'Save import correction'}));expect(refreshStarted).toBe(true);
 view.rerender(<SelectedImports enabled personId={ID} ports={imports} sourceVersion="two"/>);await screen.findByText('Deleted imported conversation');await act(async()=>{pending.resolve(page());});
 expect(screen.queryByText('Private imported passage')).toBeNull();expect(screen.queryByText('Private import label')).toBeNull();expect(screen.queryByText('Private participant (user_supplied)')).toBeNull();expect(screen.queryByText(/Private attachment/)).toBeNull();
 expect(screen.getByRole<HTMLTextAreaElement>('textbox',{name:'Selected conversation text'}).value).toBe('');expect(screen.getByRole<HTMLInputElement>('textbox',{name:'Import label'}).value).toBe('Selected conversation');
});
