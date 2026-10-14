import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {describe,it,expect} from 'vitest';
import {declaredGrants} from '../../tools/upgrade/grants.ts';

describe('booking migration routine grants',()=>{
  it('keeps explicit function signatures out of the table grant replay',()=>{
    const directory=mkdtempSync(join(process.env['JCODE_SCRATCH_DIR']??tmpdir(),'booking-grants-'));
    try{
      writeFileSync(join(directory,'0001_booking_receipt.sql'),`
CREATE TABLE booking_receipts(id uuid);
GRANT SELECT,INSERT,UPDATE ON booking_receipts TO app_runtime;
CREATE FUNCTION redact_booking_provenance(target_workspace uuid,target_source uuid,redaction_reason text) RETURNS void LANGUAGE sql AS $$ SELECT NULL::void $$;
REVOKE ALL ON FUNCTION redact_booking_provenance(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION redact_booking_provenance(uuid,uuid,text) TO app_runtime;
`);
      const runtime=declaredGrants(directory,1).get('app_runtime');
      expect([...runtime?.keys()??[]]).toEqual(['booking_receipts']);
      expect([...runtime?.get('booking_receipts')??[]].sort()).toEqual(['INSERT','SELECT','UPDATE']);
    }finally{rmSync(directory,{recursive:true,force:true});}
  });
});
