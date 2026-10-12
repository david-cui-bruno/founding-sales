// Reference membership and prose shape only; never semantic entailment.
export function inspectProse({text,stopReason,hasToolCalls,originals,exacts}){
 const references=[...text.matchAll(/\[(\w+\d+|\d+)\]/gu)].map(match=>match[1]);
 const valid=stopReason==='end_turn'&&!hasToolCalls&&text.length>0&&text.length<=12000&&(text.trim()==='Insufficient evidence.'||references.length>0&&references.every(ref=>originals.has(ref)||exacts.has(ref)));
 return {valid,references};
}
