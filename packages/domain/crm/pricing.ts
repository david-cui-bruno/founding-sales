import {crmInputTokenPriceMicrosSchema,crmTokenPriceMicrosSchema} from '@fss/contracts';

const SCALE=1000000n,CENT=10000n*SCALE;
function scaled(rate:number|string):bigint{
 const [whole,fraction='']=String(rate).split('.');
 return BigInt(whole!)*SCALE+BigInt(fraction.padEnd(6,'0'));
}
/** Exact vendor usage, rounded upward only once at the cent boundary. Null means
 * unrepresentable: reservations fail closed and dispatch recovery conserves money. */
export function crmTokenCostCents(inputTokens:number,outputTokens:number,inputRate:unknown,outputRate:unknown):number|null{
 if(!Number.isSafeInteger(inputTokens)||inputTokens<0||!Number.isSafeInteger(outputTokens)||outputTokens<0)return null;
 const input=crmInputTokenPriceMicrosSchema.safeParse(inputRate),output=crmTokenPriceMicrosSchema.safeParse(outputRate);
 if(!input.success||!output.success)return null;
 const micros=BigInt(inputTokens)*scaled(input.data)+BigInt(outputTokens)*scaled(output.data);
 const cents=(micros+CENT-1n)/CENT;
 return cents<=2147483647n?Number(cents):null;
}
