import {describe, expect, it} from 'vitest';
import {parseTrecOrganization, trecProvenance, verifyTrecFirms, TREC_INSTRUCTIONS_URL, TREC_LIMITS, type TrecExistingFirm} from '../../sourcing/trecVerification.ts';
const now = new Date('2026-10-19T17:00:00Z');
const metadata = {sourceUrl:TREC_INSTRUCTIONS_URL,retrievedAt:'2026-10-19T16:00:00Z',sourceUpdatedAt:'2026-10-11T00:00:00Z'};
const firm: TrecExistingFirm = {firmId:'firm-1',legalName:'Synthetic Brokerage LLC',mailingCountyCode:'101'};
function row(overrides: Record<number,string> = {}) {
  const f = Array<string>(33).fill('');
  Object.assign(f,{0:'BLLC',1:'001234',2:'Synthetic Brokerage LLC',4:'20',5:'20200101',6:'20271031',18:'101',25:'999',31:'1',...overrides});
  return f.join('\t');
}
const record = () => parseTrecOrganization(row())!;
describe('official legacy TREC corporate verification', () => {
  it('projects only organizational license fields, excluding contact/officer/sponsor data', () => {
    const parsed = parseTrecOrganization(row({10:'5551234567',11:'private@example.test',12:'PRIVATE ADDRESS',28:'PRIVATE OFFICER',32:'PRIVATE KEY'}));
    expect(parsed).toEqual({licenseType:'BLLC',licenseNumber:'001234',legalName:firm.legalName,status:'20',originalLicenseDate:'2020-01-01',expirationDate:'2027-10-31',mailingCountyCode:'101',physicalCountyCode:null,agencyIdentifier:'1'});
    expect(JSON.stringify(parsed)).not.toMatch(/PRIVATE|private|5551234567/u);
    for (const type of ['SALE','BRK','6','REB','ILLC']) expect(parseTrecOrganization(row({0:type,2:'PRIVATE PERSON'}))).toBeNull();
    expect(parseTrecOrganization(row({0:'BCRP'}))?.licenseType).toBe('BCRP');
  });
  it('rejects malformed/oversized corporate rows without echoing source', () => {
    for (const raw of ['BLLC', 'BLLC\tPRIVATE', row({4:'99'}), row({4:'toString'}), row({5:'20260230'}),row({18:'bad'}),row({1:'abc'}),row({31:'x'}),row({2:'x'.repeat(65)}),row()+'\textra', 'BLLC\t'+'x'.repeat(TREC_LIMITS.lineBytes)]) expect(() => parseTrecOrganization(raw)).toThrow();
    try {parseTrecOrganization('BLLC\tPRIVATE');} catch (error) {expect(String(error)).not.toContain('PRIVATE');}
  });
  it('requires exact legal identity and known county even with exact license', () => {
    expect(verifyTrecFirms([record()],[firm],metadata,now).results[0]?.outcome).toBe('matched');
    for (const other of [{...firm,legalName:'Synthetic Brokerage'},{...firm,mailingCountyCode:'102'},{...firm,license:{type:'BLLC' as const,number:'1234'}}]) expect(verifyTrecFirms([record()],[other],metadata,now).results[0]?.outcome).toBe('unmatched');
    expect(() => verifyTrecFirms([record()],[{...firm,mailingCountyCode:'999'}],metadata,now)).toThrow('invalid_trec_firm');
    expect(verifyTrecFirms([record()],[{...firm,legalName:' synthetic brokerage llc '}],metadata,now).results[0]?.outcome).toBe('matched');
  });
  it('keeps ambiguity explicit including duplicate/conflicting source rows', () => {
    const second = {...record(),licenseNumber:'009999'};
    expect(verifyTrecFirms([record(),second],[firm],metadata,now).results[0]).toMatchObject({outcome:'ambiguous',matchingRecords:2,record:null});
    expect(verifyTrecFirms([record(),record()],[firm],metadata,now).results[0]?.outcome).toBe('ambiguous');
    expect(verifyTrecFirms([record(),second],[{...firm,license:{type:'BLLC',number:'001234'}}],metadata,now).results[0]?.outcome).toBe('matched');
    expect(verifyTrecFirms([record(),{...record(),legalName:'Conflicting LLC',mailingCountyCode:'102'}],[firm],metadata,now).results[0]?.outcome).toBe('ambiguous');
    expect(() => verifyTrecFirms([],[firm,firm],metadata,now)).toThrow('invalid_trec_firm');
  });
  it.each(['20','21','30','31','45','47','56','57','80'])('preserves status %s and never grants authority', status => {
    const output = verifyTrecFirms([parseTrecOrganization(row({4:status,6:'20200101'}))!],[firm],metadata,now);
    expect(output.results[0]).toMatchObject({outcome:'matched',record:{status},licenseExpiredAtEvaluation:true});
    expect(output).toMatchObject({qualificationAuthority:false,admissionAuthority:false,outreachAuthority:false});
    expect(output.provenance).toMatchObject({freshness:'stale',sourceUpdatedAt:metadata.sourceUpdatedAt,liveVerified:false});
    expect(JSON.stringify(output)).not.toMatch(/"active"|"phone"|"email"|"website"|"contact"/u);
  });
  it('does not treat retrieval date as source freshness', () => {
    expect(trecProvenance({...metadata,sourceUpdatedAt:null},now).freshness).toBe('unknown');
    expect(trecProvenance({...metadata,sourceUpdatedAt:metadata.retrievedAt},now).freshness).toBe('recent_source_snapshot');
    for (const change of [{retrievedAt:'2026-10-20T00:00:00Z'},{sourceUpdatedAt:'2026-10-19T17:00:00Z'},{sourceUpdatedAt:'2026-02-30T00:00:00Z'},{sourceUrl:'https://example.test'}]) expect(() => trecProvenance({...metadata,...change},now)).toThrow();
  });
  it('bounds firms and sanitizes extra runtime record fields', () => {
    expect(() => verifyTrecFirms([],Array.from({length:TREC_LIMITS.firms+1},()=>firm),metadata,now)).toThrow('trec_input_too_large');
    const dirty = {...record(),email:'PRIVATE',sponsor:'PRIVATE'};
    expect(JSON.stringify(verifyTrecFirms([dirty],[firm],metadata,now))).not.toContain('PRIVATE');
  });
});
