import {z} from 'zod';

/** Microdollars per token, at most six decimal places. Legacy whole
 * rates remain numbers; decimal strings never pass through binary arithmetic. */
export const crmTokenPriceMicrosSchema=z.union([
 z.number().int().min(0).max(1000000),
 z.string().regex(/^(?:0|[1-9][0-9]{0,6})(?:\.[0-9]{1,6})?$/u),
]).transform(value=>{
 if(typeof value==='number')return value;
 const canonical=value.includes('.')?value.replace(/0+$/u,'').replace(/\.$/u,''):value;
 return canonical.includes('.')?canonical:Number(canonical);
}).refine(value=>typeof value==='number'?value<=1000000:BigInt(value.split('.')[0]!)<1000000n,{message:'Rate exceeds one million microdollars per token'});
export const crmInputTokenPriceMicrosSchema=crmTokenPriceMicrosSchema.refine(value=>value!==0,{message:'Input rate must be positive'});
export type CrmTokenPriceMicros=z.infer<typeof crmTokenPriceMicrosSchema>;
