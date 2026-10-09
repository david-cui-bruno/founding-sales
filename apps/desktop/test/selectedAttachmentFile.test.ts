import { expect, it } from 'vitest';
import { readSelectedOriginalFile } from '../src/renderer/firms/selectedAttachmentPorts.ts';
it('preserves original UTF-8 bytes including BOM and refuses incomplete or unsupported file selections before any import',async()=>{
 const bytes=new Uint8Array([239,187,191,65]);
 expect(await readSelectedOriginalFile({name:'original.md',size:4,arrayBuffer:async()=>bytes.buffer})).toEqual({fileName:'original.md',declaredByteLength:4,bytesBase64:'77u/QQ==',completeness:'complete'});
 await expect(readSelectedOriginalFile({name:'partial.txt',size:5,arrayBuffer:async()=>bytes.buffer})).rejects.toThrow('incomplete_selection');
 await expect(readSelectedOriginalFile({name:'lease.pdf',size:4,arrayBuffer:async()=>bytes.buffer})).rejects.toThrow('unsupported_format');
 await expect(readSelectedOriginalFile({name:'long.txt',size:80001,arrayBuffer:async()=>{throw new Error('must not read');}})).rejects.toThrow('selection_limit_exceeded');
 await expect(readSelectedOriginalFile({name:'chars.txt',size:20001,arrayBuffer:async()=>new TextEncoder().encode('x'.repeat(20001)).buffer})).rejects.toThrow('selection_limit_exceeded');
 await expect(readSelectedOriginalFile({name:'binary.txt',size:1,arrayBuffer:async()=>new Uint8Array([255]).buffer})).rejects.toThrow();
});
