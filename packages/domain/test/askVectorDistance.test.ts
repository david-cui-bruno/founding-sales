import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {createTestDatabase} from '../db/testing/testDatabase.ts';
import {rankCanonicalVectors} from '../crm/askVectorDistance.ts';

it.runIf(process.env['FSS_TEST_REQUIRE_PGVECTOR']==='1')('uses installed pgvector exact cosine distance without changing durable array storage',async()=>{
 const database=await createTestDatabase();try{
 const available=(await database.session.query("SELECT 1 FROM pg_available_extensions WHERE name='vector'")).rows.length===1;
 expect(available).toBe(true);
 await database.session.query('CREATE EXTENSION vector');
 await database.session.query('CREATE TEMP TABLE crm_ask_canonical_windows AS SELECT * FROM public.crm_ask_canonical_windows WITH NO DATA');
 const workspaceId=randomUUID(),ownerUserId=randomUUID(),sourceId=randomUUID(),fingerprint='a'.repeat(64),sourceHash='b'.repeat(64);
 for(const [locator,vector] of [['aligned',[1,0]],['orthogonal',[0,1]],['opposite',[-1,0]]] as const)await database.session.query("INSERT INTO crm_ask_canonical_windows(workspace_id,owner_user_id,source_kind,source_id,source_revision,source_hash,locator,state,config_fingerprint,dimensions,embedding) VALUES($1,$2,'selected_note',$3,1,$4,$5,'current',$6,2,$7)",[workspaceId,ownerUserId,sourceId,sourceHash,locator,fingerprint,vector]);
 // A nearer row outside the owner must never join the private candidates.
 await database.session.query("INSERT INTO crm_ask_canonical_windows SELECT * FROM crm_ask_canonical_windows WHERE locator='aligned'");
 await database.session.query("UPDATE crm_ask_canonical_windows SET owner_user_id=$1 WHERE ctid=(SELECT ctid FROM crm_ask_canonical_windows ORDER BY ctid DESC LIMIT 1)",[randomUUID()]);
 const result=await rankCanonicalVectors(database.session,{workspaceId,ownerUserId,configFingerprint:fingerprint,queryVector:[1,0],eligibleSources:[{kind:'selected_note',sourceId,revision:1,contentHash:sourceHash}]});
 expect(result.backend).toBe('pgvector_exact');
 expect(result.rows.map(row=>[row['locator'],Number(row['score'])])).toEqual([['aligned',1],['orthogonal',0],['opposite',-1]]);
 }finally{await database.drop();}
});

it('retains exact array ranking when extension is absent and refuses unexpected database failures',async()=>{
 const database=await createTestDatabase();try{
 const input={workspaceId:randomUUID(),ownerUserId:randomUUID(),configFingerprint:'a'.repeat(64),queryVector:[1,0],eligibleSources:[]};
 expect(await rankCanonicalVectors(database.session,input)).toMatchObject({backend:'array_exact',rows:[]});
 await database.session.query('CREATE TEMP TABLE crm_ask_canonical_windows(unrelated integer)');
 await expect(rankCanonicalVectors(database.session,input)).rejects.toMatchObject({code:'42703'});
 }finally{await database.drop();}
});

it.runIf(process.env['FSS_TEST_REQUIRE_PGVECTOR']==='1')('supports an extension outside public and preserves float64 historical ranges',async()=>{
 const database=await createTestDatabase();try{
 await database.session.query('CREATE SCHEMA vector_private');
 await database.session.query('CREATE EXTENSION vector WITH SCHEMA vector_private');
 await database.session.query('CREATE TEMP TABLE crm_ask_canonical_windows AS SELECT * FROM public.crm_ask_canonical_windows WITH NO DATA');
 const workspaceId=randomUUID(),ownerUserId=randomUUID(),sourceId=randomUUID(),fingerprint='a'.repeat(64),sourceHash='b'.repeat(64);
 await database.session.query("INSERT INTO crm_ask_canonical_windows(workspace_id,owner_user_id,source_kind,source_id,source_revision,source_hash,locator,state,config_fingerprint,dimensions,embedding) VALUES($1,$2,'selected_note',$3,1,$4,'wide','current',$5,2,$6)",[workspaceId,ownerUserId,sourceId,sourceHash,fingerprint,[1e100,0]]);
 const input={workspaceId,ownerUserId,configFingerprint:fingerprint,queryVector:[1,0],eligibleSources:[{kind:'selected_note' as const,sourceId,revision:1,contentHash:sourceHash}]};
 const native=await rankCanonicalVectors(database.session,input);expect(native.backend).toBe('pgvector_exact');expect(Number(native.rows[0]!['score'])).toBe(1);
 const wide=await rankCanonicalVectors(database.session,{...input,queryVector:[1e100,0]});expect(wide.backend).toBe('array_exact');expect(Number(wide.rows[0]!['score'])).toBe(1);
 }finally{await database.drop();}
});
