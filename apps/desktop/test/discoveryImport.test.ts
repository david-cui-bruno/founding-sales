import {describe,expect,it,vi} from 'vitest';
import {DISCOVERY_FILE_BYTES,prepareDiscoveryBatch} from '../src/renderer/sourcing/discoveryImportBatch.ts';
import {createDiscoveryImportController,type DiscoverySavePort} from '../src/renderer/sourcing/discoveryImportController.ts';
import {reconcileDiscovery,DISCOVERY_RECONCILE_REQUESTS,type DiscoveryListPort} from '../src/renderer/sourcing/discoveryImportReconcile.ts';
import {rawDiscoveryEntry,discoveryReceipt,listedDiscovery,emptyDiscoveryList} from './support/discoveryImportFixtures.ts';
const batchOf=async(count=2)=>prepareDiscoveryBatch(JSON.stringify(Array.from({length:count},(_,index)=>rawDiscoveryEntry(`record-${index}`))));
const empty=vi.fn<DiscoveryListPort>().mockResolvedValue(emptyDiscoveryList);
const accepted={result:discoveryReceipt,reason:null};

describe('bounded unchanged raw file preflight',()=>{
  it('preserves exact unknowns, raw references, provenance and deterministic IDs',async()=>{
    const raw=rawDiscoveryEntry();raw.row.website='http://EXAMPLE.test/raw?b=2&a=1';
    const text=JSON.stringify([raw]),a=await prepareDiscoveryBatch(text),b=await prepareDiscoveryBatch(text);
    expect(a).toEqual(b);expect(a.commands[0]).toEqual({...raw,commandId:expect.stringMatching(/^discovery126:[a-f0-9]{64}$/u)});
    expect(Object.isFrozen(a.commands[0]?.row)).toBe(true);
    const changed=await prepareDiscoveryBatch(JSON.stringify([{...raw,row:{...raw.row,firmName:'Different observation'}}]));
    expect(changed.commands[0]?.commandId).not.toBe(a.commands[0]?.commandId);
    expect((await prepareDiscoveryBatch(JSON.stringify([raw],null,2))).digest).not.toBe(a.digest);
  });
  it.each([
    ['not array','{}'],['empty','[]'],['malformed','['],['too many',JSON.stringify(Array.from({length:2001},(_,i)=>rawDiscoveryEntry(String(i))))],
    ['extra authority',JSON.stringify([{...rawDiscoveryEntry(),workspaceId:'other'}])],
    ['attach',JSON.stringify([{...rawDiscoveryEntry(),attachTo:{candidateId:discoveryReceipt.id,expectedRevision:1}}])],
    ['last invalid',JSON.stringify([rawDiscoveryEntry(),{...rawDiscoveryEntry('second'),origins:[]}])],
    ['duplicate exact',JSON.stringify([rawDiscoveryEntry(),rawDiscoveryEntry()])],
    ['duplicate drift',JSON.stringify([rawDiscoveryEntry(),{...rawDiscoveryEntry(),row:{...rawDiscoveryEntry().row,firmName:'Drift'}}])],
    ['claimed fit',JSON.stringify([{...rawDiscoveryEntry(),row:{...rawDiscoveryEntry().row,residentialFit:'supported'}}])],
    ['origin metadata drift',JSON.stringify([{...rawDiscoveryEntry(),origins:rawDiscoveryEntry().origins.map(origin=>({...origin,source:{...origin.source,sourceUrl:'https://example.test/drift'}}))}])],
    ['raw html field',JSON.stringify([{...rawDiscoveryEntry(),html:'<p>body</p>'}])],
    ['byte ceiling',' '.repeat(DISCOVERY_FILE_BYTES+1)],
  ])('rejects %s before any command can be prepared',async(_label,text)=>{await expect(prepareDiscoveryBatch(text)).rejects.toThrow();});
  it('allows only existing contract firmName trim, binds IDs to original file, and preserves every other value',async()=>{
    const raw=rawDiscoveryEntry();raw.row.firmName='  Synthetic Property Management \n';
    const text=JSON.stringify([raw]),a=await prepareDiscoveryBatch(text),b=await prepareDiscoveryBatch(text);
    expect(a).toEqual(b);expect(a.contractNameTrims).toBe(1);
    const {commandId,...wire}=a.commands[0]!;
    expect(commandId).toBe(b.commands[0]?.commandId);
    expect(wire).toEqual({...raw,row:{...raw.row,firmName:raw.row.firmName.trim()}});
    const trimmed=await prepareDiscoveryBatch(JSON.stringify([{...raw,row:{...raw.row,firmName:raw.row.firmName.trim()}}]));
    expect(a.digest).not.toBe(trimmed.digest);expect(commandId).not.toBe(trimmed.commands[0]?.commandId);
  });
  it('checks generation before and after asynchronous hash derivation',async()=>{
    let current=true;const pending=prepareDiscoveryBatch(JSON.stringify([rawDiscoveryEntry()]),()=>current);current=false;
    await expect(pending).rejects.toThrow('session_changed');
  });
  it('refuses existing schema URL trimming rather than normalize any source reference',async()=>{
    const raw=rawDiscoveryEntry();raw.row.source.sourceUrl=' https://example.test/source ';
    await expect(prepareDiscoveryBatch(JSON.stringify([raw]))).rejects.toThrow('unexpected_transformation');
  });
});

