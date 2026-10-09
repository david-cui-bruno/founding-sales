import { useCallback, useLayoutEffect, useRef, useState, type JSX } from 'react';
import type { z } from 'zod';
import type { selectedAttachmentFileSchema, selectedAttachmentPreviewSchema, selectedAttachmentCommitPayloadSchema, selectedAttachmentCommitResultSchema, selectedAttachmentReselectPayloadSchema, selectedAttachmentAnalyzePayloadSchema, selectedAttachmentAnalyzeResultSchema, selectedAttachmentPageSchema } from '@fss/contracts';
import { Button } from '../ui/button.tsx';
type FileInput=z.infer<typeof selectedAttachmentFileSchema>;
type Preview=z.infer<typeof selectedAttachmentPreviewSchema>;
type Page=z.infer<typeof selectedAttachmentPageSchema>;
export interface SelectedAttachmentPorts {
 readFile(file:File):Promise<FileInput>;
 preview(file:FileInput):Promise<Preview>;
 commit(input:z.infer<typeof selectedAttachmentCommitPayloadSchema>):Promise<z.infer<typeof selectedAttachmentCommitResultSchema>>;
 reselect(input:z.infer<typeof selectedAttachmentReselectPayloadSchema>):Promise<z.infer<typeof selectedAttachmentCommitResultSchema>>;
 analyze(input:z.infer<typeof selectedAttachmentAnalyzePayloadSchema>):Promise<z.infer<typeof selectedAttachmentAnalyzeResultSchema>>;
 read(input:{sourceId:string}):Promise<Page>;
}
export function SelectedAttachments({ports,personId,firmId,enabled,privacyKey,sourceVersion,sources,onChange}:{ports:SelectedAttachmentPorts;personId?:string|undefined;firmId?:string|undefined;enabled:boolean;privacyKey?:string|undefined;sourceVersion?:string|undefined;sources:readonly {sourceId:string;label:string}[];onChange?:()=>Promise<void>}):JSX.Element {
 const epoch=useRef(0);
 const invalidate=useCallback(()=>++epoch.current,[]);
 const [file,setFile]=useState<FileInput|null>(null);
 const [preview,setPreview]=useState<Preview|null>(null);
 const [page,setPage]=useState<Page|null>(null);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const [analysis,setAnalysis]=useState('');
 const [participants,setParticipants]=useState('');
 const [date,setDate]=useState('');
 const [importKey,setImportKey]=useState(()=>crypto.randomUUID());
 useLayoutEffect(()=>{
  invalidate();setFile(null);setPreview(null);setPage(null);setAnalysis('');setError('');setBusy(false);setParticipants('');setDate('');
  return ()=>{invalidate();};
 },[ports,personId,firmId,enabled,privacyKey,sourceVersion,invalidate]);
 const run=async(work:(ticket:number)=>Promise<void>)=>{
  const ticket=++epoch.current;setBusy(true);setError('');
  try{await work(ticket);}catch{if(ticket===epoch.current){setFile(null);setPreview(null);setPage(null);setAnalysis('');setParticipants('');setDate('');setError('File evidence is unavailable. Check the original selection, current source versions and access.');}}
  finally{if(ticket===epoch.current)setBusy(false);}
 };
 const read=async(sourceId:string,ticket:number)=>{const value=await ports.read({sourceId});if(value.source.sourceId!==sourceId)throw new Error('source_changed');if(ticket===epoch.current){setPage(value);setAnalysis('');}};
 const metadata=()=>({participants:participants.split('\n').map(value=>value.trim()).filter(Boolean).map(value=>{const [label,endpoint]=value.split('|');return {label:label?.trim()??'',endpoint:endpoint?.trim()||null,provenance:'user_supplied' as const};}),occurredAt:date?new Date(date).toISOString():null});
 const current=page?.file.state==='selected'&&page.source.availability==='available'&&page.file.sourceRevision===page.source.revision&&page.source.contentHash!==null&&page.file.fileHash!==null;
 const uncertain=page?.processingHealth?.unknownAcceptance===true||page?.processing.state==='unknown_acceptance';
 const validScope=Boolean(personId)!==Boolean(firmId);
 return <section aria-label="Selected original files">
  <h4>Original file evidence</h4>
  <p>Choose one complete original UTF-8 txt, md, csv, srt or vtt file. Maximum 80,000 bytes and 20,000 characters. Other attachments are not read. Imported direction remains unverified.</p>
  {enabled? <>
  {error?<p role="alert">{error}</p>:null}
  <label>Original evidence file<input aria-label="Original evidence file" type="file" accept=".txt,.md,.csv,.srt,.vtt" disabled={busy||!validScope} onChange={event=>{const selected=event.target.files?.[0];event.target.value='';if(selected)void run(async ticket=>{setFile(null);setPreview(null);setAnalysis('');const value=await ports.readFile(selected);if(ticket!==epoch.current)return;const proof=await ports.preview(value);if(ticket!==epoch.current)return;setFile(proof.state==='supported'?value:null);setPreview(proof);});}}/></label>
  <label>File participant labels<textarea aria-label="File participant labels" value={participants} placeholder="Optional label | endpoint, one per line" onChange={event=>setParticipants(event.target.value)}/></label>
  <label>File original date<input aria-label="File original date" type="datetime-local" value={date} onChange={event=>setDate(event.target.value)}/></label>
  <p>Dates and participants are user supplied; leave them blank when unknown.</p>
  {preview?.state==='supported'?<p>Complete original selection · {preview.byteLength} bytes · {preview.format}</p>:preview?<p role="alert">File unavailable: {preview.reason}. Nothing imported or analyzed.</p>:null}
  <Button disabled={busy||!validScope||file===null||preview?.state!=='supported'} onClick={()=>void run(async ticket=>{
   if(file===null||preview?.state!=='supported')return;
   const selected=page;
   const result=selected===null?await ports.commit({file,personId:personId??null,firmId:firmId??null,importKey,previewHash:preview.previewHash,...metadata()}):await ports.reselect({file,sourceId:selected.source.sourceId,expectedSourceRevision:selected.source.revision,expectedMetadataRevision:selected.file.metadataRevision,previewHash:preview.previewHash,...metadata()});
   if(ticket!==epoch.current)return;setFile(null);setPreview(null);setImportKey(crypto.randomUUID());await onChange?.();if(ticket!==epoch.current)return;await read(result.sourceId,ticket);
  })}>{page===null?'Import original file':'Reselect original file'}</Button>
  {sources.map(source=><Button key={source.sourceId} disabled={busy} onClick={()=>void run(async ticket=>{setFile(null);setPreview(null);setPage(null);await read(source.sourceId,ticket);})}>Inspect file {source.label}</Button>)}
  {page?<section aria-label="Current file evidence">
   <p>{page.file.fileName??'Original file unavailable'} · {page.file.state} · source revision {page.source.revision}</p>
   <p>{page.source.occurredAt===null?'Original date unknown':`Original evidence date: ${page.source.occurredAt}`}</p>
   <p>{page.processing.state==='not_requested'?'Analysis not requested':`Processing: ${page.processing.state}`}</p>
   {analysis?<p>{analysis}</p>:null}
   {page.processingHealth?<p>Processing coverage: {page.processingHealth.generations.length} generations{page.processingHealth.truncated?' · more history exists':''}{page.processingHealth.unknownAcceptance?' · provider acceptance unknown; cost accounting retained':''}</p>:null}
   {uncertain?<p>Analysis is on hold while provider acceptance is unknown.</p>:null}
   <Button disabled={busy||!current||uncertain} onClick={()=>void run(async ticket=>{if(!current||uncertain||page.file.fileHash===null)return;setPage(null);const result=await ports.analyze({source:{workspaceId:page.source.workspaceId,sourceId:page.source.sourceId,kind:'selected_note',revision:page.source.revision,contentHash:page.source.contentHash,locator:null},fileHash:page.file.fileHash});if(ticket!==epoch.current)return;await read(page.source.sourceId,ticket);if(ticket===epoch.current)setAnalysis(`${result.state}${result.reason?` · ${result.reason}`:''}`);})}>Analyze selected file</Button>
   {file===null&&preview===null&&current&&page.processing.state==='complete'&&page.processing.sourceRevision===page.source.revision?page.processing.claims.filter(claim=>claim.source.workspaceId===page.source.workspaceId&&claim.source.kind==='selected_note'&&claim.source.availability==='available'&&claim.source.sourceId===page.source.sourceId&&claim.source.revision===page.source.revision&&claim.source.contentHash===page.source.contentHash).map(claim=><article key={claim.claimId}><p>{claim.kind}: {claim.interpretation} · {claim.status}</p><blockquote>{claim.quote}</blockquote><p>Selected original file · revision {claim.source.revision} · {claim.source.locator??'Passage location unavailable'} · {claim.source.speaker??'Speaker unknown'} · {claim.context.review==='required'?'Context review required':'Current context'}</p></article>):null}
   {!current?<p>Fresh selection of the original file is required before analysis. Earlier quotations are unavailable.</p>:null}
  </section>:null}
  </>:<p>File evidence unavailable.</p>}
 </section>;
}
