import {useRef,useState} from 'react';
import type {z} from 'zod';
import type {askReadSchema,askResponseSchema} from '@fss/contracts';
export type AskRead=z.infer<typeof askReadSchema>;
export type AskResponse=z.infer<typeof askResponseSchema>;
export interface AskPorts {read(input:AskRead):Promise<AskResponse>}
export function Ask({ports,privacyKey,enabled}:{ports:AskPorts;privacyKey:string;enabled:boolean}){
 const [query,setQuery]=useState('');const [kind,setKind]=useState<'people'|'firms'>('people');
 const [result,setResult]=useState<AskResponse|null>(null);const [error,setError]=useState<string|null>(null);
 const epoch=useRef(0);const current=useRef(privacyKey);if(current.current!==privacyKey){current.current=privacyKey;epoch.current++;}
 async function find(){const captured=++epoch.current;setResult(null);setError(null);try{const next=await ports.read({operation:'records',query,kind,limit:20});if(captured===epoch.current)setResult(next);}catch{if(captured===epoch.current)setError('Records are unavailable. Try reading again.');}}
 return <section aria-label="Ask" className="space-y-4 p-6"><h1 className="text-xl font-semibold">Ask</h1><p>Retrieve records and original evidence. Conversation coverage may be incomplete.</p>
  <label>Find a person or firm<input aria-label="Find a person or firm" value={query} onChange={event=>{epoch.current++;setResult(null);setQuery(event.target.value);}}/></label>
  <label>Record kind<select value={kind} onChange={event=>{epoch.current++;setResult(null);setKind(event.target.value==='firms'?'firms':'people');}}><option value="people">People</option><option value="firms">Firms</option></select></label>
  <button disabled={!enabled||!query.trim()} onClick={()=>{void find();}}>Find records</button>
  {error!==null&&<p role="alert">{error}</p>}
  {result?.operation==='records'&&<div>{result.selection==='ambiguous'&&<p>Choose a record; these names are not unique.</p>}{!result.scanComplete&&<p>More records remain. Identity selection is unresolved.</p>}{result.records.map(record=><div key={record.recordId}><button>Select {record.name}</button><span>{record.kind==='person'?'Person':'Firm'}</span></div>)}</div>}
 </section>;
}