describe('sequential save and explicit replay handling',()=>{
  it('pauses ambiguous saves without retries and resumes the same exact object and ID once',async()=>{
    const batch=await batchOf(),save=vi.fn<DiscoverySavePort>().mockResolvedValueOnce({result:null,reason:'offline'}).mockResolvedValue(accepted);
    const controller=createDiscoveryImportController(batch,{save,list:empty},()=>true,()=>{});
    await controller.run();expect(save).toHaveBeenCalledTimes(1);expect(controller.state()).toMatchObject({phase:'paused',acknowledged:0,uncertain:true});
    await controller.run();expect(save).toHaveBeenCalledTimes(3);expect(save.mock.calls[0]?.[0]).toBe(save.mock.calls[1]?.[0]);
    expect(controller.state()).toMatchObject({acknowledged:2,receiptNewlyPersisted:2,presence:{present:0,missing:2}});
    // Historical replay receipt newlyPersisted does not become current presence.
    await controller.run();expect(save).toHaveBeenCalledTimes(3);
  });
  it.each(['source_conflict','source_identity_conflict','candidate_identity_conflict','candidate_changed','candidate_format_not_supported','command_id_conflict','not_authorized','upgrade_required'])('stops all remaining writes on %s, including after reconciliation',async reason=>{
    const save=vi.fn<DiscoverySavePort>().mockResolvedValue({result:null,reason}),controller=createDiscoveryImportController(await batchOf(),{save,list:empty},()=>true,()=>{});
    await controller.run();await controller.run();await controller.reconcile();await controller.run();expect(save).toHaveBeenCalledTimes(1);expect(controller.state().refusal).toBe(true);
  });
  it('does not overlap saves, ignores an old-owner answer and does not publish late state',async()=>{
    let resolve!:(value:typeof accepted)=>void,current=true;
    const save=vi.fn<DiscoverySavePort>(()=>new Promise(done=>{resolve=done;})),changed=vi.fn();
    const controller=createDiscoveryImportController(await batchOf(),{save,list:empty},()=>current,changed);
    const running=controller.run();await controller.run();expect(save).toHaveBeenCalledTimes(1);
    current=false;const before=changed.mock.calls.length;resolve(accepted);await running;
    expect(save).toHaveBeenCalledTimes(1);expect(changed).toHaveBeenCalledTimes(before);expect(controller.state().acknowledged).toBe(0);
  });
  it('cancel stops remaining requests and blocks a new controller until the dispatched save settles',async()=>{
    let resolve!:(value:typeof accepted)=>void;const save=vi.fn<DiscoverySavePort>(()=>new Promise(done=>{resolve=done;}));
    const batch=await batchOf(),one=createDiscoveryImportController(batch,{save,list:empty},()=>true,()=>{});
    const running=one.run();one.cancel();
    const secondSave=vi.fn<DiscoverySavePort>().mockResolvedValue(accepted),two=createDiscoveryImportController(batch,{save:secondSave,list:empty},()=>true,()=>{});
    await two.run();expect(secondSave).not.toHaveBeenCalled();expect(two.state().reason).toBe('another_save_pending');
    resolve(accepted);await running;expect(one.state().acknowledged).toBe(0);expect(save).toHaveBeenCalledTimes(1);
    await two.run();expect(secondSave).toHaveBeenCalledTimes(2);
  });
});

