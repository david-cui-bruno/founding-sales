import type { z } from 'zod';
import type { selectedAttachmentFileSchema } from '@fss/contracts';
export async function readSelectedOriginalFile(file:Pick<File,'name'|'size'|'arrayBuffer'>):Promise<z.infer<typeof selectedAttachmentFileSchema>> {
 if(!/\.(?:txt|md|csv|srt|vtt)$/iu.test(file.name)) throw new Error('unsupported_format');
 if(file.size>80000) throw new Error('selection_limit_exceeded');
 const bytes=new Uint8Array(await file.arrayBuffer());
 if(bytes.byteLength!==file.size) throw new Error('incomplete_selection');
 if(bytes.byteLength>80000) throw new Error('selection_limit_exceeded');
 const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
 if(!text.trim()) throw new Error('empty_selection');
 if(text.length>20000) throw new Error('selection_limit_exceeded');
 if(text.includes('\0')) throw new Error('unreadable_text');
 let binary='';for(const byte of bytes) binary+=String.fromCharCode(byte);
 return {fileName:file.name,declaredByteLength:bytes.byteLength,bytesBase64:btoa(binary),completeness:'complete'};
}
import { operations } from '../app/bridges.ts';
import type { SelectedAttachmentPorts } from './SelectedAttachments.tsx';
function api(){const value=operations();if(value===undefined)throw new Error('unavailable');return value;}
export const selectedAttachmentPorts:SelectedAttachmentPorts={
 readFile:readSelectedOriginalFile,
 preview:async input=>await api().read('crm.selectedAttachmentPreview',input),
 commit:async input=>await api().command('crm.selectedAttachmentCommit',input),
 reselect:async input=>await api().command('crm.selectedAttachmentReselect',input),
 analyze:async input=>await api().command('crm.selectedAttachmentAnalyze',input),
 read:async input=>await api().read('crm.selectedAttachmentRead',input),
};
