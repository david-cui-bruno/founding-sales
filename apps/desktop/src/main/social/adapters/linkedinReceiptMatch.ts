import {z} from 'zod';
const receipt=z.string().regex(/^urn:li:share:\d+$/),hash=z.string().regex(/^[a-f0-9]{64}$/u),mediaId=z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const expectedSchema=z.strictObject({receiptId:receipt,accountExternalId:z.string().min(1).max(300),text:z.string().max(10000),publishAt:z.string().datetime({offset:true}),fingerprint:hash,images:z.array(z.strictObject({sha256:hash,altText:z.string().max(1000)})).max(20)});
const evidenceSchema=z.strictObject({receiptId:receipt,accountExternalId:z.string().min(1).max(300),text:z.string().max(10000),publishAt:z.string().datetime({offset:true}),detailComplete:z.boolean(),images:z.array(z.strictObject({platformId:mediaId,altText:z.string().max(1000)})).max(20)});
const bindingSchema=z.strictObject({receiptId:receipt,fingerprint:hash,images:z.array(z.strictObject({sha256:hash,platformId:mediaId})).max(20)});
/** Must come from the original verified submission, never manufacture from later lookup. */
export type LinkedInMediaBinding=z.infer<typeof bindingSchema>;
/** A matching list excerpt/thumbnail is insufficient. Unknown or missing proof returns false. */
export function matchLinkedInReceipt(expectedInput:unknown,evidenceInput:unknown,bindingInput:unknown):boolean{
 const e=expectedSchema.safeParse(expectedInput),o=evidenceSchema.safeParse(evidenceInput);if(!e.success||!o.success)return false;
 const expected=e.data,observed=o.data;
 if(!observed.detailComplete||observed.receiptId!==expected.receiptId||observed.accountExternalId!==expected.accountExternalId||observed.text!==expected.text||Date.parse(observed.publishAt)!==Date.parse(expected.publishAt)||observed.images.length!==expected.images.length)return false;
 if(expected.images.length===0)return true;
 const b=bindingSchema.safeParse(bindingInput);if(!b.success)return false;const binding=b.data;
 if(binding.receiptId!==expected.receiptId||binding.fingerprint!==expected.fingerprint||binding.images.length!==expected.images.length)return false;
 if(new Set(binding.images.map(image=>image.platformId)).size!==binding.images.length)return false;
 return expected.images.every((image,index)=>binding.images[index]!.sha256===image.sha256&&binding.images[index]!.platformId===observed.images[index]!.platformId&&observed.images[index]!.altText===image.altText);
}
/** Normalize only the media identifier observed in native LinkedIn image URLs. */
export function linkedInMediaId(value:string):string|null{
 try{const url=new URL(value);if(url.protocol!=='https:'||url.hostname!=='media.licdn.com'||url.username||url.password||url.port)return null;
 const match=url.pathname.match(/^\/dms\/image\/v2\/([A-Za-z0-9_-]{1,200})\//u);return match?.[1]??null;
 }catch{return null;}
}
