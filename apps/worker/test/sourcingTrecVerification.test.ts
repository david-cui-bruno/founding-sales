import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {mkdtemp, writeFile, rm, open} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {loadTrecBrokerSource, verifyTrecBrokerFile} from '../src/sourcing/trecBrokerSource.ts';
import {trecVerifyCommand} from '../src/tools/fss/trecVerify.ts';
import {TREC_INSTRUCTIONS_URL, TREC_LIMITS} from '@fss/domain/sourcing/trecVerification.ts';
let dir: string, path: string;
const now = new Date('2026-10-19T17:00:00Z');
const metadata = {sourceUrl:TREC_INSTRUCTIONS_URL,retrievedAt:'2026-10-19T16:00:00Z',sourceUpdatedAt:'2026-10-11T00:00:00Z'};
const firms = [{firmId:'firm-1',legalName:'Synthetic Brokerage LLC',mailingCountyCode:'101'}];
function row(type = 'BLLC', status = '21') {
  const fields = Array<string>(33).fill('');
  Object.assign(fields,{0:type,1:'001234',2:type === 'BRK' ? 'PRIVATE PERSON' : firms[0]!.legalName,4:status,5:'20200101',6:'20271031',10:'5551234567',11:'PRIVATE EMAIL',18:'101',25:'999',28:'PRIVATE OFFICER',31:'1'});
  return fields.join('\t');
}
beforeEach(async () => {dir = await mkdtemp(join(tmpdir(),'trec-synthetic-')); path = join(dir,'trecfile.txt');});
afterEach(async () => {await rm(dir,{recursive:true,force:true});});
const options = () => ({'--file':path,'--source-url':metadata.sourceUrl,'--retrieved-at':metadata.retrievedAt,'--source-updated-at':metadata.sourceUpdatedAt,'--official-legacy-file':'true','--firms-json':JSON.stringify(firms)});
describe('bounded local TREC loader and tool', () => {
  it('reads official-shaped CRLF input, drops people and excluded columns, preserves inactive', async () => {
    await writeFile(path,row('BRK')+'\r\n'+row()+'\r\n');
    const result = await verifyTrecBrokerFile({path,metadata,firms,now});
    expect(result.results[0]).toMatchObject({outcome:'matched',record:{status:'21'},statusDescription:'Current and Inactive'});
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|5551234567/u);
    expect(result.provenance).toMatchObject({sourceUpdatedAt:metadata.sourceUpdatedAt,freshness:'stale',liveVerified:false});
  });
  it('supports final row without newline and LF boundaries across chunks', async () => {
    await writeFile(path,(row('BRK')+'\n').repeat(1000)+row());
    expect(await loadTrecBrokerSource(path,metadata,now)).toHaveLength(1);
  });
  it('rejects malformed rows and oversized lines/files before returning partial success', async () => {
    await writeFile(path,row()+'\nBLLC\tPRIVATE');
    await expect(loadTrecBrokerSource(path,metadata,now)).rejects.toThrow('invalid_trec_columns');
    await writeFile(path,'BRK\t'+'x'.repeat(TREC_LIMITS.lineBytes+2));
    await expect(loadTrecBrokerSource(path,metadata,now)).rejects.toThrow('trec_line_too_large');
    const file = await open(path,'w'); await file.truncate(TREC_LIMITS.bytes+1); await file.close();
    await expect(loadTrecBrokerSource(path,metadata,now)).rejects.toThrow('invalid_trec_file');
  });
  it('bounds rows and organization retention', async () => {
    await writeFile(path,'\n'.repeat(TREC_LIMITS.rows+1));
    await expect(loadTrecBrokerSource(path,metadata,now)).rejects.toThrow('trec_too_many_rows');
    await writeFile(path,(row()+'\n').repeat(TREC_LIMITS.organizations+1));
    await expect(loadTrecBrokerSource(path,metadata,now)).rejects.toThrow('trec_too_many_organizations');
  });
  it('tool succeeds without a session, mutation or network and returns no contact data', async () => {
    await writeFile(path,row());
    const result = await trecVerifyCommand({options:options()});
    expect(result).toMatchObject({ok:true,value:{purpose:'existing_firm_license_corroboration_only',results:[{outcome:'matched'}]}});
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|5551234567/u);
  });
  it('requires explicit origin attestation, bounded firms and refuses extra contact fields', async () => {
    await writeFile(path,row());
    expect(await trecVerifyCommand({options:{...options(),'--official-legacy-file':'false'}})).toMatchObject({ok:false,reason:'invalid_options'});
    expect(await trecVerifyCommand({options:{...options(),'--firms-json':JSON.stringify([{...firms[0],email:'PRIVATE'}])}})).toMatchObject({ok:false,reason:'trec_verification_unavailable'});
    expect(await trecVerifyCommand({options:{...options(),'--firms-json':'x'.repeat(256*1024+1)}})).toMatchObject({ok:false,reason:'invalid_options'});
  });
  it('never returns raw parse errors, data or paths', async () => {
    await writeFile(path,'BLLC\tPRIVATE');
    const result = await trecVerifyCommand({options:options()});
    expect(result).toMatchObject({ok:false,reason:'trec_verification_unavailable'});
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(JSON.stringify(result)).not.toContain(path);
  });
});