describe('read-only exact presence, not historical receipts',()=>{
  it('finds exact observations in all statuses without reviving dismissed, detects erased and drifted origins',async()=>{
    const entries=Array.from({length:4},(_,i)=>rawDiscoveryEntry(String(i))),batch=await prepareDiscoveryBatch(JSON.stringify(entries));
    const rows=entries.slice(0,3).map((entry,i)=>listedDiscovery(entry,i+1,(['needs_review','kept','dismissed'] as const)[i]!));
    const list=vi.fn<DiscoveryListPort>(async({status})=>({view:{candidates:rows.filter(row=>row.status===status),hasMore:false},reason:null}));
    expect(await reconcileDiscovery(batch,list,()=>true)).toMatchObject({present:3,missing:1,conflicts:0,dismissed:1,requests:6});
    rows[0]!.origins=rows[0]!.origins.map(origin=>({...origin,licenses:['Changed']}));
    expect(await reconcileDiscovery(batch,list,()=>true)).toMatchObject({present:2,missing:1,conflicts:1});
  });
  it('stops on changing, duplicate, refused and unbounded lists rather than declaring completion',async()=>{
    const batch=await batchOf(1),row=listedDiscovery(rawDiscoveryEntry('record-0'));
    let reads=0;const changing:DiscoveryListPort=async({status})=>({view:{candidates:status==='needs_review'&&++reads===1?[row]:[],hasMore:false},reason:null});
    await expect(reconcileDiscovery(batch,changing,()=>true)).rejects.toThrow('reconciliation_changing');
    await expect(reconcileDiscovery(batch,async()=>({view:null,reason:'forbidden'}),()=>true)).rejects.toThrow('reconciliation_unavailable');
    await expect(reconcileDiscovery(batch,async()=>({view:{candidates:[row],hasMore:true},reason:null}),()=>true)).rejects.toThrow('reconciliation_changing');
    let page=0;const forever=vi.fn<DiscoveryListPort>(async({status})=>({view:{candidates:Array.from({length:50},()=>{const index=++page;return listedDiscovery(rawDiscoveryEntry(String(index)),index,status);}),hasMore:true},reason:null}));
    await expect(reconcileDiscovery(batch,forever,()=>true)).rejects.toThrow('reconciliation_limit');expect(forever).toHaveBeenCalledTimes(DISCOVERY_RECONCILE_REQUESTS);
  });
  it('cancels read pagination after the awaited step when generation changes',async()=>{
    let current=true;const list=vi.fn<DiscoveryListPort>(async()=>{current=false;return emptyDiscoveryList;});
    await expect(reconcileDiscovery(await batchOf(),list,()=>current)).rejects.toThrow('session_changed');expect(list).toHaveBeenCalledTimes(1);
  });
  it('parses, sequentially acknowledges and reconciles all 1600 SYNTHETIC rows through public port shapes, not DB/prod',async()=>{
    const entries=Array.from({length:1600},(_,i)=>rawDiscoveryEntry(String(i))),batch=await prepareDiscoveryBatch(JSON.stringify(entries));
    const save=vi.fn<DiscoverySavePort>().mockResolvedValue(accepted);
    const list=vi.fn<DiscoveryListPort>(async({status,offset})=>({view:{candidates:status==='needs_review'?entries.slice(offset,offset+50).map((entry,i)=>listedDiscovery(entry,offset+i+1)):[],hasMore:status==='needs_review'&&offset+50<entries.length},reason:null}));
    const controller=createDiscoveryImportController(batch,{save,list},()=>true,()=>{});await controller.run();
    expect(save).toHaveBeenCalledTimes(1600);expect(list).toHaveBeenCalledTimes(68);
    expect(controller.state()).toMatchObject({acknowledged:1600,presence:{present:1600,missing:0,conflicts:0,scans:2}});
  });
});
