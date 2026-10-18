/** Bounds only this Basic discovery operation, not unrelated consumers, invoices or tax.
 * One reserved Basic credit costs at most $0.008 under the approved pricing assumption.
 * Ten daily dispatches allow at most 310/month. The 375 stop also covers prior usage.
 */
export const DISCOVERY_DAILY_CREDIT_LIMIT=10;
export const DISCOVERY_MONTHLY_CREDIT_LIMIT=375;
export function discoveryQuotaRemaining(daily:number,monthly:number,providerMonthLimit=DISCOVERY_MONTHLY_CREDIT_LIMIT):{daily:number;monthly:number} {
 if(![daily,monthly,providerMonthLimit].every(n=>Number.isSafeInteger(n)&&n>=0))return {daily:0,monthly:0};
 return {daily:Math.max(0,DISCOVERY_DAILY_CREDIT_LIMIT-daily),monthly:Math.max(0,Math.min(DISCOVERY_MONTHLY_CREDIT_LIMIT,providerMonthLimit)-monthly)};
}
